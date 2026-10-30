//! Two-stage uploads for saved SSH machines: the browser blob is first
//! received into a private staging file under the bridge's own upload root,
//! then copied with `scp -s` (SFTP mode) into the remote user's fixed
//! `~/.local/share/herdr-web/uploads` directory and committed there with an
//! atomic no-clobber rename performed by a transient POSIX helper script.
//!
//! Security shape:
//! * The remote destination directory is fixed by this module; the browser
//!   only ever supplies a machine id, which the caller resolves against the
//!   operator's saved enabled endpoints before we are called.
//! * Filenames travel to the remote helper as base64 constants inside the
//!   script text, never as interpolated shell words. The script itself is
//!   sent over ssh stdin (`sh -s`), so nothing is installed remotely.
//! * The remote commit uses `ln` (atomic, fails if the target exists) for
//!   no-clobber creation and `mv -f` (atomic rename) only for the explicit
//!   overwrite path, after refusing directories and symlinks.
//! * Local staging lives in a 0700 directory as 0600 files with generated
//!   names, and is deleted on success and on every failure path.
//! * Remote stderr is logged server-side only and never returned to the
//!   browser.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI8, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::future::BoxFuture;
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::machines::{is_valid_ssh_target, SavedEndpoint};

/// Fixed remote destination, relative to the remote user's $HOME.
pub const REMOTE_UPLOAD_DIR_RELATIVE: &str = ".local/share/herdr-web/uploads";
/// Staging subdirectory inside the bridge's local upload root.
pub const STAGING_DIR_NAME: &str = ".herdr-web-upload-staging";

/// Upper bound on the resolved remote directory string we accept.
const MAX_REMOTE_DIR_BYTES: usize = 3800;
/// A remote file name is a single path segment: bounded well below NAME_MAX.
const MAX_NAME_BYTES: usize = 255;
const SSH_CONNECT_TIMEOUT_SECONDS: u32 = 8;
/// ssh calls that only resolve/commit run well under the probe ceiling.
const SSH_CONTROL_TIMEOUT: Duration = Duration::from_secs(25);
/// scp transfer budget for a <=25 MB body over a slow uplink.
const SCP_TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);
const STDIN_WRITE_TIMEOUT: Duration = Duration::from_secs(15);
/// Remote commit exit codes from the helper script.
const COMMIT_EXIT_CONFLICT: i32 = 27;
const COMMIT_EXIT_NAME_EXHAUSTED: i32 = 26;
const COMMIT_EXIT_NON_FILE_TARGET: i32 = 23;
const COMMIT_EXIT_MOVE_FAILED: i32 = 24;
/// Bound concurrent remote uploads (and thus ssh/scp children) process-wide.
static REMOTE_UPLOAD_PERMITS: Semaphore = Semaphore::const_new(2);
static STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

/// One remote process invocation. `program` is `ssh` or `scp`; argv entries
/// are passed verbatim (no local shell), and `stdin` carries transient helper
/// scripts when set.
pub struct RemoteProc {
    pub program: String,
    pub args: Vec<String>,
    pub stdin: Option<Vec<u8>>,
}

/// Completed remote process result. `stderr` is for server-side logging only.
pub struct RemoteProcOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl RemoteProcOutput {
    fn success(&self) -> bool {
        self.code == Some(0)
    }
}

pub type RemoteExecFn =
    Arc<dyn Fn(RemoteProc) -> BoxFuture<'static, Result<RemoteProcOutput, String>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteUploadError {
    BadRequest(String),
    Conflict {
        name: String,
        path: String,
    },
    NameExhausted(String),
    /// Generic, client-safe failure. Details are logged server-side only.
    Failure(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineUploadOutcome {
    /// Final file name inside the remote uploads directory (may carry a
    /// conflict suffix when auto-rename committed `name-1.ext`).
    pub name: String,
    /// Absolute path on the remote machine.
    pub remote_path: String,
}

// ---------------------------------------------------------------------------
// Capability probing
// ---------------------------------------------------------------------------

static SCP_PROBE: OnceLock<bool> = OnceLock::new();
/// Test override: 1 = forced true, 0 = forced false, -1 = use the real probe.
static SCP_TEST_OVERRIDE: AtomicI8 = AtomicI8::new(-1);

/// Whether this bridge can perform SCP uploads at all: an `scp` binary must
/// be reachable in PATH. Advertisement of the uploads capability for SSH
/// machines depends on this.
pub fn scp_available() -> bool {
    let override_value = SCP_TEST_OVERRIDE.load(Ordering::Acquire);
    if override_value >= 0 {
        return override_value == 1;
    }
    *SCP_PROBE.get_or_init(find_in_path_scp)
}

/// Test-only control over [`scp_available`]; `None` restores real probing.
/// Compiled only for test builds so no dead override helper ships in
/// production binaries.
#[cfg(test)]
pub fn set_test_scp_available(value: Option<bool>) {
    let encoded = match value {
        Some(true) => 1,
        Some(false) => 0,
        None => -1,
    };
    SCP_TEST_OVERRIDE.store(encoded, Ordering::Release);
}

fn find_in_path_scp() -> bool {
    find_in_path("scp")
}

fn find_in_path(program: &str) -> bool {
    let path = match std::env::var_os("PATH") {
        Some(path) => path,
        None => return false,
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(program);
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            true
        }
    })
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Stage `body` locally, copy it with `scp -s` to the remote machine's fixed
/// uploads directory, and commit it there atomically. The caller has already
/// sanitized the requested name and enforced the size limit; the machine has
/// been resolved from the operator's saved enabled endpoints.
pub async fn upload_to_machine(
    endpoint: &SavedEndpoint,
    upload_root: &Path,
    requested_name: &str,
    body: &[u8],
    overwrite: bool,
    rename_conflicts: bool,
    exec: &RemoteExecFn,
) -> Result<MachineUploadOutcome, RemoteUploadError> {
    if !is_valid_ssh_target(&endpoint.target) {
        return Err(RemoteUploadError::BadRequest(
            "invalid machine target".to_string(),
        ));
    }
    validate_remote_name(requested_name)?;
    // Bounded transfer concurrency: at most two ssh/scp upload pipelines run
    // at once process-wide, so a burst of uploads cannot fork an unbounded
    // child population.
    let _permit = REMOTE_UPLOAD_PERMITS
        .acquire()
        .await
        .map_err(|_| RemoteUploadError::Failure("remote upload limiter closed".to_string()))?;

    // Stage 1: private local staging file under the bridge's upload root.
    let staging_path = write_local_staging(upload_root, body)
        .await
        .map_err(|err| {
            warn!(error = %err, "remote upload staging failed");
            RemoteUploadError::Failure("remote upload failed".to_string())
        })?;
    let result = transfer_and_commit(
        endpoint,
        &staging_path,
        requested_name,
        overwrite,
        rename_conflicts,
        exec,
    )
    .await;
    // The local staging file is transient: remove it on success AND failure.
    let _ = tokio::fs::remove_file(&staging_path).await;
    result
}

async fn transfer_and_commit(
    endpoint: &SavedEndpoint,
    staging_path: &Path,
    requested_name: &str,
    overwrite: bool,
    rename_conflicts: bool,
    exec: &RemoteExecFn,
) -> Result<MachineUploadOutcome, RemoteUploadError> {
    // Resolve the remote user's home-derived uploads directory; never assume
    // a hardcoded path for generic machines.
    let dir_proc = RemoteProc {
        program: "ssh".to_string(),
        args: ssh_control_args(endpoint),
        stdin: Some(build_dir_script().into_bytes()),
    };
    let output = run_remote(exec, dir_proc, "resolve remote upload dir").await?;
    if !output.success() {
        warn!(
            code = ?output.code,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "remote upload dir resolution failed"
        );
        return Err(RemoteUploadError::Failure(
            "remote upload failed".to_string(),
        ));
    }
    let dir = match validate_remote_dir_output(&output.stdout) {
        Ok(dir) => dir,
        Err(error) => {
            warn!(
                output = %String::from_utf8_lossy(&output.stdout),
                "remote upload dir resolution returned unusable output"
            );
            return Err(error);
        }
    };

    // Stage 2a: copy the staging file with scp in SFTP mode to a generated
    // remote staging name (never the final name: scp would silently
    // overwrite an existing file).
    let stage_name = generated_remote_stage_name();
    let remote_stage_path = format!("{dir}/{stage_name}");
    let scp_proc = RemoteProc {
        program: "scp".to_string(),
        args: scp_stage_args(endpoint, staging_path, &remote_stage_path),
        stdin: None,
    };
    let output = run_remote(exec, scp_proc, "scp staging transfer").await?;
    if !output.success() {
        warn!(
            code = ?output.code,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "remote upload scp transfer failed"
        );
        cleanup_remote_staging(endpoint, &dir, &stage_name, exec).await;
        return Err(RemoteUploadError::Failure(
            "remote upload failed".to_string(),
        ));
    }

    // Stage 2b: atomic commit under the final name.
    let script = build_commit_script(
        &dir,
        &stage_name,
        requested_name,
        overwrite,
        rename_conflicts,
    );
    let commit_proc = RemoteProc {
        program: "ssh".to_string(),
        args: ssh_control_args(endpoint),
        stdin: Some(script.into_bytes()),
    };
    let output = run_remote(exec, commit_proc, "remote upload commit").await?;
    match output.code {
        Some(0) => {
            let Some((name, path)) = parse_commit_output(&output.stdout, &dir) else {
                warn!(
                    stdout = %String::from_utf8_lossy(&output.stdout),
                    "remote upload commit returned unusable output"
                );
                cleanup_remote_staging(endpoint, &dir, &stage_name, exec).await;
                return Err(RemoteUploadError::Failure(
                    "remote upload failed".to_string(),
                ));
            };
            info!(
                machine = %endpoint.id,
                name = %name,
                "remote upload committed"
            );
            Ok(MachineUploadOutcome {
                name,
                remote_path: path,
            })
        }
        Some(COMMIT_EXIT_CONFLICT) => Err(RemoteUploadError::Conflict {
            name: requested_name.to_string(),
            path: format!("{dir}/{requested_name}"),
        }),
        Some(COMMIT_EXIT_NAME_EXHAUSTED) => {
            Err(RemoteUploadError::NameExhausted(requested_name.to_string()))
        }
        Some(COMMIT_EXIT_NON_FILE_TARGET) => Err(RemoteUploadError::BadRequest(
            "refusing to overwrite non-file path".to_string(),
        )),
        Some(COMMIT_EXIT_MOVE_FAILED) => {
            // mv failure: staging may still exist remotely.
            warn!(
                stderr = %String::from_utf8_lossy(&output.stderr),
                "remote upload commit move failed"
            );
            cleanup_remote_staging(endpoint, &dir, &stage_name, exec).await;
            Err(RemoteUploadError::Failure(
                "remote upload failed".to_string(),
            ))
        }
        code => {
            warn!(
                code = ?code,
                stderr = %String::from_utf8_lossy(&output.stderr),
                "remote upload commit failed"
            );
            cleanup_remote_staging(endpoint, &dir, &stage_name, exec).await;
            Err(RemoteUploadError::Failure(
                "remote upload failed".to_string(),
            ))
        }
    }
}

async fn run_remote(
    exec: &RemoteExecFn,
    proc: RemoteProc,
    what: &'static str,
) -> Result<RemoteProcOutput, RemoteUploadError> {
    exec(proc).await.map_err(|err| {
        // Transport/timeout failures: details (which may include remote
        // paths) stay in the server log; the client sees a generic error.
        warn!(task = what, error = %err, "remote upload process failed");
        RemoteUploadError::Failure("remote upload failed".to_string())
    })
}

/// Best-effort removal of a leftover remote staging file after a failed
/// commit or transfer. Never fails the surrounding request.
async fn cleanup_remote_staging(
    endpoint: &SavedEndpoint,
    dir: &str,
    stage_name: &str,
    exec: &RemoteExecFn,
) {
    let proc = RemoteProc {
        program: "ssh".to_string(),
        args: ssh_control_args(endpoint),
        stdin: Some(build_cleanup_script(dir, stage_name).into_bytes()),
    };
    if let Ok(output) = exec(proc).await {
        if !output.success() {
            warn!(
                code = ?output.code,
                "remote upload staging cleanup failed"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

fn staging_root(upload_root: &Path) -> PathBuf {
    upload_root.join(STAGING_DIR_NAME)
}

/// Write `body` to a generated 0600 staging file inside a 0700 staging
/// directory under the bridge's upload root. Blocking filesystem work runs
/// on the blocking pool, never on the async workers. Permissions are only
/// tightened on directories the bridge itself creates.
async fn write_local_staging(upload_root: &Path, body: &[u8]) -> io::Result<PathBuf> {
    let staging_dir = staging_root(upload_root);
    let body = body.to_vec();
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let pre_existing = staging_dir.is_dir();
        std::fs::create_dir_all(&staging_dir)?;
        #[cfg(unix)]
        if !pre_existing {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging_dir, std::fs::Permissions::from_mode(0o700))?;
        }
        loop {
            let path = staging_dir.join(generated_stage_file_name());
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(mut file) => {
                    use std::io::Write;
                    file.write_all(&body)?;
                    return Ok(path);
                }
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
    })
    .await
    .map_err(|err| io::Error::other(format!("staging task failed: {err}")))?
}

fn generated_stage_file_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = STAGING_COUNTER.fetch_add(1, Ordering::AcqRel);
    let fingerprint = crate::store_util::stable_hash(&format!(
        "{}\u{1}{}\u{1}{}",
        std::process::id(),
        nanos,
        counter
    ));
    format!(".stage-{fingerprint:016x}")
}

fn generated_remote_stage_name() -> String {
    format!(".incoming-{}", &generated_stage_file_name()[".".len()..])
}

// ---------------------------------------------------------------------------
// Remote helpers
// ---------------------------------------------------------------------------

/// ssh argv for running `sh -s` with a helper script on stdin.
fn ssh_control_args(endpoint: &SavedEndpoint) -> Vec<String> {
    vec![
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
        // Fast keepalives so a silently dead peer cannot hold an upload
        // permit; they back up, not replace, the process-group kill.
        "-o".to_string(),
        "ServerAliveInterval=5".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=2".to_string(),
        endpoint.target.clone(),
        "sh".to_string(),
        "-s".to_string(),
    ]
}

/// scp argv copying `local_path` to the absolute `remote_path` on the
/// endpoint, in SFTP mode (`-s`) so no legacy scp remote shell is used.
fn scp_stage_args(endpoint: &SavedEndpoint, local_path: &Path, remote_path: &str) -> Vec<String> {
    vec![
        "-s".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
        // Mirror the ssh keepalives so a wedged transfer dies on its own
        // well before the overall timeout reaps the process group.
        "-o".to_string(),
        "ServerAliveInterval=5".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=2".to_string(),
        local_path.to_string_lossy().into_owned(),
        format!("{}:{}", endpoint.target, remote_path),
    ]
}

/// Fixed helper that resolves and prepares the remote uploads directory,
/// printing its canonical absolute path. Contains no caller data. `pwd -P`
/// canonicalizes symlinked homes so scp targets a real absolute path.
fn build_dir_script() -> String {
    format!(
        r#"set -eu
# herdr-web-remote-uploads-dir
# Resolve the remote user's uploads directory from $HOME: no hardcoded
# path assumption for generic machines.
[ -n "${{HOME-}}" ] || exit 20
case $HOME in /*) ;; *) exit 20 ;; esac
umask 077
d=${{HOME%/}}/{REMOTE_UPLOAD_DIR_RELATIVE}
if [ -L "$d" ]; then
  # The final directory is app-owned; a symlink there is never tightened,
  # followed, or created through.
  exit 22
fi
if [ ! -d "$d" ]; then
  mkdir -p -- "$d" || exit 21
fi
[ -d "$d" ] || exit 22
# Enforce 0700 even when the directory pre-existed with looser modes;
# failing to protect it fails the upload instead of proceeding open.
chmod 700 -- "$d" || exit 23
cd "$d" || exit 21
printf '%s\n' "$(pwd -P)"
"#
    )
}

/// Helper that commits the staged remote file under its final name using
/// atomic no-clobber hardlink creation. All caller-controlled values (the
/// directory, staging name, final name) are embedded as base64 constants so
/// no filename can ever become remote shell syntax.
fn build_commit_script(
    dir: &str,
    stage_name: &str,
    final_name: &str,
    overwrite: bool,
    rename_conflicts: bool,
) -> String {
    let dir_b64 = base64_encode(dir.as_bytes());
    let stage_b64 = base64_encode(stage_name.as_bytes());
    let final_b64 = base64_encode(final_name.as_bytes());
    format!(
        r#"set -eu
# herdr-web-remote-uploads-commit
# All caller-controlled values arrive as base64 constants; nothing here is
# ever interpolated from remote shell input.
dir=$(printf %s '{dir_b64}' | base64 -d) || exit 20
stage=$(printf %s '{stage_b64}' | base64 -d) || exit 20
final=$(printf %s '{final_b64}' | base64 -d) || exit 20
ow={ow}
rn={rn}
cd "$dir" || exit 21
[ -f "$stage" ] || exit 22
# Harden the staged file before anything can link to it: a stage we cannot
# protect must never reach a final name. Failing here is safe — the caller
# cleans up the remote staging name.
chmod 600 -- "$stage" || exit 25
committed=0
# ln/mv onto a directory target would place the file *inside* it; refuse
# directories before every link/move and verify the final path afterwards.
if [ ! -d "$final" ] && ln -- "$stage" "$final" 2>/dev/null && [ -f "$final" ]; then
  committed=1
elif [ "$ow" = 1 ]; then
  # Explicit overwrite only: refuse directories and symlinks, then replace
  # atomically with rename(2) via mv -f (same directory).
  if [ -d "$final" ] || [ -L "$final" ]; then
    rm -f -- "$stage" 2>/dev/null || true
    exit 23
  fi
  mv -f -- "$stage" "$final" || exit 24
  [ -f "$final" ] || exit 24
  committed=1
elif [ "$rn" = 1 ]; then
  # Mirror the local rename scheme: stem + "-" + n + extension.
  base=$final
  ext=
  case $final in
    ?*.?*)
      b=${{final%.*}}
      e=${{final##*.}}
      if [ -n "$b" ] && [ -n "$e" ]; then base=$b; ext=.$e; fi
      ;;
  esac
  n=1
  while [ "$n" -le 1000 ]; do
    try=$base-$n$ext
    if [ ! -d "$try" ] && ln -- "$stage" "$try" 2>/dev/null && [ -f "$try" ]; then
      final=$try
      committed=1
      break
    fi
    n=$((n + 1))
  done
  if [ "$committed" = 0 ]; then
    rm -f -- "$stage" 2>/dev/null || true
    exit 26
  fi
else
  rm -f -- "$stage" 2>/dev/null || true
  exit 27
fi
# An ln-based commit leaves the staging name as a hardlink twin of the
# final file: remove the staging name now (mv commits already consumed it).
rm -f -- "$stage" 2>/dev/null || true
# The committed file must end up 0600; it already is via the staged file's
# mode, so a failure here means something replaced it underneath us — refuse
# to call the upload a success.
chmod 600 -- "$final" || exit 25
printf '%s\n' "$final"
printf '%s\n' "$dir/$final"
"#,
        ow = if overwrite { 1 } else { 0 },
        rn = if rename_conflicts { 1 } else { 0 },
    )
}

/// Best-effort leftover staging cleanup script (fixed shape, base64 data).
fn build_cleanup_script(dir: &str, stage_name: &str) -> String {
    format!(
        r#"set -u
# herdr-web-remote-uploads-cleanup
d=$(printf %s '{dir_b64}' | base64 -d) || exit 0
s=$(printf %s '{stage_b64}' | base64 -d) || exit 0
rm -f -- "$d/$s" 2>/dev/null || true
exit 0
"#,
        dir_b64 = base64_encode(dir.as_bytes()),
        stage_b64 = base64_encode(stage_name.as_bytes()),
    )
}

/// Validate a resolved remote directory as returned by [`build_dir_script`]:
/// absolute, single line, no control characters, bounded length.
fn validate_remote_dir_output(output: &[u8]) -> Result<String, RemoteUploadError> {
    let failure = || RemoteUploadError::Failure("remote upload failed".to_string());
    let text = std::str::from_utf8(output).map_err(|_| failure())?;
    let trimmed = text.trim_end_matches('\n');
    if trimmed.is_empty()
        || !trimmed.starts_with('/')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return Err(failure());
    }
    if trimmed.len() > MAX_REMOTE_DIR_BYTES {
        return Err(failure());
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err(failure());
    }
    Ok(trimmed.to_string())
}

/// Validate a final file name before it is used remotely. The web layer has
/// already sanitized it; this is the last line of defense.
fn validate_remote_name(name: &str) -> Result<(), RemoteUploadError> {
    let bad = || RemoteUploadError::BadRequest("invalid file name".to_string());
    if name.is_empty() || name == "." || name == ".." {
        return Err(bad());
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(bad());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(bad());
    }
    if name.chars().any(|ch| ch.is_control()) {
        return Err(bad());
    }
    Ok(())
}

/// Parse the commit helper's two-line reply: final name, then the absolute
/// final path, which must be exactly `dir`/`name`.
fn parse_commit_output(stdout: &[u8], dir: &str) -> Option<(String, String)> {
    let text = std::str::from_utf8(stdout).ok()?;
    let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
    if lines.len() != 2 {
        return None;
    }
    let name = lines[0];
    let path = lines[1];
    if validate_remote_name(name).is_err() {
        return None;
    }
    if path != format!("{dir}/{name}") {
        return None;
    }
    Some((name.to_string(), path.to_string()))
}

/// Standard-alphabet base64 (padded) encoder; avoids pulling in a crate for
/// one tiny primitive. Filenames are transported with this encoding.
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).map_or(0, |byte| u32::from(*byte));
        let b2 = chunk.get(2).map_or(0, |byte| u32::from(*byte));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18 & 0x3f) as usize] as char);
        out.push(ALPHABET[(triple >> 12 & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6 & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Real process executor
// ---------------------------------------------------------------------------

/// Production executor: spawns ssh/scp inside an owned process group with
/// `kill_on_drop`, pipes an optional stdin payload, enforces an overall
/// timeout, and guarantees the whole owned group is killed on timeout or
/// cancellation — `kill_on_drop` alone only reaches the direct child, not
/// the ssh grandchild underneath scp.
pub fn default_exec() -> RemoteExecFn {
    Arc::new(tokio_exec)
}

fn tokio_exec(proc: RemoteProc) -> BoxFuture<'static, Result<RemoteProcOutput, String>> {
    let overall_timeout = if proc.program == "scp" {
        SCP_TRANSFER_TIMEOUT
    } else {
        SSH_CONTROL_TIMEOUT
    };
    Box::pin(run_owned_process(proc, overall_timeout))
}

/// Kills the process group we created at spawn time when dropped without
/// [`GroupKillGuard::disarm`]. Covers both the timeout path (the early
/// return drops the guard) and caller-side cancellation (the future itself
/// is dropped mid-flight).
struct GroupKillGuard {
    pid: Option<u32>,
}

impl GroupKillGuard {
    fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }
    fn disarm(self) {
        // Consuming self without signalling disarms the guard; the process
        // completed on its own and nothing in its group needs a kill.
    }
}

impl Drop for GroupKillGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            kill_process_group(pid);
        }
    }
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // SIGKILL to -pid addresses only the group we spawned the child as
    // leader of; it can never collide with this process, other sessions,
    // or unrelated user processes. Racing a fully reaped group yields
    // ESRCH, which is harmless.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {}

async fn run_owned_process(
    proc: RemoteProc,
    overall_timeout: Duration,
) -> Result<RemoteProcOutput, String> {
    let mut command = tokio::process::Command::new(&proc.program);
    command
        .args(&proc.args)
        .stdin(if proc.stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: the child becomes its group leader, so timeout
        // and cancellation can tear down scp AND its ssh grandchild by
        // signalling one group id.
        command.as_std_mut().process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("spawn {}: {err}", proc.program))?;
    let group_guard = GroupKillGuard::new(child.id());
    if let Some(payload) = proc.stdin {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().expect("piped stdin present");
        let write = tokio::time::timeout(STDIN_WRITE_TIMEOUT, stdin.write_all(&payload)).await;
        let _ = stdin.shutdown().await;
        drop(stdin);
        if write.is_err() {
            // The guard's drop kills the whole owned group; kill_on_drop
            // additionally reaps the direct child.
            return Err("stdin write timed out".to_string());
        }
        // Inner write errors are tolerated: the child may have exited
        // early, and its captured exit status below is authoritative.
    }
    let output = tokio::time::timeout(overall_timeout, child.wait_with_output())
        .await
        .map_err(|_| "process timed out".to_string())?
        .map_err(|err| format!("wait: {err}"))?;
    group_guard.disarm();
    Ok(RemoteProcOutput {
        code: output.status.code(),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> SavedEndpoint {
        SavedEndpoint {
            id: "0123456789abcdef0123456789abcdef".to_string(),
            label: "farm".to_string(),
            target: "root@127.0.0.1".to_string(),
            session: "default".to_string(),
            enabled: true,
        }
    }

    struct TestEnv {
        upload_root: PathBuf,
        remote_root: PathBuf,
        calls: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl TestEnv {
        fn new() -> Self {
            let unique = format!(
                "herdr-web-remote-uploads-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let base = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(base.join("uploads")).unwrap();
            std::fs::create_dir_all(base.join("local")).unwrap();
            Self {
                upload_root: base.join("local"),
                remote_root: base.join("uploads"),
                calls: Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }

        fn staging_dir(&self) -> PathBuf {
            staging_root(&self.upload_root)
        }

        fn staging_files(&self) -> Vec<PathBuf> {
            let mut files: Vec<PathBuf> = std::fs::read_dir(self.staging_dir())
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok())
                        .map(|entry| entry.path())
                        .collect()
                })
                .unwrap_or_default();
            files.sort();
            files
        }

        fn remote_staging_leftovers(&self) -> Vec<String> {
            std::fs::read_dir(&self.remote_root)
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok())
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.starts_with(".incoming"))
                        .collect()
                })
                .unwrap_or_default()
        }

        fn cleanup(&self) {
            let _ = std::fs::remove_dir_all(self.upload_root.parent().unwrap());
        }
    }

    /// A faithful local stand-in for the remote side: `ssh` dir requests
    /// resolve to the local `remote` root, `scp` copies the staging file into
    /// it, and the real commit script actually runs under the local `sh`
    /// against that root — exercising the exact POSIX logic we ship.
    fn simulator_exec(env: &TestEnv) -> RemoteExecFn {
        let remote_root = env.remote_root.clone();
        let calls = Arc::clone(&env.calls);
        Arc::new(move |proc: RemoteProc| {
            let remote_root = remote_root.clone();
            let calls = Arc::clone(&calls);
            Box::pin(async move {
                calls.lock().unwrap().push(proc.program.clone());
                let stdin = proc.stdin.unwrap_or_default();
                if proc.program == "ssh" {
                    let script = String::from_utf8_lossy(&stdin).to_string();
                    if script.contains("herdr-web-remote-uploads-dir") {
                        std::fs::create_dir_all(&remote_root).map_err(|err| err.to_string())?;
                        return Ok(RemoteProcOutput {
                            code: Some(0),
                            stdout: format!("{}\n", remote_root.display()).into_bytes(),
                            stderr: Vec::new(),
                        });
                    }
                    use std::io::Write;
                    use std::process::{Command, Stdio};
                    let mut child = Command::new("sh")
                        .arg("-s")
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped())
                        .spawn()
                        .map_err(|err| err.to_string())?;
                    let mut pipe = child.stdin.take().unwrap();
                    pipe.write_all(&stdin).map_err(|err| err.to_string())?;
                    drop(pipe);
                    let output = child.wait_with_output().map_err(|err| err.to_string())?;
                    return Ok(RemoteProcOutput {
                        code: output.status.code(),
                        stdout: output.stdout,
                        stderr: output.stderr,
                    });
                }
                if proc.program == "scp" {
                    let source = PathBuf::from(&proc.args[proc.args.len() - 2]);
                    let destination = proc
                        .args
                        .last()
                        .unwrap()
                        .split_once(':')
                        .map(|(_, path)| path.to_string())
                        .unwrap_or_default();
                    std::fs::copy(&source, &destination).map_err(|err| err.to_string())?;
                    return Ok(RemoteProcOutput {
                        code: Some(0),
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                    });
                }
                Err(format!("unexpected program: {}", proc.program))
            })
        })
    }

    fn failing_scp_exec(env: &TestEnv) -> RemoteExecFn {
        let remote_root = env.remote_root.clone();
        let calls = Arc::clone(&env.calls);
        Arc::new(move |proc: RemoteProc| {
            let remote_root = remote_root.clone();
            let calls = Arc::clone(&calls);
            Box::pin(async move {
                calls.lock().unwrap().push(proc.program.clone());
                if proc.program == "ssh" {
                    let stdin = proc.stdin.unwrap_or_default();
                    if String::from_utf8_lossy(&stdin).contains("herdr-web-remote-uploads-dir") {
                        std::fs::create_dir_all(&remote_root).map_err(|err| err.to_string())?;
                        return Ok(RemoteProcOutput {
                            code: Some(0),
                            stdout: format!("{}\n", remote_root.display()).into_bytes(),
                            stderr: Vec::new(),
                        });
                    }
                }
                Ok(RemoteProcOutput {
                    code: Some(1),
                    stdout: Vec::new(),
                    stderr: b"simulated scp failure".to_vec(),
                })
            })
        })
    }

    fn first_timeout_exec(env: &TestEnv) -> RemoteExecFn {
        let calls = Arc::clone(&env.calls);
        Arc::new(move |proc: RemoteProc| {
            let calls = Arc::clone(&calls);
            Box::pin(async move {
                calls.lock().unwrap().push(proc.program.clone());
                Err("simulated timeout".to_string())
            })
        })
    }

    #[test]
    fn base64_encodes_known_vectors() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"abc"), "YWJj");
        assert_eq!(base64_encode(&[0xff, 0x00, 0x10]), "/wAQ");
    }

    #[test]
    fn name_validation_rejects_unsafe_and_overlong_names() {
        assert!(validate_remote_name("notes.txt").is_ok());
        assert!(validate_remote_name("weird $name' \"with spaces\".txt").is_ok());
        assert!(validate_remote_name("ünïcode-файл.txt").is_ok());
        for bad in ["", ".", "..", "a/b", "a\\b", "line\nbreak", "nul\0byte"] {
            assert!(validate_remote_name(bad).is_err(), "accepted {bad:?}");
        }
        let long = "a".repeat(256);
        assert!(validate_remote_name(&long).is_err());
        let edge = "a".repeat(255);
        assert!(validate_remote_name(&edge).is_ok());
    }

    #[test]
    fn dir_output_validation_rejects_garbage() {
        assert!(validate_remote_dir_output(b"").is_err());
        assert!(validate_remote_dir_output(b"relative/path\n").is_err());
        assert!(validate_remote_dir_output(b"/abs\nsecond\n").is_err());
        assert!(validate_remote_dir_output(b"/abs\x07ctl\n").is_err());
        let long = format!("/{}\n", "a".repeat(MAX_REMOTE_DIR_BYTES));
        assert!(validate_remote_dir_output(long.as_bytes()).is_err());
        assert_eq!(
            validate_remote_dir_output(b"/home/user/.local/share/herdr-web/uploads\n").unwrap(),
            "/home/user/.local/share/herdr-web/uploads"
        );
    }

    #[test]
    fn commit_script_transports_names_as_base64_not_shell_text() {
        let script = build_commit_script(
            "/home/farm er/.local/share/herdr-web/uploads",
            ".incoming-abc",
            "weird $name' \"with spaces\".txt",
            false,
            true,
        );
        assert!(script.contains("set -eu"), "script must be strict sh");
        assert!(script.contains("base64 -d"), "params must be base64");
        assert!(
            !script.contains("weird $name"),
            "raw filename must never appear in script text"
        );
        assert!(
            !script.contains("with spaces"),
            "raw spaces must never appear in script text"
        );
        assert!(script.contains(&base64_encode(
            "weird $name' \"with spaces\".txt".as_bytes()
        )));
        assert!(script.contains(&base64_encode(
            "/home/farm er/.local/share/herdr-web/uploads".as_bytes()
        )));
        assert!(script.contains(&base64_encode(b".incoming-abc")));
        assert!(script.contains("ln --"));
        assert!(!script.contains("rm -rf"));
    }

    #[test]
    fn commit_script_carries_conflict_flags() {
        let overwrite_on = build_commit_script("/d", ".s", "f.txt", true, false);
        let rename_on = build_commit_script("/d", ".s", "f.txt", false, true);
        assert!(overwrite_on.contains("set -eu"));
        assert_ne!(overwrite_on, rename_on, "flags must change the script");
        let neither = build_commit_script("/d", ".s", "f.txt", false, false);
        assert_ne!(neither, overwrite_on);
        assert_ne!(neither, rename_on);
    }

    #[test]
    fn ssh_and_scp_argv_use_batch_mode_and_sftp_mode() {
        let endpoint = endpoint();
        let ssh_args = ssh_control_args(&endpoint);
        assert_eq!(ssh_args[0], "-T");
        assert!(ssh_args.contains(&"BatchMode=yes".to_string()));
        let n = ssh_args.len();
        assert_eq!(ssh_args[n - 3], "root@127.0.0.1");
        assert_eq!(ssh_args[n - 2], "sh");
        assert_eq!(ssh_args[n - 1], "-s");
        let scp_args = scp_stage_args(&endpoint, Path::new("/tmp/stage"), "/remote/.incoming-x");
        assert_eq!(scp_args[0], "-s", "scp must run in SFTP mode");
        assert!(scp_args.contains(&"BatchMode=yes".to_string()));
        assert_eq!(
            scp_args.last().unwrap(),
            "root@127.0.0.1:/remote/.incoming-x"
        );
    }

    fn staging_mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn conflict_without_rename_or_overwrite_reports_conflict_and_cleans_staging() {
        let env = TestEnv::new();
        std::fs::write(env.remote_root.join("taken.txt"), b"old").unwrap();
        let exec = simulator_exec(&env);
        let error = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "taken.txt",
            b"new",
            false,
            false,
            &exec,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            RemoteUploadError::Conflict {
                name: "taken.txt".to_string(),
                path: format!("{}/taken.txt", env.remote_root.display()),
            }
        );
        assert!(env.staging_files().is_empty(), "staging must be cleaned");
        assert_eq!(
            std::fs::read(env.remote_root.join("taken.txt")).unwrap(),
            b"old",
            "existing remote file must not be clobbered"
        );
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[tokio::test]
    async fn rename_conflicts_commits_suffixed_name_atomically() {
        let env = TestEnv::new();
        std::fs::write(env.remote_root.join("notes.txt"), b"old").unwrap();
        let exec = simulator_exec(&env);
        let outcome = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "notes.txt",
            b"fresh bytes",
            false,
            true,
            &exec,
        )
        .await
        .unwrap();
        assert_eq!(outcome.name, "notes-1.txt");
        assert_eq!(
            outcome.remote_path,
            format!("{}/notes-1.txt", env.remote_root.display())
        );
        assert_eq!(
            std::fs::read(env.remote_root.join("notes-1.txt")).unwrap(),
            b"fresh bytes"
        );
        assert_eq!(
            std::fs::read(env.remote_root.join("notes.txt")).unwrap(),
            b"old"
        );
        assert!(env.staging_files().is_empty(), "staging must be cleaned");
        let staging_dir = env.staging_dir();
        assert_eq!(staging_mode(&staging_dir), 0o700);
        assert_eq!(
            staging_mode(&env.remote_root.join("notes-1.txt")),
            0o600,
            "committed remote files must stay private"
        );
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[tokio::test]
    async fn no_suffix_stays_when_directory_free() {
        let env = TestEnv::new();
        let exec = simulator_exec(&env);
        let outcome = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "ünïcode name 'with' $quotes.txt",
            b"content",
            false,
            true,
            &exec,
        )
        .await
        .unwrap();
        assert_eq!(outcome.name, "ünïcode name 'with' $quotes.txt");
        assert_eq!(
            std::fs::read(env.remote_root.join("ünïcode name 'with' $quotes.txt")).unwrap(),
            b"content"
        );
        assert!(env.staging_files().is_empty());
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[tokio::test]
    async fn explicit_overwrite_replaces_regular_file_only() {
        let env = TestEnv::new();
        std::fs::write(env.remote_root.join("target.bin"), b"old").unwrap();
        let exec = simulator_exec(&env);
        let outcome = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "target.bin",
            b"replacement",
            true,
            false,
            &exec,
        )
        .await
        .unwrap();
        assert_eq!(outcome.name, "target.bin");
        assert_eq!(
            std::fs::read(env.remote_root.join("target.bin")).unwrap(),
            b"replacement"
        );
        assert!(env.staging_files().is_empty());

        // A symlink at the target is refused, never clobbered.
        std::os::unix::fs::symlink(
            env.remote_root.join("target.bin"),
            env.remote_root.join("link.bin"),
        )
        .unwrap();
        let error = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "link.bin",
            b"x",
            true,
            false,
            &exec,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RemoteUploadError::BadRequest(_)));

        // A directory at the target is refused too.
        std::fs::create_dir(env.remote_root.join("dir.bin")).unwrap();
        let error = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "dir.bin",
            b"x",
            true,
            false,
            &exec,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RemoteUploadError::BadRequest(_)));
        assert!(env.staging_files().is_empty());
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[tokio::test]
    async fn scp_failure_reports_failure_and_cleans_staging() {
        let env = TestEnv::new();
        let exec = failing_scp_exec(&env);
        let error = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "lost.txt",
            b"data",
            false,
            true,
            &exec,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RemoteUploadError::Failure(_)));
        assert!(env.staging_files().is_empty());
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[tokio::test]
    async fn exec_timeout_reports_failure_cleans_staging_and_skips_scp() {
        let env = TestEnv::new();
        let exec = first_timeout_exec(&env);
        let error = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "slow.txt",
            b"data",
            false,
            true,
            &exec,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RemoteUploadError::Failure(_)));
        assert!(env.staging_files().is_empty());
        let calls = env.calls.lock().unwrap().clone();
        assert_eq!(calls, vec!["ssh".to_string()], "scp must never run");
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[tokio::test]
    async fn garbage_dir_resolution_fails_before_any_transfer() {
        let env = TestEnv::new();
        let calls = Arc::clone(&env.calls);
        let exec: RemoteExecFn = Arc::new(move |proc: RemoteProc| {
            let calls = Arc::clone(&calls);
            Box::pin(async move {
                calls.lock().unwrap().push(proc.program.clone());
                if proc.program == "ssh" {
                    return Ok(RemoteProcOutput {
                        code: Some(0),
                        stdout: b"not/absolute\n".to_vec(),
                        stderr: Vec::new(),
                    });
                }
                Ok(RemoteProcOutput {
                    code: Some(0),
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                })
            })
        });
        let error = upload_to_machine(
            &endpoint(),
            &env.upload_root,
            "x.txt",
            b"data",
            false,
            true,
            &exec,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RemoteUploadError::Failure(_)));
        assert!(env.staging_files().is_empty());
        let calls = env.calls.lock().unwrap().clone();
        assert_eq!(calls, vec!["ssh".to_string()]);
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[test]
    fn scp_availability_test_override_controls_capability() {
        let previous = scp_available();
        set_test_scp_available(Some(false));
        assert!(!scp_available());
        set_test_scp_available(Some(true));
        assert!(scp_available());
        set_test_scp_available(None);
        assert_eq!(scp_available(), previous);
    }

    #[tokio::test]
    async fn staging_file_is_private_and_unique() {
        let env = TestEnv::new();
        let exec = simulator_exec(&env);
        for round in 0..3 {
            let outcome = upload_to_machine(
                &endpoint(),
                &env.upload_root,
                &format!("round-{round}.txt"),
                format!("payload {round}").as_bytes(),
                false,
                true,
                &exec,
            )
            .await
            .unwrap();
            assert_eq!(outcome.name, format!("round-{round}.txt"));
        }
        // Staging names must be generated (not derived from the upload name)
        // and always removed; this is asserted via the cleanup checks above
        // plus the 0700 directory mode check in the rename test.
        assert!(env.staging_files().is_empty());
        assert!(
            env.remote_staging_leftovers().is_empty(),
            "remote staging must not leak after commit"
        );
        env.cleanup();
    }

    #[test]
    fn ssh_and_scp_argv_carry_fast_keepalives() {
        let endpoint = endpoint();
        let argvs = [
            ssh_control_args(&endpoint),
            scp_stage_args(&endpoint, Path::new("/tmp/stage"), "/remote/.incoming-x"),
        ];
        for args in argvs {
            let joined = args.join(" ");
            assert!(
                joined.contains("ServerAliveInterval=5"),
                "argv must carry a fast keepalive: {joined}"
            );
            assert!(
                joined.contains("ServerAliveCountMax=2"),
                "argv must fail fast on dead connections: {joined}"
            );
        }
    }

    #[test]
    fn commit_script_hardens_stage_before_commit_and_verifies_final_mode() {
        let script = build_commit_script("/d", ".s", "f.txt", false, true);
        let stage_chmod = script.find("chmod 600 -- \"$stage\"").expect("stage chmod");
        let first_link = script.find("ln --").expect("commit link");
        assert!(
            stage_chmod < first_link,
            "the staged file must be 0600 before any commit link is made"
        );
        assert!(
            !script.contains("chmod 600 -- \"$stage\" 2>/dev/null || true"),
            "stage hardening failures must be fatal, not ignored"
        );
        assert!(
            !script.contains("chmod 600 -- \"$final\" 2>/dev/null || true"),
            "final mode enforcement failures must be fatal, not ignored"
        );
        assert!(
            script.contains("chmod 600 -- \"$final\""),
            "final file mode must still be verified"
        );
    }

    #[cfg(unix)]
    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herdr-web-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn run_dir_script_with_home(home: &Path) -> std::process::Output {
        use std::io::Write as _;
        let mut child = std::process::Command::new("sh")
            .arg("-s")
            .env("HOME", home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(build_dir_script().as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn dir_script_tightens_a_pre_existing_loose_uploads_directory() {
        let base = unique_temp_dir("dirscript-loose");
        let home = base.join("home");
        let uploads = home.join(".local/share/herdr-web/uploads");
        std::fs::create_dir_all(&uploads).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&uploads, std::fs::Permissions::from_mode(0o755)).unwrap();

        let output = run_dir_script_with_home(&home);

        assert!(
            output.status.success(),
            "dir script must succeed on a loose pre-existing directory"
        );
        assert_eq!(
            staging_mode(&uploads),
            0o700,
            "a pre-existing app-owned uploads directory must be tightened to 0700"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn dir_script_creates_a_private_directory_for_fresh_homes() {
        let base = unique_temp_dir("dirscript-fresh");
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let uploads = home.join(".local/share/herdr-web/uploads");

        let output = run_dir_script_with_home(&home);

        assert!(output.status.success(), "dir script must succeed");
        assert_eq!(
            staging_mode(&uploads),
            0o700,
            "a freshly created uploads directory must be private"
        );
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert_eq!(
            stdout,
            uploads
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            "the script must print the canonical uploads path"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn dir_script_rejects_a_symlinked_uploads_directory() {
        let base = unique_temp_dir("dirscript-symlink");
        let home = base.join("home");
        let real = home.join(".local/share/herdr-web/real-uploads");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink("real-uploads", home.join(".local/share/herdr-web/uploads"))
            .unwrap();

        let output = run_dir_script_with_home(&home);

        assert!(
            !output.status.success(),
            "a symlinked final uploads directory must be rejected, never tightened or followed"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    fn write_fake_slow_scp(dir: &Path) -> PathBuf {
        // A harmless stand-in for a wedged scp: it spawns a long-lived child
        // in its own process group (plain `&`, no job control) that would
        // survive a kill of only the direct child.
        let fake = dir.join("fake-slow-scp");
        let script = format!(
            "#!/bin/sh\nsleep 300 &\nprintf '%s\\n' \"$!\" > {}\nsleep 300\n",
            dir.join("grandchild.pid").display()
        );
        std::fs::write(&fake, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        fake
    }

    #[cfg(unix)]
    fn wait_for_grandchild_pid(dir: &Path) -> i32 {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Ok(text) = std::fs::read_to_string(dir.join("grandchild.pid")) {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    return pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "fake scp never recorded its child"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    #[cfg(unix)]
    fn process_is_gone_or_zombie(pid: i32) -> bool {
        // kill(0) probes existence. A zombie was already torn down and only
        // awaits reaping by whoever inherited it, which counts as dead.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => match stat.rsplit(')').next() {
                Some(rest) => match rest.trim_start().chars().next() {
                    Some(state) => state == 'Z',
                    None => true,
                },
                None => true,
            },
            Err(_) => true,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_exec_kills_the_whole_owned_process_group() {
        let dir = unique_temp_dir("procgroup-cancel");
        let fake = write_fake_slow_scp(&dir);
        let exec = default_exec();
        // Cancel the exec shortly after spawn: dropping the future must tear
        // down the entire owned process group, not only the direct child.
        // ETXTBSY warm-up (see machine_disable_runner in machines.rs): an
        // instantly failing spawn must not be mistaken for the real run.
        loop {
            let proc = RemoteProc {
                program: fake.to_string_lossy().into_owned(),
                args: Vec::new(),
                stdin: None,
            };
            match tokio::time::timeout(Duration::from_millis(400), exec(proc)).await {
                Ok(Err(error)) if error.contains("Text file busy") => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                _ => break,
            }
        }

        let pid = wait_for_grandchild_pid(&dir);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            process_is_gone_or_zombie(pid),
            "grandchild {pid} must not keep running after cancellation"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_exec_kills_the_whole_owned_process_group() {
        let dir = unique_temp_dir("procgroup-timeout");
        let fake = write_fake_slow_scp(&dir);
        // Inject a short overall timeout: the direct child AND its
        // long-lived grandchild must both be torn down. ETXTBSY warm-up
        // (see machine_disable_runner in machines.rs): a spawn failure is
        // instant, so only the real run pays the 300 ms timeout.
        let error = loop {
            let proc = RemoteProc {
                program: fake.to_string_lossy().into_owned(),
                args: Vec::new(),
                stdin: None,
            };
            match run_owned_process(proc, Duration::from_millis(300)).await {
                Err(error) if error.contains("Text file busy") => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => break error,
                Ok(_) => panic!("the injected timeout must fail the run"),
            }
        };
        assert_eq!(error, "process timed out");

        let pid = wait_for_grandchild_pid(&dir);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            process_is_gone_or_zombie(pid),
            "grandchild {pid} must not keep running after the timeout"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
