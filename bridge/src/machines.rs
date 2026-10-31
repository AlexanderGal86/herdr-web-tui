//! Saved Herdr machine discovery and SSH transport plumbing.
//!
//! Mirrors the native CLI concept of machines: the local daemon this bridge
//! serves plus the operator's saved SSH endpoints from Herdr's client state
//! (`endpoints.json`). The bridge never accepts machine targets from the
//! browser; machine ids must resolve against this operator-configured,
//! enabled catalog. Remote transports reuse Herdr's hidden remote bridge
//! commands (`remote-api-bridge`, `remote-client-bridge`) over plain `ssh`
//! argument vectors (no remote shell string is ever built), and the remote
//! capability probe must report `herdr-api-bridge-v1` before any machine
//! route is served — unknown, disabled, or unsupported machines fail closed.
//!
//! Safety/liveness invariants:
//! - machine bridge sockets only ever live under an app-owned, strictly
//!   validated private directory tree (never a shared world-writable root
//!   such as `/tmp`); every path component is lstat-checked (no symlinks,
//!   current-euid ownership, no world-writable component) and created with
//!   `mkdir(2)` mode 0700 so no chmod ever follows a pre-planted symlink.
//! - the shared bridge cache is never locked across the blocking remote
//!   probe: per-machine gates serialize same-machine work, failed probes
//!   are negatively cached with a short TTL, and probe diagnostics stay in
//!   server logs (clients receive a generic unavailable error).
//! - every accepted bridge connection must hold a permit from a bounded
//!   counter, capping concurrent `ssh` children.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const LOCAL_MACHINE_ID: &str = "local";
pub const MACHINES_ENDPOINTS_ENV_VAR: &str = "HERDR_WEB_MACHINES_ENDPOINTS";
pub const MACHINE_SOCKET_DIR_ENV_VAR: &str = "HERDR_WEB_MACHINE_SOCKET_DIR";
pub const REMOTE_API_BRIDGE_CAPABILITY: &str = "herdr-api-bridge-v1";
pub const REMOTE_API_BRIDGE_COMMAND: &str = "remote-api-bridge";
pub const REMOTE_CLIENT_BRIDGE_COMMAND: &str = "remote-client-bridge";
const DEFAULT_SESSION_NAME: &str = "default";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedEndpoint {
    pub id: String,
    pub label: String,
    pub target: String,
    pub session: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedMachine {
    Local,
    Ssh(SavedEndpoint),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineError {
    Unknown(String),
    Disabled(String),
}

impl std::fmt::Display for MachineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown(id) => write!(f, "unknown machine: {id}"),
            Self::Disabled(id) => write!(f, "machine is disabled: {id}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineKind {
    Local,
    Ssh,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MachineEntry {
    pub id: String,
    pub label: String,
    pub kind: MachineKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MachineCatalog {
    ssh: Vec<SavedEndpoint>,
}

impl MachineCatalog {
    pub fn load_from(path: &Path) -> MachineCatalog {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => return MachineCatalog::default(),
        };
        let saved = match serde_json::from_slice::<SavedEndpointsFile>(&bytes) {
            Ok(saved) => saved,
            Err(_) => return MachineCatalog::default(),
        };
        MachineCatalog {
            ssh: saved
                .ssh
                .into_iter()
                .map(SavedEndpoint::from)
                .filter(|endpoint| {
                    is_valid_machine_id(&endpoint.id) && is_valid_ssh_target(&endpoint.target)
                })
                .collect(),
        }
    }

    pub fn load() -> MachineCatalog {
        MachineCatalog::load_from(&default_endpoints_path())
    }

    pub fn machines(&self) -> Vec<MachineEntry> {
        let mut machines = Vec::with_capacity(self.ssh.len() + 1);
        machines.push(MachineEntry {
            id: LOCAL_MACHINE_ID.to_string(),
            label: "Local".to_string(),
            kind: MachineKind::Local,
        });
        machines.extend(
            self.ssh
                .iter()
                .filter(|e| e.enabled)
                .map(|endpoint| MachineEntry {
                    id: endpoint.id.clone(),
                    label: endpoint.label.clone(),
                    kind: MachineKind::Ssh,
                }),
        );
        machines
    }

    pub fn resolve(&self, id: &str) -> Result<ResolvedMachine, MachineError> {
        if !is_valid_machine_id(id) {
            return Err(MachineError::Unknown(id.to_string()));
        }
        if id == LOCAL_MACHINE_ID {
            return Ok(ResolvedMachine::Local);
        }
        match self.ssh.iter().find(|endpoint| endpoint.id == id) {
            Some(endpoint) if endpoint.enabled => Ok(ResolvedMachine::Ssh(endpoint.clone())),
            Some(endpoint) => Err(MachineError::Disabled(endpoint.id.clone())),
            None => Err(MachineError::Unknown(id.to_string())),
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct SavedEndpointsFile {
    #[serde(default)]
    ssh: Vec<SavedEndpointRecord>,
}

#[derive(Debug, serde::Deserialize)]
struct SavedEndpointRecord {
    id: String,
    #[serde(default)]
    label: String,
    target: String,
    #[serde(default = "default_session_name")]
    session: String,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

fn default_session_name() -> String {
    DEFAULT_SESSION_NAME.to_string()
}

fn default_enabled() -> bool {
    true
}

impl From<SavedEndpointRecord> for SavedEndpoint {
    fn from(record: SavedEndpointRecord) -> Self {
        SavedEndpoint {
            id: record.id,
            label: record.label,
            target: record.target,
            session: record.session,
            enabled: record.enabled,
        }
    }
}

pub fn is_valid_machine_id(id: &str) -> bool {
    id == LOCAL_MACHINE_ID
        || ((1..=64).contains(&id.len()) && id.chars().all(|ch| ch.is_ascii_hexdigit()))
}

/// Operator-saved ssh targets are passed as a single argv entry, but a target
/// beginning with `-` would still be parsed by `ssh` as an option and control
/// characters have no business in a host spec — reject both at every
/// transport boundary even though the catalog is operator-controlled.
pub fn is_valid_ssh_target(target: &str) -> bool {
    !target.is_empty()
        && !target.starts_with('-')
        && !target.chars().any(|ch| ch.is_ascii_control())
}

/// Validation for operator-supplied machine-add fields (label, session).
/// They travel as separate argv entries, but a value beginning with `-` would
/// still parse as a CLI/ssh option and control characters have no business in
/// either field.
pub fn is_valid_machine_arg(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && !value.chars().any(|ch| ch.is_ascii_control())
}

/// Argument vector for the native `herdr machine add` registration (the
/// caller supplies the `herdr` binary itself). Built as separate argv entries
/// (never a shell string); optional fields are passed only when provided so
/// the CLI keeps applying its own defaults.
pub fn machine_add_args(target: &str, label: Option<&str>, session: Option<&str>) -> Vec<String> {
    let mut args = vec!["machine".to_string(), "add".to_string(), target.to_string()];
    if let Some(label) = label {
        args.push("--label".to_string());
        args.push(label.to_string());
    }
    if let Some(session) = session {
        args.push("--remote-session".to_string());
        args.push(session.to_string());
    }
    args
}

pub fn default_endpoints_path() -> PathBuf {
    if let Some(path) = crate::store_util::non_empty_env_path(MACHINES_ENDPOINTS_ENV_VAR) {
        return path;
    }
    client_state_dir().join("endpoints.json")
}

/// True when the machine catalog is read through the `HERDR_WEB_MACHINES_ENDPOINTS`
/// override (tests, sandboxes). The native `herdr machine add` CLI never honors
/// that override — it always writes the operator's real Herdr client state — so
/// registration must be refused instead of silently modifying a different
/// catalog than the one this bridge serves.
pub fn catalog_override_active() -> bool {
    crate::store_util::non_empty_env_path(MACHINES_ENDPOINTS_ENV_VAR).is_some()
}

fn client_state_dir() -> PathBuf {
    if let Some(home) = crate::store_util::non_empty_env_path("HOME") {
        return home
            .join(".local")
            .join("state")
            .join("herdr")
            .join("client");
    }
    PathBuf::from(".local/state/herdr/client")
}

/// Argument vector for `ssh` running a hidden remote Herdr bridge command.
/// Built as separate argv entries (never a shell string) so saved targets
/// can never inject shell syntax; the session flag is only passed when the
/// saved session differs from Herdr's default, matching the native client.
pub fn ssh_remote_herdr_args(endpoint: &SavedEndpoint, remote_command: &str) -> Vec<String> {
    let mut args = vec![
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // Fast keepalives so a silently dead peer cannot hold a bridge
        // connection permit; same values as the scp upload path.
        "-o".to_string(),
        "ServerAliveInterval=5".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=2".to_string(),
        endpoint.target.clone(),
        "herdr".to_string(),
    ];
    if endpoint.session != DEFAULT_SESSION_NAME {
        args.push("--session".to_string());
        args.push(endpoint.session.clone());
    }
    args.push(remote_command.to_string());
    args
}

/// Argument vector for the remote capability probe (`--check`).
pub fn ssh_remote_herdr_check_args(endpoint: &SavedEndpoint) -> Vec<String> {
    let mut args = ssh_remote_herdr_args(endpoint, REMOTE_API_BRIDGE_COMMAND);
    args.push("--check".to_string());
    args
}

// ---------------------------------------------------------------------------
// Bridge-side machine manager
// ---------------------------------------------------------------------------

use std::io::{self, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PROBE_TIMEOUT_SECONDS: u64 = 25;
/// How long `herdr machine add` may prepare the remote server before the
/// bridge kills the child (first-contact preparation can take a while).
const MACHINE_ADD_TIMEOUT_SECONDS: u64 = 300;
/// Latest stderr kept for the operator-facing error; older bytes are still
/// drained, just discarded.
const MACHINE_ADD_STDERR_CAP_BYTES: usize = 64 * 1024;
const STDERR_DRAIN_CHUNK_BYTES: usize = 8 * 1024;
/// Grace granted to the stderr reader after the CLI exits, so its final
/// diagnostics still land even when a descendant holds the pipe open.
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(500);
/// Hard ceiling on how long the handler waits for captured stderr.
const STDERR_WAIT: Duration = Duration::from_secs(3);
const PROBE_POLL: Duration = Duration::from_millis(50);
const ACCEPT_POLL: Duration = Duration::from_millis(20);
/// Ceiling for the transient-accept-error backoff: keeps a resource-starved
/// loop from spinning hot while still re-checking the listener every second.
#[cfg(unix)]
const ACCEPT_BACKOFF_MAX: Duration = Duration::from_millis(1_000);
/// How long a failed remote probe is remembered before another attempt.
const DEFAULT_NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(5);
/// Hard ceiling on concurrently served machine bridge connections (and thus
/// concurrent root `ssh` children) across all saved machines.
const DEFAULT_MAX_BRIDGE_CONNECTIONS: usize = 32;

/// The remote capability probe, injectable so liveness tests can simulate an
/// unreachable machine deterministically instead of waiting on real ssh
/// timeouts.
pub type ProbeFn = Arc<dyn Fn(&SavedEndpoint) -> Result<(), String> + Send + Sync>;

#[derive(Clone)]
pub struct MachineSshState {
    pub api: herdr_compat::api::client::ApiClient,
    pub client_socket_path: PathBuf,
    pub terminal_sessions: Arc<Mutex<crate::web_bridge::TerminalSessions>>,
    pub selected_pane_id: Arc<Mutex<Option<String>>>,
    /// Keeps the per-machine listener sockets alive while any handle to this
    /// machine state lives; dropping the last handle stops the listeners.
    _keepalive: Arc<MachineBridges>,
}

pub(crate) struct MachineManagerConfig {
    pub(crate) probe: ProbeFn,
    pub(crate) negative_cache_ttl: Duration,
    pub(crate) max_bridge_connections: usize,
    /// Per-manager socket root override. Tests give every MachineManager its
    /// own directory: parallel test managers would otherwise race their
    /// remove_file→bind cycles on the shared default root (EADDRINUSE).
    pub(crate) socket_dir: Option<PathBuf>,
}

impl Default for MachineManagerConfig {
    fn default() -> Self {
        Self {
            probe: Arc::new(probe_remote_support) as ProbeFn,
            negative_cache_ttl: DEFAULT_NEGATIVE_CACHE_TTL,
            max_bridge_connections: DEFAULT_MAX_BRIDGE_CONNECTIONS,
            socket_dir: None,
        }
    }
}

struct CachedMachineState {
    endpoint: SavedEndpoint,
    state: Arc<MachineSshState>,
}

struct NegativeEntry {
    endpoint: SavedEndpoint,
    until: Instant,
}

pub struct MachineManager {
    socket_dir: PathBuf,
    states: Mutex<HashMap<String, CachedMachineState>>,
    /// Per-machine gates: same-machine requests serialize (one probe, one
    /// shared bridge) while different machines never wait on each other.
    inflight: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    negative: Mutex<HashMap<String, NegativeEntry>>,
    probe: ProbeFn,
    negative_cache_ttl: Duration,
    permits: ConnectionPermits,
}

impl MachineManager {
    pub fn new() -> io::Result<Self> {
        Self::with_config(MachineManagerConfig::default())
    }

    pub(crate) fn with_config(config: MachineManagerConfig) -> io::Result<Self> {
        let socket_dir = match config.socket_dir {
            Some(dir) => dir,
            None => default_machine_socket_dir()?,
        };
        ensure_machine_dir(&socket_dir)?;
        Ok(Self {
            socket_dir,
            states: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            negative: Mutex::new(HashMap::new()),
            probe: config.probe,
            negative_cache_ttl: config.negative_cache_ttl,
            permits: ConnectionPermits::new(config.max_bridge_connections),
        })
    }

    /// Live catalog: re-read per call so saved-machine changes made through the
    /// native CLI appear without a bridge restart.
    pub fn catalog(&self) -> MachineCatalog {
        MachineCatalog::load()
    }

    /// Resolves an SSH machine to its bridged API/client sockets, probing the
    /// remote capability first and failing closed when unsupported.
    ///
    /// Liveness: the shared `states` map is never held across the blocking
    /// probe or bridge startup, so one unreachable machine cannot stall
    /// other machines or local routes. Concurrent requests for the same
    /// machine join the first probe via a per-machine gate. Failed probes
    /// are negatively cached for a short TTL so a dead machine fails fast
    /// instead of paying the probe timeout on every request. Probe
    /// diagnostics (ssh stderr) are logged server-side only; callers get a
    /// generic unavailable message.
    pub fn ssh_state(&self, endpoint: &SavedEndpoint) -> Result<Arc<MachineSshState>, String> {
        if !is_valid_machine_id(&endpoint.id) || endpoint.id == LOCAL_MACHINE_ID {
            return Err(format!("invalid machine id: {}", endpoint.id));
        }
        if !is_valid_ssh_target(&endpoint.target) {
            tracing::warn!(machine = %endpoint.id, "refusing machine with unsafe ssh target");
            return Err(unavailable_message(endpoint));
        }
        if let Some(state) = self.fresh_cached_state(endpoint) {
            return Ok(state);
        }
        if self.negative_cache_hit(endpoint) {
            return Err(unavailable_message(endpoint));
        }
        let gate = self.machine_gate(&endpoint.id);
        let _same_machine = gate
            .lock()
            .map_err(|_| "machine state lock poisoned".to_string())?;
        // Re-check: another request for this machine may have finished the
        // probe (or refreshed the negative cache) while we waited on the gate.
        if let Some(state) = self.fresh_cached_state(endpoint) {
            return Ok(state);
        }
        if self.negative_cache_hit(endpoint) {
            return Err(unavailable_message(endpoint));
        }
        if let Err(detail) = (self.probe)(endpoint) {
            tracing::warn!(
                machine = %endpoint.id,
                target = %endpoint.target,
                error = %detail,
                "remote machine probe failed"
            );
            self.remember_probe_failure(endpoint);
            return Err(unavailable_message(endpoint));
        }
        let api_bridge = SshSocketBridge::start(
            endpoint,
            &self.socket_dir,
            BridgeKind::Api,
            self.permits.clone(),
            "ssh",
        )?;
        let client_bridge = SshSocketBridge::start(
            endpoint,
            &self.socket_dir,
            BridgeKind::Client,
            self.permits.clone(),
            "ssh",
        )?;
        let state = Arc::new(MachineSshState {
            api: herdr_compat::api::client::ApiClient::for_socket_path(api_bridge.path.clone()),
            client_socket_path: client_bridge.path.clone(),
            terminal_sessions: Arc::new(Mutex::new(crate::web_bridge::TerminalSessions::default())),
            selected_pane_id: Arc::new(Mutex::new(None)),
            _keepalive: Arc::new(MachineBridges {
                _api: api_bridge,
                _client: client_bridge,
            }),
        });
        {
            let mut states = self
                .states
                .lock()
                .map_err(|_| "machine state lock poisoned".to_string())?;
            // Inserting replaces any stale entry left for a changed
            // endpoint; dropping the last reference to the old state stops
            // its accept threads and unlinks its sockets (distinct paths per
            // target+session, so a stale drop can never unlink live ones).
            states.insert(
                endpoint.id.clone(),
                CachedMachineState {
                    endpoint: endpoint.clone(),
                    state: state.clone(),
                },
            );
        }
        if let Ok(mut negative) = self.negative.lock() {
            negative.remove(&endpoint.id);
        }
        Ok(state)
    }

    fn fresh_cached_state(&self, endpoint: &SavedEndpoint) -> Option<Arc<MachineSshState>> {
        let mut states = self.states.lock().ok()?;
        match states.get(&endpoint.id) {
            Some(cached)
                if cached.endpoint.target == endpoint.target
                    && cached.endpoint.session == endpoint.session =>
            {
                Some(cached.state.clone())
            }
            // Stale entry for a changed endpoint: evict. Dropping the cached
            // state here may release old bridges (a bounded, local
            // stop-and-join of their accept threads) while holding the map
            // lock — never the remote probe.
            Some(_) => {
                states.remove(&endpoint.id);
                None
            }
            None => None,
        }
    }

    fn machine_gate(&self, id: &str) -> Arc<Mutex<()>> {
        self.inflight
            .lock()
            .map(|mut inflight| inflight.entry(id.to_string()).or_default().clone())
            .unwrap_or_else(|_| Arc::new(Mutex::new(())))
    }

    fn negative_cache_hit(&self, endpoint: &SavedEndpoint) -> bool {
        let Ok(mut negative) = self.negative.lock() else {
            return false;
        };
        match negative.get(&endpoint.id) {
            Some(entry)
                if entry.endpoint.target == endpoint.target
                    && entry.endpoint.session == endpoint.session
                    && Instant::now() < entry.until =>
            {
                true
            }
            Some(_) => {
                negative.remove(&endpoint.id);
                false
            }
            None => false,
        }
    }

    fn remember_probe_failure(&self, endpoint: &SavedEndpoint) {
        if let Ok(mut negative) = self.negative.lock() {
            negative.insert(
                endpoint.id.clone(),
                NegativeEntry {
                    endpoint: endpoint.clone(),
                    until: Instant::now() + self.negative_cache_ttl,
                },
            );
        }
    }
}

fn unavailable_message(endpoint: &SavedEndpoint) -> String {
    format!("machine {} is unavailable", endpoint.label)
}

struct MachineBridges {
    _api: SshSocketBridge,
    _client: SshSocketBridge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeKind {
    Api,
    Client,
}

/// Bounded permit counter shared by every machine bridge: each accepted local
/// socket otherwise spawns an `ssh` child plus copy threads with no limit, so
/// a hostile allowed-origin connection burst must hit a hard ceiling instead
/// of creating unbounded root ssh children.
#[derive(Clone)]
pub struct ConnectionPermits {
    inner: Arc<PermitShared>,
}

struct PermitShared {
    current: AtomicUsize,
    max: usize,
}

impl ConnectionPermits {
    pub fn new(max: usize) -> Self {
        Self {
            inner: Arc::new(PermitShared {
                current: AtomicUsize::new(0),
                max,
            }),
        }
    }

    pub fn try_acquire(&self) -> bool {
        let mut held = self.inner.current.load(Ordering::Acquire);
        loop {
            if held >= self.inner.max {
                return false;
            }
            match self.inner.current.compare_exchange_weak(
                held,
                held + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(actual) => held = actual,
            }
        }
    }

    pub fn release(&self) {
        self.inner.current.fetch_sub(1, Ordering::AcqRel);
    }

    pub fn current(&self) -> usize {
        self.inner.current.load(Ordering::Acquire)
    }

    pub fn max(&self) -> usize {
        self.inner.max
    }
}

/// Releases a permit even if the connection thread panics.
struct PermitGuard(ConnectionPermits);

impl Drop for PermitGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// A private user-only local Unix socket that forwards every accepted
/// connection to the remote Herdr hidden bridge command over `ssh` stdio —
/// the same transport shape the native client uses for saved machines.
/// What the machine bridge accept loop should do with an accept error.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum AcceptErrorAction {
    /// No pending connection or interrupted call: poll again after ACCEPT_POLL.
    Poll,
    /// Resource pressure that clears by itself (fd/memory limits, aborted
    /// handshakes): warn, back off, keep serving.
    Backoff,
    /// The listener itself is broken; retrying can never succeed.
    Fatal,
}

#[cfg(unix)]
fn accept_error_action(err: &io::Error) -> AcceptErrorAction {
    match err.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => AcceptErrorAction::Poll,
        _ => match err.raw_os_error() {
            Some(libc::EMFILE)
            | Some(libc::ENFILE)
            | Some(libc::ENOBUFS)
            | Some(libc::ECONNABORTED) => AcceptErrorAction::Backoff,
            _ => AcceptErrorAction::Fatal,
        },
    }
}

/// Sleep `current` backoff in ACCEPT_POLL slices so `stop` stays prompt,
/// returning the next (doubled, capped) backoff duration.
#[cfg(unix)]
fn accept_backoff_sleep(stop: &AtomicBool, current: Duration) -> Duration {
    let mut remaining = current;
    while remaining > Duration::ZERO && !stop.load(Ordering::Acquire) {
        let slice = remaining.min(ACCEPT_POLL);
        std::thread::sleep(slice);
        remaining -= slice;
    }
    (current * 2).min(ACCEPT_BACKOFF_MAX)
}

/// The machine bridge accept loop. `accept` is the listener poll (real code
/// passes `listener.accept()`), `on_connection` serves one accepted stream.
/// Transient accept errors back off instead of killing the loop; listener-
/// fatal errors record `fatal` and exit so a dead listener is never silently
/// retried forever. Exits promptly whenever `stop` is observed.
#[cfg(unix)]
fn run_accept_loop(
    mut accept: impl FnMut() -> io::Result<std::os::unix::net::UnixStream>,
    mut on_connection: impl FnMut(std::os::unix::net::UnixStream),
    stop: &AtomicBool,
    fatal: &AtomicBool,
) {
    let mut backoff = ACCEPT_POLL;
    let mut warned = false;
    while !stop.load(Ordering::Acquire) {
        match accept() {
            Ok(stream) => {
                backoff = ACCEPT_POLL;
                warned = false;
                on_connection(stream);
            }
            Err(err) => match accept_error_action(&err) {
                AcceptErrorAction::Poll => {
                    std::thread::sleep(ACCEPT_POLL);
                }
                AcceptErrorAction::Backoff => {
                    if !warned {
                        tracing::warn!(
                            error = %err,
                            "machine bridge accept failed; backing off"
                        );
                        warned = true;
                    }
                    backoff = accept_backoff_sleep(stop, backoff);
                }
                AcceptErrorAction::Fatal => {
                    tracing::error!(
                        error = %err,
                        "machine bridge listener failed; accept loop exiting"
                    );
                    fatal.store(true, Ordering::Release);
                    return;
                }
            },
        }
    }
}

pub struct SshSocketBridge {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    fatal: Arc<AtomicBool>,
    accept_thread: Option<std::thread::JoinHandle<()>>,
}

impl SshSocketBridge {
    pub fn start(
        endpoint: &SavedEndpoint,
        socket_dir: &Path,
        kind: BridgeKind,
        permits: ConnectionPermits,
        ssh_program: &str,
    ) -> Result<Self, String> {
        if !is_valid_machine_id(&endpoint.id) || endpoint.id == LOCAL_MACHINE_ID {
            return Err(format!("invalid machine id: {}", endpoint.id));
        }
        if !is_valid_ssh_target(&endpoint.target) {
            return Err(format!("invalid ssh target for machine {}", endpoint.id));
        }
        let dir = socket_dir.join(machine_dir_name(endpoint));
        ensure_machine_dir(&dir).map_err(|err| err.to_string())?;
        let path = dir.join(match kind {
            BridgeKind::Api => "api.sock",
            BridgeKind::Client => "client.sock",
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::remove_file(&path);
            #[cfg(unix)]
            let listener = std::os::unix::net::UnixListener::bind(&path)
                .map_err(|err| format!("failed to bind machine bridge socket: {err}"))?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|err| format!("failed to restrict machine bridge socket: {err}"))?;
            let stop = Arc::new(AtomicBool::new(false));
            let finished = Arc::new(AtomicBool::new(false));
            let fatal = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop);
            let thread_finished = Arc::clone(&finished);
            let thread_fatal = Arc::clone(&fatal);
            let target = endpoint.target.clone();
            let session = endpoint.session.clone();
            let remote_command = match kind {
                BridgeKind::Api => REMOTE_API_BRIDGE_COMMAND,
                BridgeKind::Client => REMOTE_CLIENT_BRIDGE_COMMAND,
            }
            .to_string();
            // Injected so tests can point the bridge at a fake ssh instead
            // of relying on PATH lookups.
            let ssh_program = ssh_program.to_string();
            // Non-blocking accept so the loop can observe `stop` and exit
            // deterministically; Drop joins the thread instead of leaking it
            // blocked inside accept().
            listener
                .set_nonblocking(true)
                .map_err(|err| format!("failed to set machine bridge socket mode: {err}"))?;
            let accept_thread = std::thread::spawn(move || {
                let target = target;
                run_accept_loop(
                    || listener.accept().map(|(stream, _)| stream),
                    move |stream| {
                        // Some platforms propagate O_NONBLOCK to accepted
                        // streams; the copy loops below are blocking.
                        let _ = stream.set_nonblocking(false);
                        if !permits.try_acquire() {
                            tracing::warn!(
                                held = permits.current(),
                                limit = permits.max(),
                                "machine bridge connection limit reached; dropping connection"
                            );
                            return;
                        }
                        let guard = PermitGuard(permits.clone());
                        let endpoint = SavedEndpoint {
                            id: String::new(),
                            label: String::new(),
                            target: target.clone(),
                            session: session.clone(),
                            enabled: true,
                        };
                        let remote_command = remote_command.clone();
                        let ssh_program = ssh_program.clone();
                        std::thread::spawn(move || {
                            let _permit = guard;
                            serve_bridge_connection(
                                stream,
                                &endpoint,
                                &remote_command,
                                &ssh_program,
                            )
                        });
                    },
                    &thread_stop,
                    &thread_fatal,
                );
                thread_finished.store(true, Ordering::Release);
            });
            Ok(Self {
                path,
                stop,
                finished,
                fatal,
                accept_thread: Some(accept_thread),
            })
        }
        #[cfg(not(unix))]
        {
            let _ = (endpoint, kind, permits);
            Err("saved SSH machines require a Unix host".to_string())
        }
    }

    /// True once the accept thread has exited (observed by liveness tests).
    pub fn accept_thread_finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }

    /// True when the accept thread exited because the listener itself failed
    /// (as opposed to a requested stop).
    pub fn accept_thread_failed(&self) -> bool {
        self.fatal.load(Ordering::Acquire)
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.accept_thread.take() {
            let _ = thread.join();
        }
        tracing::debug!(
            path = ?self.path,
            stopped = self.accept_thread_finished(),
            failed = self.accept_thread_failed(),
            "machine bridge stopped"
        );
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for SshSocketBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Per-machine socket directory: id-prefixed and fingerprinted with the
/// endpoint target+session so a changed endpoint gets fresh sockets and a
/// stale bridge's cleanup can never unlink a live successor's socket.
fn machine_dir_name(endpoint: &SavedEndpoint) -> String {
    let id_prefix = &endpoint.id[..16.min(endpoint.id.len())];
    let fingerprint =
        crate::store_util::stable_hash(&format!("{}\u{1}{}", endpoint.target, endpoint.session));
    format!("{id_prefix}-{fingerprint:016x}")
}

#[cfg(unix)]
fn serve_bridge_connection(
    stream: std::os::unix::net::UnixStream,
    endpoint: &SavedEndpoint,
    remote_command: &str,
    ssh_program: &str,
) {
    use std::io::Write as _;
    use std::net::Shutdown;

    let args = ssh_remote_herdr_args(endpoint, remote_command);
    let mut command = Command::new(ssh_program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Own process group so teardown can SIGKILL ssh's whole subtree:
    // `Child::kill` alone only signals the ssh leader, and descendants
    // (ProxyCommand helpers, forwarded helpers) survive their leader.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            tracing::warn!(error = %err, "failed to start ssh machine bridge");
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    };
    let mut child_stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            kill_process_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
    };
    let mut child_stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_process_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
    };
    let mut write_stream = stream;
    let mut read_stream = match write_stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => {
            kill_process_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
    };
    // Shared so the stdin copier can tear the child down: EOF on the client
    // socket means the local client is gone for good (no client here
    // half-closes — API requests drop the stream, terminal detach shuts down
    // both directions), and an ssh child that ignores stdin EOF and stays
    // silent would otherwise hold the permit until it exits on its own.
    // The PID is read before the child moves into the shared mutex: the
    // watchdog below polls it and never needs the mutex at all.
    #[cfg(unix)]
    let leader_pid = child.id();
    let child = Arc::new(std::sync::Mutex::new(child));
    let kill_on_client_eof = Arc::clone(&child);
    let up = std::thread::spawn(move || {
        let _ = copy_pipe(&mut read_stream, &mut child_stdin);
        // Dropping stdin sends EOF so a half-closed local peer ends the ssh child.
        if let Ok(mut child) = kill_on_client_eof.lock() {
            kill_process_group(child.id());
            let _ = child.kill();
        }
    });
    // The ssh leader can die early (connection refused, remote command
    // gone) while a descendant still holds the stdout pipe and a silent
    // client never EOFs — then only the leader's death can trigger the
    // teardown. The watchdog watches the leader WITHOUT reaping it
    // (waitid WNOWAIT): a reaping poll (try_wait) would free the PID while
    // the loop keeps signaling its group, and a recycled PID could then
    // receive the kill. On exit it kills the group exactly once and stops:
    // the descendant's pipes close, the copy loop below sees EOF, and the
    // regular teardown follows. Until the main thread's final wait() the
    // zombie keeps owning the PID, so every group signal provably targets
    // the leader's own group.
    #[cfg(unix)]
    let teardown_done = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        let watchdog_done = Arc::clone(&teardown_done);
        std::thread::spawn(move || {
            while !watchdog_done.load(Ordering::Acquire) {
                if leader_exited_without_reaping(leader_pid) {
                    kill_process_group(leader_pid);
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
    }
    let _ = copy_pipe(&mut child_stdout, &mut write_stream);
    let _ = write_stream.flush();
    // The ssh child is gone: close the socket so the local peer sees EOF and
    // the stdin copier wakes, instead of holding the connection permit until
    // the peer happens to send or disconnect.
    let _ = write_stream.shutdown(Shutdown::Both);
    let _ = up.join();
    let mut child = child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    kill_process_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
    #[cfg(unix)]
    teardown_done.store(true, Ordering::Release);
}

/// Chunked pipe copy between a socket half and an ssh stdio pipe.
/// `std::io::copy` stalled against live ssh stdio bridges (responses never
/// left the child's stdout pipe), so this keeps an explicit read/write loop
/// that was verified against a real saved machine.
fn copy_pipe<R: std::io::Read, W: std::io::Write>(
    reader: &mut R,
    writer: &mut W,
) -> std::io::Result<u64> {
    let mut buf = [0u8; 4096];
    let mut total = 0u64;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        writer.write_all(&buf[..n])?;
        total += n as u64;
    }
}

/// Probes the remote hidden `remote-api-bridge --check` capability and fails
/// closed unless the remote Herdr reports the exact supported marker.
/// The error string is for server-side logs only; callers must not forward
/// it to browsers.
pub fn probe_remote_support(endpoint: &SavedEndpoint) -> Result<(), String> {
    if !is_valid_ssh_target(&endpoint.target) {
        return Err("invalid ssh target".to_string());
    }
    let args = ssh_remote_herdr_check_args(endpoint);
    let mut command = Command::new("ssh");
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child: Child = command
        .spawn()
        .map_err(|err| format!("failed to start ssh: {err}"))?;
    let deadline = Instant::now() + Duration::from_secs(PROBE_TIMEOUT_SECONDS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                let stderr = stderr.trim();
                if status.success() && stdout.trim() == REMOTE_API_BRIDGE_CAPABILITY {
                    return Ok(());
                }
                let detail = if stderr.is_empty() {
                    format!("exit status {status}")
                } else {
                    stderr.chars().take(200).collect()
                };
                return Err(format!(
                    "remote Herdr does not support the machine api bridge ({detail})"
                ));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(PROBE_POLL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("remote machine probe timed out".to_string());
            }
            Err(err) => return Err(format!("remote machine probe failed: {err}")),
        }
    }
}

/// Runs the native `herdr machine add` registration on the bridge host.
/// Stdin is closed so a CLI that would prompt for credentials fails instead
/// of hanging the request; on failure the trimmed CLI stderr (capped) becomes
/// the operator-facing message. Success is picked up by the next
/// `MachineCatalog::load`, which the bridge performs per request.
pub fn run_machine_add(
    target: &str,
    label: Option<&str>,
    session: Option<&str>,
) -> Result<(), String> {
    run_machine_add_program(
        "herdr",
        Duration::from_secs(MACHINE_ADD_TIMEOUT_SECONDS),
        target,
        label,
        session,
    )
}

/// `run_machine_add` with an explicit program path and timeout so tests can
/// exercise child/descendant teardown against stubs instead of mutating
/// `PATH` (which would race sibling tests that spawn `ssh`).
fn run_machine_add_program(
    program: &str,
    timeout: Duration,
    target: &str,
    label: Option<&str>,
    session: Option<&str>,
) -> Result<(), String> {
    if !is_valid_ssh_target(target) {
        return Err("invalid ssh target".to_string());
    }
    // Boundary check: the web handler validates user input too, but this
    // runner is the transport edge and rejects option-like values itself.
    if let Some(label) = label {
        if !is_valid_machine_arg(label) {
            return Err("invalid machine label".to_string());
        }
    }
    if let Some(session) = session {
        if !is_valid_machine_arg(session) {
            return Err("invalid remote session".to_string());
        }
    }
    run_machine_argv(
        program,
        timeout,
        "machine add",
        &machine_add_args(target, label, session),
    )
}

/// Runs the native `herdr machine disable <PROFILE_ID>` CLI on the bridge
/// host. Stdin is closed so a CLI that would prompt for anything fails
/// instead of hanging the request; the saved profile stays in Herdr's own
/// client state (the CLI only flips its enabled flag), and on failure the
/// trimmed CLI stderr (capped) becomes the operator-facing message.
pub fn run_machine_disable(profile_id: &str) -> Result<(), String> {
    run_machine_disable_program(
        "herdr",
        Duration::from_secs(MACHINE_ADD_TIMEOUT_SECONDS),
        profile_id,
    )
}

/// `run_machine_disable` with an explicit program path and timeout so tests
/// can exercise child/descendant teardown against stubs instead of mutating
/// `PATH` (which would race sibling tests that spawn `ssh`).
fn run_machine_disable_program(
    program: &str,
    timeout: Duration,
    profile_id: &str,
) -> Result<(), String> {
    // Boundary check: the web handler resolves the id against the saved
    // catalog too, but this runner is the transport edge and rejects
    // option-like or control-bearing values itself.
    if !is_valid_machine_id(profile_id) {
        return Err("invalid machine id".to_string());
    }
    run_machine_argv(
        program,
        timeout,
        "machine disable",
        &[
            "machine".to_string(),
            "disable".to_string(),
            profile_id.to_string(),
        ],
    )
}

/// Spawns the native machine CLI as its own process-group leader and kills
/// the whole group on timeout, so an `ssh` descendant can neither keep a
/// killed registration running nor hold the stderr pipe open past the
/// deadline. `action` (for example "machine add") names the subcommand in
/// operator-facing error messages.
fn run_machine_argv(
    program: &str,
    timeout: Duration,
    action: &str,
    args: &[String],
) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        // stdout is unused: nulled so the child can never fill an undrained
        // pipe and stall before exiting; stderr drains on a thread for the
        // same reason.
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child: Child = command
        .spawn()
        .map_err(|err| format!("failed to start herdr: {err}"))?;
    let stderr = take_captured_stderr(&mut child);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(PROBE_POLL),
            Ok(None) => {
                kill_process_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                let _ = stderr.finish();
                return Err(format!("{action} timed out"));
            }
            Err(err) => {
                kill_process_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                let _ = stderr.finish();
                return Err(format!("{action} failed: {err}"));
            }
        }
    };
    let stderr = stderr.finish();
    if status.success() {
        return Ok(());
    }
    Err(if stderr.is_empty() {
        format!("{action} failed ({status})")
    } else {
        // The CLI's actionable reason sits at the end of its diagnostics.
        let skip = stderr.chars().count().saturating_sub(500);
        stderr.chars().skip(skip).take(500).collect()
    })
}

/// SIGKILLs the process group the child was spawned as leader of (the
/// machine-add CLI and the bridge ssh child both use process_group(0));
/// the group is app-owned, so the signal can never reach this process,
/// other sessions, or unrelated user processes. A group whose leader has
/// already exited may report ESRCH — a benign race, ignored here.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {}

/// Reports whether the process exited WITHOUT reaping it: waitid with
/// WNOWAIT leaves the zombie in place, so the PID stays reserved for a
/// later group signal or the final wait — a reaping check (try_wait)
/// would free the PID for reuse while the caller still acts on it.
/// si_pid stays 0 when nothing is waitable (POSIX), nonzero once the
/// process exited. Zero-init is the documented idiom: a WNOHANG miss
/// leaves the caller's zeros, which read as "not exited yet".
#[cfg(unix)]
fn leader_exited_without_reaping(pid: u32) -> bool {
    let mut siginfo: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let options = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    // ECHILD means the teardown's final wait() already reaped the leader —
    // reading "not exited" is fine, the teardown_done flag ends the loop.
    if unsafe { libc::waitid(libc::P_PID, pid, &mut siginfo, options) } != 0 {
        return false;
    }
    // glibc packs siginfo behind an accessor method; apple/bsd expose a field.
    #[cfg(target_os = "linux")]
    let matched = unsafe { siginfo.si_pid() } != 0;
    #[cfg(not(target_os = "linux"))]
    let matched = siginfo.si_pid != 0;
    matched
}

/// Bounds stderr collection: capture keeps only the latest bytes (the CLI's
/// diagnostics put the reason last) but draining never stops while the CLI
/// runs — a chatty child must never block on a full pipe. Once the CLI has
/// exited, a short grace collects its final output; an ssh descendant that
/// still holds the pipe open then stops delaying the handler.
struct CapturedStderr {
    cli_exited: Arc<AtomicBool>,
    receiver: std::sync::mpsc::Receiver<String>,
}

impl CapturedStderr {
    fn finish(self) -> String {
        self.cli_exited.store(true, Ordering::Relaxed);
        self.receiver
            .recv_timeout(STDERR_WAIT)
            .map(|stderr| stderr.trim().to_string())
            .unwrap_or_default()
    }
}

fn take_captured_stderr(child: &mut Child) -> CapturedStderr {
    let Some(stderr_pipe) = child.stderr.take() else {
        return CapturedStderr {
            cli_exited: Arc::new(AtomicBool::new(true)),
            receiver: std::sync::mpsc::channel().1,
        };
    };
    // A std File owns the same pipe fd and closes it on drop; ChildStderr
    // cannot be switched to nonblocking reads directly.
    #[cfg(unix)]
    let mut pipe = {
        use std::os::unix::io::{FromRawFd, IntoRawFd};
        // Safe: the ChildStderr is consumed, so the fd is owned exactly once.
        let fd = stderr_pipe.into_raw_fd();
        unsafe { std::fs::File::from_raw_fd(fd) }
    };
    #[cfg(not(unix))]
    let mut pipe = stderr_pipe;
    let cli_exited = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = std::sync::mpsc::channel();
    let flag = Arc::clone(&cli_exited);
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let fd = pipe.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL, 0) };
            if flags >= 0 {
                unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
            }
        }
        let mut captured: Vec<u8> = Vec::new();
        let mut chunk = [0u8; STDERR_DRAIN_CHUNK_BYTES];
        let mut drained_since: Option<Instant> = None;
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if captured.len() + n > MACHINE_ADD_STDERR_CAP_BYTES {
                        let excess = captured.len() + n - MACHINE_ADD_STDERR_CAP_BYTES;
                        captured.drain(..excess.min(captured.len()));
                    }
                    captured.extend_from_slice(&chunk[..n]);
                    drained_since = None;
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if flag.load(Ordering::Relaxed) {
                        let since = *drained_since.get_or_insert(Instant::now());
                        if since.elapsed() >= STDERR_DRAIN_GRACE {
                            break;
                        }
                    }
                    std::thread::sleep(PROBE_POLL);
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(String::from_utf8_lossy(&captured).into_owned());
    });
    CapturedStderr {
        cli_exited,
        receiver,
    }
}

/// Default machine socket root: the app-owned state root
/// (`$XDG_STATE_HOME/herdr-web/machines`, else
/// `$HOME/.local/state/herdr-web/machines`). Never a shared world-writable
/// directory such as `/tmp`; with neither variable set the manager fails
/// closed instead of guessing.
pub fn default_machine_socket_dir() -> io::Result<PathBuf> {
    if let Some(path) = crate::store_util::non_empty_env_path(MACHINE_SOCKET_DIR_ENV_VAR) {
        return Ok(path);
    }
    default_machine_socket_dir_from(
        crate::store_util::non_empty_env_path("XDG_STATE_HOME"),
        crate::store_util::non_empty_env_path("HOME"),
    )
    .ok_or_else(|| {
        io::Error::other(
            "no safe default machine socket directory: set HOME or HERDR_WEB_MACHINE_SOCKET_DIR",
        )
    })
}

fn default_machine_socket_dir_from(
    state_home: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(state_home) = state_home.filter(|path| path.is_absolute()) {
        return Some(state_home.join("herdr-web").join("machines"));
    }
    let home = home.filter(|path| path.is_absolute())?;
    Some(
        home.join(".local")
            .join("state")
            .join("herdr-web")
            .join("machines"),
    )
}

/// Creates and validates a private machine-socket directory.
///
/// Every component is created with `mkdir(2)` mode 0700 (atomic private
/// creation; a umask can only remove bits) — never `create_dir_all` + chmod,
/// which follows a pre-planted symlink. Existing components are
/// lstat-validated: no symlinks anywhere on the path, current-euid
/// ownership, no world-writable component, and the final directory must be
/// exactly 0700. Unsafe roots fail closed.
#[cfg(unix)]
pub(crate) fn ensure_machine_dir(path: &Path) -> io::Result<()> {
    let total = path.components().count();
    if total == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "machine socket directory must be an absolute path",
        ));
    }
    let mut current = PathBuf::new();
    for (index, component) in path.components().enumerate() {
        match component {
            std::path::Component::RootDir => {
                current.push("/");
                continue;
            }
            std::path::Component::Normal(part) => current.push(part),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "machine socket directory must be an absolute path without `.` components",
                ));
            }
        }
        match mkdir_private(&current) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
        let is_final = index + 1 == total;
        validate_machine_component(&current, is_final)?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn ensure_machine_dir(path: &Path) -> io::Result<()> {
    crate::store_util::ensure_private_dir(path)
}

/// `mkdir(2)` with mode 0700 — creation and privacy are one atomic step.
#[cfg(unix)]
fn mkdir_private(path: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt as _;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    if unsafe { libc::mkdir(c_path.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn validate_machine_component(path: &Path, require_exactly_private: bool) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let metadata = std::fs::symlink_metadata(path).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("machine socket path component unreadable: {path:?}"),
        )
    })?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(io::Error::other(format!(
            "machine socket path component must not be a symlink: {path:?}"
        )));
    }
    if !file_type.is_dir() {
        return Err(io::Error::other(format!(
            "machine socket path component is not a directory: {path:?}"
        )));
    }
    let euid = unsafe { libc::geteuid() };
    if metadata.uid() != euid {
        return Err(io::Error::other(format!(
            "machine socket path component is not owned by the current user: {path:?}"
        )));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o002 != 0 {
        return Err(io::Error::other(format!(
            "machine socket path component is world-writable: {path:?}"
        )));
    }
    if require_exactly_private && mode & 0o077 != 0 {
        return Err(io::Error::other(format!(
            "machine socket directory must be mode 0700: {path:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn farm_endpoint() -> SavedEndpoint {
        SavedEndpoint {
            id: "0123456789abcdef0123456789abcdef".to_string(),
            label: "farm".to_string(),
            target: "root@198.51.100.20".to_string(),
            session: "default".to_string(),
            enabled: true,
        }
    }

    fn unique_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herdr-web-machines-test-{name}-{}",
            crate::store_util::now_ms_string()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_endpoints(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("endpoints.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn catalog_lists_local_first_then_enabled_ssh_machines() {
        let dir = unique_dir("list");
        let path = write_endpoints(
            &dir,
            r#"{
                "version": 1,
                "ssh": [
                    {"id": "0123456789abcdef0123456789abcdef", "label": "farm", "target": "root@198.51.100.20", "session": "default", "enabled": true},
                    {"id": "11111111111111111111111111111111", "label": "offhost", "target": "root@10.9.9.9", "session": "default", "enabled": false}
                ]
            }"#,
        );

        let catalog = MachineCatalog::load_from(&path);

        let machines = catalog.machines();
        assert_eq!(machines.len(), 2, "local + enabled ssh machines only");
        assert_eq!(
            machines[0],
            MachineEntry {
                id: LOCAL_MACHINE_ID.to_string(),
                label: "Local".to_string(),
                kind: MachineKind::Local,
            }
        );
        assert_eq!(
            machines[1],
            MachineEntry {
                id: "0123456789abcdef0123456789abcdef".to_string(),
                label: "farm".to_string(),
                kind: MachineKind::Ssh,
            }
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_or_corrupt_catalog_yields_local_only() {
        let dir = unique_dir("corrupt");
        let missing = dir.join("absent.json");
        assert_eq!(MachineCatalog::load_from(&missing).machines().len(), 1);

        let corrupt = write_endpoints(&dir, "{not json");
        assert_eq!(MachineCatalog::load_from(&corrupt).machines().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_distinguishes_local_unknown_and_disabled() {
        let dir = unique_dir("resolve");
        let path = write_endpoints(
            &dir,
            r#"{
                "version": 1,
                "ssh": [
                    {"id": "0123456789abcdef0123456789abcdef", "label": "farm", "target": "root@198.51.100.20", "session": "default", "enabled": true},
                    {"id": "11111111111111111111111111111111", "label": "offhost", "target": "root@10.9.9.9", "session": "default", "enabled": false}
                ]
            }"#,
        );
        let catalog = MachineCatalog::load_from(&path);

        assert_eq!(
            catalog.resolve(LOCAL_MACHINE_ID),
            Ok(ResolvedMachine::Local)
        );
        assert_eq!(
            catalog.resolve("0123456789abcdef0123456789abcdef"),
            Ok(ResolvedMachine::Ssh(farm_endpoint()))
        );
        assert_eq!(
            catalog.resolve("deadbeefdeadbeefdeadbeefdeadbeef"),
            Err(MachineError::Unknown(
                "deadbeefdeadbeefdeadbeefdeadbeef".to_string()
            ))
        );
        assert_eq!(
            catalog.resolve("11111111111111111111111111111111"),
            Err(MachineError::Disabled(
                "11111111111111111111111111111111".to_string()
            ))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn machine_ids_are_restricted_to_hex() {
        assert!(is_valid_machine_id(LOCAL_MACHINE_ID));
        assert!(is_valid_machine_id("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_machine_id(""));
        assert!(!is_valid_machine_id("../etc/passwd"));
        assert!(!is_valid_machine_id("farm; rm -rf /"));
        assert!(!is_valid_machine_id("UPPER-CASE"));
    }

    // Manual live-farm transport check; run explicitly with:
    //   cargo test --manifest-path bridge/Cargo.toml --bin herdr-web-bridge machines::tests::live_farm_ssh_state_transports_api -- --ignored --nocapture
    #[ignore = "requires the real saved farm machine and network access"]
    #[test]
    fn live_farm_ssh_state_transports_api() {
        let catalog = MachineCatalog::load();
        let farm = catalog
            .machines()
            .into_iter()
            .find(|machine| machine.kind == MachineKind::Ssh)
            .expect("no saved ssh machine configured");
        let resolved = catalog.resolve(&farm.id).expect("farm must resolve");
        let ResolvedMachine::Ssh(endpoint) = resolved else {
            panic!("farm resolved as non-ssh");
        };

        let manager = MachineManager::new().unwrap();
        let state = manager.ssh_state(&endpoint).expect("farm ssh state");

        use herdr_compat::api::client::ApiClient;
        use herdr_compat::api::schema::{EmptyParams, Method, Request};
        let api: &ApiClient = &state.api;
        let response = api
            .request(Request {
                id: "machines-live-test".to_string(),
                method: Method::SessionSnapshot(EmptyParams::default()),
            })
            .expect("farm snapshot over the ssh bridge");
        let snapshot = match response.result {
            herdr_compat::api::schema::ResponseResult::SessionSnapshot { snapshot } => *snapshot,
            other => panic!("unexpected farm response: {other:?}"),
        };
        assert!(
            !snapshot.workspaces.is_empty(),
            "farm snapshot must list workspaces"
        );
        eprintln!(
            "farm workspaces: {:?}",
            snapshot
                .workspaces
                .iter()
                .map(|workspace| workspace.label.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn machine_add_args_build_plain_argv_with_optional_flags() {
        assert_eq!(
            machine_add_args("root@198.51.100.20", Some("farm"), Some("gpu")),
            vec![
                "machine".to_string(),
                "add".to_string(),
                "root@198.51.100.20".to_string(),
                "--label".to_string(),
                "farm".to_string(),
                "--remote-session".to_string(),
                "gpu".to_string(),
            ]
        );
        assert_eq!(
            machine_add_args("root@host", None, None),
            vec![
                "machine".to_string(),
                "add".to_string(),
                "root@host".to_string()
            ]
        );
    }

    #[test]
    fn machine_arg_validation_rejects_option_like_and_control_values() {
        assert!(is_valid_machine_arg("farm"));
        assert!(is_valid_machine_arg("gpu-session"));
        assert!(!is_valid_machine_arg(""));
        assert!(!is_valid_machine_arg("-oProxyCommand=x"));
        assert!(!is_valid_machine_arg("farm\n"));
    }

    #[test]
    fn machine_add_runner_rejects_bad_values_without_spawning() {
        assert_eq!(
            run_machine_add("-oProxyCommand=x", None, None),
            Err("invalid ssh target".to_string())
        );
        assert_eq!(
            run_machine_add("root@host", Some("-label"), None),
            Err("invalid machine label".to_string())
        );
        assert_eq!(
            run_machine_add("root@host", None, Some("bad\nsession")),
            Err("invalid remote session".to_string())
        );
        assert_eq!(
            run_machine_disable("-oProxyCommand=x"),
            Err("invalid machine id".to_string())
        );
        assert_eq!(
            run_machine_disable("bad id"),
            Err("invalid machine id".to_string())
        );
    }

    /// Spawns a stub CLI via an explicit program path so the runner's argv,
    /// success path, and failure stderr handling are checked against a real
    /// child process without touching the real CLI, network, PATH, or
    /// saved-machine state.
    #[cfg(unix)]
    #[test]
    fn machine_add_runner_uses_native_cli_argv_and_reports_cli_stderr() {
        use std::os::unix::fs::PermissionsExt;

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("herdr-web-machine-add-{unique}"));
        std::fs::create_dir_all(&root).unwrap();
        let args_log = root.join("args.log");
        let script = root.join("herdr-stub.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> {args_log:?}\n\
                 case \"$3\" in\n  \
                 *@fail*)\n    \
                 ( sleep 30 ) >&2 &\n    \
                 head -c 200000 /dev/zero | tr '\\0' x >&2\n    \
                 echo boom >&2\n    \
                 exit 3\nesac\n\
                 exit 0\n"
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        let program = script.to_str().unwrap();

        // Warm-up: exec'ing a just-written script can transiently fail with
        // ETXTBSY on overlayfs while sibling stub tests run in parallel
        // (see machine_disable_runner). A spawn failure never reaches the
        // stub, so the args log still receives exactly one append.
        for _ in 0..40 {
            match run_machine_add_program(
                program,
                Duration::from_secs(MACHINE_ADD_TIMEOUT_SECONDS),
                "root@198.51.100.20",
                Some("farm"),
                Some("gpu"),
            ) {
                Ok(()) => break,
                Err(message) if message.contains("Text file busy") => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(message) => panic!("unexpected stub failure: {message}"),
            }
        }
        let recorded = std::fs::read_to_string(&args_log).unwrap();
        assert_eq!(
            recorded,
            "machine\nadd\nroot@198.51.100.20\n--label\nfarm\n--remote-session\ngpu\n"
        );

        // Failure with a descendant holding stderr open: the operator-facing
        // message keeps the CLI's own tail, stays capped, and the runner does
        // NOT wait for the 30 s descendant. The stub keys its failure off the
        // target argv (no environment mutation: setenv races sibling threads
        // that read process env concurrently).
        let started = Instant::now();
        let mut attempts = 0;
        let error = loop {
            match run_machine_add_program(
                program,
                Duration::from_secs(MACHINE_ADD_TIMEOUT_SECONDS),
                "root@fail.test",
                None,
                None,
            ) {
                Err(error) if error.contains("Text file busy") => {
                    attempts += 1;
                    assert!(
                        attempts <= 40,
                        "stub stayed busy (ETXTBSY) after 40 attempts"
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => break error,
                Ok(()) => panic!("stub reported success for the failure profile"),
            }
        };
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "runner waited on the descendant: {:?}",
            started.elapsed()
        );
        assert!(error.contains("boom"), "stderr tail missing: {error}");
        assert!(error.len() < 200_000, "stderr was not capped: {error}");
    }

    /// The disable runner invokes the native CLI as a plain argv vector
    /// (`machine disable <PROFILE_ID>`), keeps the CLI's own stderr tail as
    /// the operator-facing message, and does not wait on a descendant that
    /// holds stderr open — all against a stub program, never the real CLI
    /// or a saved profile.
    #[cfg(unix)]
    #[test]
    fn machine_disable_runner_uses_native_cli_argv_and_reports_cli_stderr() {
        use std::os::unix::fs::PermissionsExt;

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("herdr-web-machine-disable-{unique}"));
        std::fs::create_dir_all(&root).unwrap();
        let args_log = root.join("args.log");
        let script = root.join("herdr-stub.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> {args_log:?}\n\
                 case \"$3\" in\n  \
                 bad0*)\n    \
                 ( sleep 30 ) >&2 &\n    \
                 echo boom >&2\n    \
                 exit 3\nesac\n\
                 exit 0\n"
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        let program = script.to_str().unwrap();

        // Warm-up: exec'ing a just-written script can transiently fail with
        // ETXTBSY on overlayfs while sibling stub tests run in parallel;
        // retry briefly before the assertions care about the result.
        for _ in 0..40 {
            match run_machine_disable_program(
                program,
                Duration::from_secs(MACHINE_ADD_TIMEOUT_SECONDS),
                "cafe1234",
            ) {
                Ok(()) => break,
                Err(message) if message.contains("Text file busy") => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(message) => panic!("unexpected stub failure: {message}"),
            }
        }
        let _ = std::fs::remove_file(&args_log);

        // Success: the CLI receives exactly `machine disable <PROFILE_ID>`.
        assert_eq!(
            run_machine_disable_program(
                program,
                Duration::from_secs(MACHINE_ADD_TIMEOUT_SECONDS),
                "cafe1234"
            ),
            Ok(())
        );
        let recorded = std::fs::read_to_string(&args_log).unwrap();
        assert_eq!(recorded, "machine\ndisable\ncafe1234\n");

        // Failure: the operator-facing message keeps the CLI's tail and the
        // runner does NOT wait for the 30 s descendant. The stub keys its
        // failure off the profile id argv (no environment mutation).
        let started = Instant::now();
        let mut attempts = 0;
        let error = loop {
            match run_machine_disable_program(
                program,
                Duration::from_secs(MACHINE_ADD_TIMEOUT_SECONDS),
                "bad0face",
            ) {
                Err(error) if error.contains("Text file busy") => {
                    attempts += 1;
                    assert!(
                        attempts <= 40,
                        "stub stayed busy (ETXTBSY) after 40 attempts"
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => break error,
                Ok(()) => panic!("stub reported success for the failure profile"),
            }
        };
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "runner waited on the descendant: {:?}",
            started.elapsed()
        );
        assert!(error.contains("boom"), "stderr tail missing: {error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A wedged CLI must be torn down together with any descendants it
    /// spawned (same app-owned process group), so a killed registration
    /// cannot keep running in the background.
    #[cfg(unix)]
    #[test]
    fn machine_add_timeout_kills_the_cli_process_group() {
        use std::os::unix::fs::PermissionsExt;

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("herdr-web-machine-add-timeout-{unique}"));
        std::fs::create_dir_all(&root).unwrap();
        let bg_pid_log = root.join("bg.pid");
        let script = root.join("herdr-stub.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n( sleep 30 ) &\necho $! > {bg_pid_log:?}\n\
                 echo holding stderr >&2\nsleep 60\n"
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let started = Instant::now();
        // ETXTBSY warm-up (see machine_disable_runner): spawn failures fail
        // instantly, so only the real run pays the 1 s timeout.
        let mut attempts = 0;
        let error = loop {
            match run_machine_add_program(
                script.to_str().unwrap(),
                Duration::from_secs(1),
                "root@host",
                None,
                None,
            ) {
                Err(error) if error.contains("Text file busy") => {
                    attempts += 1;
                    assert!(
                        attempts <= 40,
                        "stub stayed busy (ETXTBSY) after 40 attempts"
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => break error,
                Ok(()) => panic!("stub reported success for the timeout profile"),
            }
        };
        assert_eq!(error, "machine add timed out");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "timeout path was slow: {:?}",
            started.elapsed()
        );

        // The background descendant shared the app-owned process group and
        // must be gone (or a zombie awaiting reaping) shortly after.
        let bg_pid: i32 = std::fs::read_to_string(&bg_pid_log)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let alive = unsafe { libc::kill(bg_pid, 0) } == 0
                && !std::fs::read_to_string(format!("/proc/{bg_pid}/stat"))
                    .map(|stat| stat.contains('Z'))
                    .unwrap_or(true);
            if !alive || Instant::now() > deadline {
                assert!(
                    !alive,
                    "descendant survived the process-group kill: {bg_pid}"
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn ssh_args_are_shell_free_vectors_with_conditional_session_flag() {
        let default_session = farm_endpoint();
        assert_eq!(
            ssh_remote_herdr_args(&default_session, REMOTE_API_BRIDGE_COMMAND),
            vec![
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=2",
                "root@198.51.100.20",
                "herdr",
                "remote-api-bridge",
            ]
        );

        let mut named_session = farm_endpoint();
        named_session.session = "work".to_string();
        assert_eq!(
            ssh_remote_herdr_args(&named_session, REMOTE_CLIENT_BRIDGE_COMMAND),
            vec![
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=2",
                "root@198.51.100.20",
                "herdr",
                "--session",
                "work",
                "remote-client-bridge",
            ]
        );

        assert_eq!(
            ssh_remote_herdr_check_args(&default_session)
                .last()
                .map(String::as_str),
            Some("--check")
        );
        assert_eq!(
            ssh_remote_herdr_check_args(&default_session)
                .iter()
                .filter(|arg| *arg == &default_session.target)
                .count(),
            1,
            "the saved target must appear exactly once as a single argv entry"
        );
    }

    // -----------------------------------------------------------------
    // Stage-1 corrective regressions (safety + liveness)
    // -----------------------------------------------------------------

    fn hex_id(n: u64) -> String {
        format!("{n:032x}")
    }

    fn test_endpoint(id: &str, target: &str) -> SavedEndpoint {
        SavedEndpoint {
            id: id.to_string(),
            label: "testlab".to_string(),
            target: target.to_string(),
            session: "default".to_string(),
            enabled: true,
        }
    }

    fn test_home() -> Option<PathBuf> {
        crate::store_util::non_empty_env_path("HOME")
    }

    /// Private test root under HOME (never /tmp — the validator must accept
    /// every component of the path, and /tmp is world-writable by design).
    fn home_test_root(name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let home = test_home().expect("HOME required for machine dir tests");
        // Keep the absolute socket path well under sun_path (108 bytes).
        let root = home
            .join(".hw-mt")
            .join(format!("{name}-{}", crate::store_util::now_ms_string()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    fn ok_probe() -> ProbeFn {
        Arc::new(|_: &SavedEndpoint| Ok(()))
    }

    fn counting_probe(calls: Arc<AtomicUsize>, fail: bool) -> ProbeFn {
        Arc::new(move |_: &SavedEndpoint| {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            if fail {
                Err(format!("probe detail SECRET-ssh-stderr-{n}"))
            } else {
                Ok(())
            }
        })
    }

    fn manager_with(config: MachineManagerConfig) -> MachineManager {
        MachineManager::with_config(config).expect("test manager")
    }

    // P1: default socket dir must be the app-owned state root, never /tmp,
    // and must fail closed with no HOME.
    #[test]
    fn default_socket_dir_is_app_owned_state_root_never_shared_temp() {
        assert_eq!(
            default_machine_socket_dir_from(None, Some(PathBuf::from("/root"))),
            Some(PathBuf::from("/root/.local/state/herdr-web/machines"))
        );
        assert_eq!(
            default_machine_socket_dir_from(Some(PathBuf::from("/var/lib/xdg-state")), None),
            Some(PathBuf::from("/var/lib/xdg-state/herdr-web/machines"))
        );
        assert_eq!(
            default_machine_socket_dir_from(None, None),
            None,
            "fail closed when no state root is known"
        );
        let computed = default_machine_socket_dir_from(None, test_home()).expect("HOME set");
        assert!(
            !computed.starts_with("/tmp"),
            "default must never live in the shared temp dir: {computed:?}"
        );
        assert_ne!(
            computed,
            PathBuf::from("/tmp").join(format!("herdr-web-machines-{}", std::process::id())),
            "predictable /tmp/herdr-web-machines-PID is forbidden"
        );
    }

    // P1: refuse planted symlinks, foreign owners, unsafe modes, and
    // world-writable roots.
    #[test]
    fn machine_dir_validation_rejects_planted_symlinks_foreign_owners_and_bad_modes() {
        use std::os::unix::fs::{chown, PermissionsExt as _};
        let Some(home) = test_home() else {
            eprintln!("skipping: HOME unset");
            return;
        };
        let root = home.join(format!(
            ".local/state/herdr-web-machines-validate-{}",
            crate::store_util::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();

        // Happy path: nested components are created 0700.
        let fresh = root.join("a/b");
        ensure_machine_dir(&fresh).expect("creates nested private dirs");
        let mode = std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "created dirs must be exactly 0700");

        // Planted symlink at the final component.
        let link = root.join("link");
        std::os::unix::fs::symlink(&fresh, &link).unwrap();
        assert!(
            ensure_machine_dir(&link).is_err(),
            "a symlinked machine dir must be refused"
        );

        // Foreign owner.
        let foreign = root.join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        if chown(&foreign, Some(1), None).is_ok() {
            assert!(
                ensure_machine_dir(&foreign).is_err(),
                "a machine dir owned by another uid must be refused"
            );
            let _ = chown(&foreign, Some(unsafe { libc::geteuid() }), None);
        } else {
            eprintln!("skipping foreign-owner case: not permitted to chown");
        }

        // Unsafe mode on the final dir (group/other bits present).
        let loose = root.join("loose");
        std::fs::create_dir(&loose).unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            ensure_machine_dir(&loose).is_err(),
            "non-0700 machine dir must be refused"
        );

        // World-writable intermediate.
        let wwide = root.join("wwide");
        std::fs::create_dir(&wwide).unwrap();
        std::fs::set_permissions(&wwide, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(
            ensure_machine_dir(&wwide.join("child")).is_err(),
            "world-writable parent must be refused"
        );

        // The shared temp dir itself is an unsafe root.
        assert!(
            ensure_machine_dir(Path::new("/tmp/herdr-web-machines-must-refuse")).is_err(),
            "/tmp must be refused as a machine socket root"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // P2: one blocked probe must not stall other machines or local routing.
    #[test]
    fn blocked_probe_for_one_machine_does_not_stall_other_machines_or_local() {
        let (farm_probe_started_tx, farm_probe_started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = std::sync::Mutex::new(release_rx);
        let probe: ProbeFn = Arc::new(move |endpoint: &SavedEndpoint| {
            if endpoint.target.contains("unreachable") {
                let _ = farm_probe_started_tx.send(());
                // Deterministic stand-in for an unreachable farm: the probe
                // blocks until the test releases it (no real ssh wait).
                // (Receiver is !Sync; only the gated farm path ever receives.)
                let Ok(release) = release_rx.lock() else {
                    return Err("probe latch poisoned".to_string());
                };
                let _ = release.recv();
                drop(release);
                Err("probe detail SECRET-ssh-stderr".to_string())
            } else {
                Ok(())
            }
        });
        let manager = Arc::new(manager_with(MachineManagerConfig {
            probe,
            socket_dir: Some(home_test_root("bp")),
            ..MachineManagerConfig::default()
        }));

        let stuck_manager = Arc::clone(&manager);
        let stuck_endpoint = test_endpoint(&hex_id(1), "root@unreachable.invalid");
        let stuck = std::thread::spawn(move || stuck_manager.ssh_state(&stuck_endpoint));
        farm_probe_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("farm probe started");

        // While the farm probe is blocked, a different machine resolves fine…
        let other = test_endpoint(&hex_id(2), "root@198.51.100.20");
        let other_state = manager
            .ssh_state(&other)
            .expect("an unrelated machine must resolve while the farm probe blocks");
        // …and local routing never touches the machine manager at all.
        assert_eq!(
            manager.catalog().resolve(LOCAL_MACHINE_ID),
            Ok(ResolvedMachine::Local)
        );
        drop(other_state);

        let _ = release_tx.send(());
        let err = stuck
            .join()
            .unwrap()
            .err()
            .expect("unreachable machine must fail closed");
        assert!(err.contains("unavailable"), "generic message: {err}");
        assert!(!err.contains("SECRET"), "probe detail must not leak: {err}");
    }

    // P2: concurrent requests for the same machine share exactly one probe.
    #[test]
    fn concurrent_same_machine_requests_share_one_probe() {
        let calls = Arc::new(AtomicUsize::new(0));
        let manager = Arc::new(manager_with(MachineManagerConfig {
            probe: counting_probe(Arc::clone(&calls), false),
            socket_dir: Some(home_test_root("cs")),
            ..MachineManagerConfig::default()
        }));
        let endpoint = test_endpoint(&hex_id(3), "root@198.51.100.20");
        let mut handles = Vec::new();
        for _ in 0..3 {
            let manager = Arc::clone(&manager);
            let endpoint = endpoint.clone();
            handles.push(std::thread::spawn(move || {
                manager
                    .ssh_state(&endpoint)
                    .map(|state| state.client_socket_path.clone())
            }));
        }
        let paths: Vec<PathBuf> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().expect("shared bridge"))
            .collect();
        assert!(
            paths.windows(2).all(|pair| pair[0] == pair[1]),
            "all callers share one bridge: {paths:?}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "exactly one probe for concurrent same-machine requests"
        );
    }

    // P2: failed probes are negatively cached with a short TTL.
    #[test]
    fn failed_probe_is_negative_cached_then_expires_after_ttl() {
        let calls = Arc::new(AtomicUsize::new(0));
        let manager = manager_with(MachineManagerConfig {
            probe: counting_probe(Arc::clone(&calls), true),
            negative_cache_ttl: Duration::from_millis(60),
            socket_dir: Some(home_test_root("nc")),
            ..MachineManagerConfig::default()
        });
        let endpoint = test_endpoint(&hex_id(4), "root@198.51.100.20");

        let first = manager.ssh_state(&endpoint).err().expect("fails closed");
        assert!(first.contains("unavailable"), "generic message: {first}");
        assert!(!first.contains("SECRET"), "no probe detail to clients");

        let _ = manager.ssh_state(&endpoint).err().expect("still failing");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "failure is cached: no immediate re-probe"
        );

        std::thread::sleep(Duration::from_millis(120));
        let _ = manager.ssh_state(&endpoint).err().expect("still failing");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "ttl expiry allows a fresh probe"
        );
    }

    // P3 stale routing: a changed target for the same id must not reuse the
    // old bridge, and the old sockets must be released safely.
    #[test]
    fn endpoint_change_for_same_id_evicts_stale_bridge_and_moves_sockets() {
        let manager = manager_with(MachineManagerConfig {
            probe: ok_probe(),
            socket_dir: Some(home_test_root("ec")),
            ..MachineManagerConfig::default()
        });
        let mut endpoint = test_endpoint(&hex_id(5), "root@198.51.100.20");
        let state_a = manager.ssh_state(&endpoint).expect("bridge for target A");
        let path_a = state_a.client_socket_path.clone();
        assert!(path_a.exists(), "target A socket bound");

        endpoint.target = "root@10.0.0.221".to_string();
        let state_b = manager.ssh_state(&endpoint).expect("bridge for target B");
        assert_ne!(
            state_b.client_socket_path, path_a,
            "a changed endpoint must not reuse the stale bridge sockets"
        );
        assert!(state_b.client_socket_path.exists());

        drop(state_a);
        assert!(
            !path_a.exists(),
            "old bridge sockets must be unlinked once released"
        );
        assert!(
            state_b.client_socket_path.exists(),
            "live successor sockets must survive the stale cleanup"
        );
    }

    // P3 resource bound: permits enforce the ceiling and guards release.
    #[test]
    fn connection_permits_enforce_bound_and_release() {
        let permits = ConnectionPermits::new(2);
        assert!(permits.try_acquire());
        assert!(permits.try_acquire());
        assert_eq!(permits.current(), 2);
        assert!(!permits.try_acquire(), "bound must hold");
        permits.release();
        assert!(permits.try_acquire());
        permits.release();
        permits.release();
        assert_eq!(permits.current(), 0);

        assert!(permits.try_acquire(), "guard pairing starts with acquire");
        let guard = PermitGuard(permits.clone());
        assert_eq!(permits.current(), 1);
        drop(guard);
        assert_eq!(permits.current(), 0, "guard releases on drop");
    }

    // P3 resource bound: an over-limit bridge connection is dropped, not
    // served with another ssh child.
    #[test]
    fn bridge_accepts_at_most_permitted_connections() {
        let permits = ConnectionPermits::new(1);
        // Unroutable target: the first ssh child stays inside its connect
        // timeout, holding the only permit for the duration of the check.
        let endpoint = test_endpoint(&hex_id(6), "root@10.255.255.1");
        let root = home_test_root("pb");
        let bridge =
            SshSocketBridge::start(&endpoint, &root, BridgeKind::Api, permits.clone(), "ssh")
                .unwrap();
        let socket_path = bridge.path.clone();

        let first = std::os::unix::net::UnixStream::connect(&socket_path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while permits.current() != 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(permits.current(), 1, "first connection holds the permit");

        let mut second = std::os::unix::net::UnixStream::connect(&socket_path).unwrap();
        second
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut byte = [0u8; 1];
        let read = second.read(&mut byte);
        assert!(
            matches!(read, Ok(0)),
            "over-limit connection must be dropped (EOF), got {read:?}"
        );

        drop(first);
        drop(second);
        drop(bridge);
        assert!(!socket_path.exists(), "socket removed on drop");
        let _ = std::fs::remove_dir_all(&root);
    }

    // A4 permit release: when the ssh child dies, a still-connected but
    // silent local peer must get EOF and the connection permit back.
    #[test]
    fn bridge_releases_permit_and_signals_eof_when_ssh_child_dies() {
        let permits = ConnectionPermits::new(1);
        // Nothing speaks ssh on loopback in the test environment, so the child
        // exits immediately (connection refused) instead of timing out.
        let endpoint = test_endpoint(&hex_id(7), "root@127.0.0.1");
        let root = home_test_root("pk");
        let bridge =
            SshSocketBridge::start(&endpoint, &root, BridgeKind::Api, permits.clone(), "ssh")
                .unwrap();
        let socket_path = bridge.path.clone();

        let mut client = std::os::unix::net::UnixStream::connect(&socket_path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while permits.current() != 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            permits.current(),
            1,
            "connection holds the permit while ssh runs"
        );

        client
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut byte = [0u8; 1];
        let read = client.read(&mut byte);
        assert!(
            matches!(read, Ok(0)),
            "dead ssh child must surface as EOF to the local peer, got {read:?}"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.current() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            permits.current(),
            0,
            "permit must be released once the ssh child died"
        );

        drop(client);
        drop(bridge);
        let _ = std::fs::remove_dir_all(&root);
    }

    // A5 permit release: a local client that closed its connection must not
    // keep a permit held by an ssh child that ignores stdin EOF and stays
    // silent — the child is torn down once the client is gone for good.
    // No local client in this codebase half-closes (API requests drop the
    // stream, terminal detach shuts down both directions), so EOF on the
    // client socket means the session is dead.
    #[cfg(unix)]
    #[test]
    fn bridge_releases_permit_when_client_leaves_and_ssh_ignores_stdin_eof() {
        use std::os::unix::fs::PermissionsExt;

        let permits = ConnectionPermits::new(1);
        // The stub ignores stdin EOF and stays silent: it exits immediately
        // for the warm-up argument, otherwise it sleeps far past the test
        // deadline (a real herdr server can keep an ssh child alive like
        // this after the local client disconnects). `exec` keeps it a single
        // process owning stdout, like a real ssh child, so killing it closes
        // the pipe instead of leaving a descendant holding it open.
        let endpoint = test_endpoint(&hex_id(9), "root@127.0.0.1");
        let root = home_test_root("pl");
        let script = root.join("fake-ssh.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n[ \"$1\" = warmup ] && exit 0\nexec sleep 30\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        // ETXTBSY warm-up (see machine_disable_runner): exec the just-written
        // stub until the overlayfs window passes, so the bridge's own spawn
        // below is proven good and cannot silently shortcut the scenario.
        for _ in 0..40 {
            match std::process::Command::new(&script).arg("warmup").status() {
                Ok(status) if status.success() => break,
                Err(err) if err.to_string().contains("Text file busy") => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                other => panic!("warmup failed: {other:?}"),
            }
        }
        let bridge = SshSocketBridge::start(
            &endpoint,
            &root,
            BridgeKind::Api,
            permits.clone(),
            script.to_str().unwrap(),
        )
        .unwrap();
        let socket_path = bridge.path.clone();

        let client = std::os::unix::net::UnixStream::connect(&socket_path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.current() != 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(permits.current(), 1, "connection must hold the permit");

        // The client is gone for good: the silent ssh child must be torn
        // down and the permit released promptly, not after its 30 s sleep.
        drop(client);
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.current() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            permits.current(),
            0,
            "permit must be released once the local client closed"
        );

        drop(bridge);
        let _ = std::fs::remove_dir_all(&root);
    }

    // Wave-3 teardown: `Child::kill` only signals the ssh leader itself, so
    // ssh descendants would survive the teardown and keep running after the
    // connection permit is released. The stub spawns a long-lived
    // grandchild to stand in for a ProxyCommand helper / forwarded helper.
    #[cfg(unix)]
    #[test]
    fn bridge_teardown_kills_grandchildren_when_client_leaves() {
        use std::os::unix::fs::PermissionsExt;

        let permits = ConnectionPermits::new(1);
        let endpoint = test_endpoint(&hex_id(11), "root@127.0.0.1");
        let root = home_test_root("pg");
        let script = root.join("fake-ssh.sh");
        let pid_file = root.join("grandchild.pid");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n[ \"$1\" = warmup ] && exit 0\nsleep 300 & echo $! > {}\nsleep 30\n",
                pid_file.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        // ETXTBSY warm-up (see machine_disable_runner): exec the just-written
        // stub until the overlayfs window passes, so the bridge's own spawn
        // below is proven good and cannot silently shortcut the scenario.
        for _ in 0..40 {
            match std::process::Command::new(&script).arg("warmup").status() {
                Ok(status) if status.success() => break,
                Err(err) if err.to_string().contains("Text file busy") => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                other => panic!("warmup failed: {other:?}"),
            }
        }
        let bridge = SshSocketBridge::start(
            &endpoint,
            &root,
            BridgeKind::Api,
            permits.clone(),
            script.to_str().unwrap(),
        )
        .unwrap();
        let socket_path = bridge.path.clone();

        let client = std::os::unix::net::UnixStream::connect(&socket_path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.current() != 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(permits.current(), 1, "connection must hold the permit");
        let grandchild_pid: i32 = {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = text.trim().parse() {
                        break pid;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "fake ssh never wrote its grandchild pid"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        assert!(
            process_alive(grandchild_pid),
            "grandchild must be alive before the client leaves"
        );

        // The client is gone for good: the whole ssh process group — not
        // just the ssh leader — must be torn down with it.
        drop(client);
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.current() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            permits.current(),
            0,
            "permit must be released once the local client closed"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if !process_alive(grandchild_pid) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "grandchild pid {grandchild_pid} survived the teardown"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        drop(bridge);
        let _ = std::fs::remove_dir_all(&root);
    }

    // Wave-3 teardown, leader-death side: the ssh leader can exit early
    // (connection refused, remote command gone) while a descendant holds
    // the stdout pipe and the local client stays connected and silent —
    // the permit must not sit on the group until the client finally acts.
    // The watchdog signals the group exactly once and stops polling: it
    // never reaps the leader, so the zombie owns its PID until the main
    // thread's final wait and the kill can never hit a recycled PGID.
    #[cfg(unix)]
    #[test]
    fn bridge_teardown_kills_grandchildren_when_ssh_leader_dies() {
        use std::os::unix::fs::PermissionsExt;

        let permits = ConnectionPermits::new(1);
        let endpoint = test_endpoint(&hex_id(12), "root@127.0.0.1");
        let root = home_test_root("pd");
        let script = root.join("fake-ssh.sh");
        let pid_file = root.join("grandchild.pid");
        // The stub spawns the long-lived grandchild, then the leader exits
        // on its own after a short delay — the client never acts, so the
        // death is still "early" relative to it, and the delay only keeps
        // the held permit observable before the teardown. The grandchild
        // keeps the stdout pipe open, so the main copy loop cannot see EOF
        // from the leader's death alone.
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n[ \"$1\" = warmup ] && exit 0\nsleep 300 & echo $! > {}\nsleep 2\n",
                pid_file.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        // ETXTBSY warm-up (see machine_disable_runner): exec the just-written
        // stub until the overlayfs window passes, so the bridge's own spawn
        // below is proven good and cannot silently shortcut the scenario.
        for _ in 0..40 {
            match std::process::Command::new(&script).arg("warmup").status() {
                Ok(status) if status.success() => break,
                Err(err) if err.to_string().contains("Text file busy") => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                other => panic!("warmup failed: {other:?}"),
            }
        }
        let bridge = SshSocketBridge::start(
            &endpoint,
            &root,
            BridgeKind::Api,
            permits.clone(),
            script.to_str().unwrap(),
        )
        .unwrap();
        let socket_path = bridge.path.clone();

        // The client stays connected and silent for the whole test: the
        // leader's early death alone must trigger the teardown.
        let _client = std::os::unix::net::UnixStream::connect(&socket_path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.current() != 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(permits.current(), 1, "connection must hold the permit");
        let grandchild_pid: i32 = {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = text.trim().parse() {
                        break pid;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "fake ssh never wrote its grandchild pid"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        assert!(
            process_alive(grandchild_pid),
            "grandchild must be alive before the leader dies"
        );

        // No client action happens here: the leader already exited, so the
        // group must be torn down and the permit released promptly.
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.current() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            permits.current(),
            0,
            "permit must be released once the ssh leader died"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if !process_alive(grandchild_pid) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "grandchild pid {grandchild_pid} survived the leader-death teardown"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        drop(bridge);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `kill(pid, 0)` keeps succeeding for zombies, and PID 1 in test
    /// containers is not guaranteed to reap, so on Linux the /proc state
    /// decides; without /proc (macOS) the probe result is the best signal.
    #[cfg(unix)]
    fn process_alive(pid: i32) -> bool {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            // The state is the first field after the parenthesized comm.
            Ok(stat) => !stat
                .rsplit(')')
                .next()
                .is_some_and(|rest| rest.trim_start().starts_with('Z')),
            Err(_) => true,
        }
    }

    // Machine bridge accept loop: transient accept errors must be classified
    // apart from listener-fatal ones so the loop can back off instead of dying.
    #[test]
    fn accept_error_action_classifies_poll_backoff_and_fatal() {
        let poll = [
            io::Error::from(io::ErrorKind::WouldBlock),
            io::Error::from_raw_os_error(libc::EINTR),
        ];
        for err in &poll {
            assert_eq!(accept_error_action(err), AcceptErrorAction::Poll, "{err}");
        }
        let transient = [
            libc::EMFILE,
            libc::ENFILE,
            libc::ENOBUFS,
            libc::ECONNABORTED,
        ];
        for code in transient {
            let err = io::Error::from_raw_os_error(code);
            assert_eq!(
                accept_error_action(&err),
                AcceptErrorAction::Backoff,
                "raw os error {code}"
            );
        }
        let fatal = [libc::EBADF, libc::EINVAL];
        for code in fatal {
            let err = io::Error::from_raw_os_error(code);
            assert_eq!(
                accept_error_action(&err),
                AcceptErrorAction::Fatal,
                "raw os error {code}"
            );
        }
    }

    #[test]
    fn accept_backoff_sleep_doubles_up_to_the_cap_and_honors_stop() {
        let stopped = AtomicBool::new(true);
        // Stop already set: the sleep is skipped, but the next backoff still
        // doubles and caps at ACCEPT_BACKOFF_MAX.
        assert_eq!(accept_backoff_sleep(&stopped, ACCEPT_POLL), ACCEPT_POLL * 2);
        assert_eq!(
            accept_backoff_sleep(&stopped, ACCEPT_BACKOFF_MAX / 2),
            ACCEPT_BACKOFF_MAX
        );
        assert_eq!(
            accept_backoff_sleep(&stopped, ACCEPT_BACKOFF_MAX),
            ACCEPT_BACKOFF_MAX
        );
    }

    #[test]
    fn accept_loop_serves_connections_after_transient_errors_and_exits_on_fatal() {
        let stop = AtomicBool::new(false);
        let fatal = AtomicBool::new(false);
        let served = Arc::new(AtomicUsize::new(0));
        let served_sink = Arc::clone(&served);
        let (client_end, server_end) = std::os::unix::net::UnixStream::pair().unwrap();
        drop(client_end);
        let mut script = std::collections::VecDeque::from(vec![
            Err(io::Error::from_raw_os_error(libc::EMFILE)),
            Err(io::Error::from_raw_os_error(libc::ECONNABORTED)),
            Ok(server_end),
            Err(io::Error::from_raw_os_error(libc::EBADF)),
        ]);

        run_accept_loop(
            move || {
                script
                    .pop_front()
                    .unwrap_or_else(|| panic!("accept called after the fatal error"))
            },
            move |_stream| {
                served_sink.fetch_add(1, Ordering::AcqRel);
            },
            &stop,
            &fatal,
        );

        assert_eq!(served.load(Ordering::Acquire), 1);
        assert!(
            fatal.load(Ordering::Acquire),
            "fatal error must be recorded"
        );
        assert!(!stop.load(Ordering::Acquire));
    }

    #[test]
    fn accept_loop_exits_promptly_when_stop_is_set_during_backoff() {
        let stop = Arc::new(AtomicBool::new(false));
        let fatal = Arc::new(AtomicBool::new(false));
        let stopper = Arc::clone(&stop);
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            stopper.store(true, Ordering::Release);
        });

        let started = Instant::now();
        run_accept_loop(
            || Err(io::Error::from_raw_os_error(libc::EMFILE)),
            |_| unreachable!("no connection can be accepted"),
            &stop,
            &fatal,
        );

        setter.join().unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "stop must interrupt the backoff promptly, took {:?}",
            started.elapsed()
        );
        assert!(!fatal.load(Ordering::Acquire));
    }

    #[test]
    fn accept_loop_never_polls_after_stop() {
        let stop = AtomicBool::new(true);
        let fatal = AtomicBool::new(false);
        run_accept_loop(
            || panic!("accept must not be called once stop is set"),
            |_| unreachable!(),
            &stop,
            &fatal,
        );
        assert!(!fatal.load(Ordering::Acquire));
    }

    // Cleanup: dropping a bridge must stop its accept thread deterministically
    // instead of leaving it blocked in accept().
    #[test]
    fn bridge_drop_stops_accept_thread_and_removes_socket() {
        let permits = ConnectionPermits::new(4);
        let endpoint = test_endpoint(&hex_id(7), "root@198.51.100.20");
        let root = home_test_root("ds");
        let bridge =
            SshSocketBridge::start(&endpoint, &root, BridgeKind::Api, permits, "ssh").unwrap();
        let socket_path = bridge.path.clone();
        assert!(socket_path.exists());

        // Explicit stop joins the accept thread and sets the finished flag.
        let mut bridge = bridge;
        let started = Instant::now();
        bridge.stop();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "stop must join the accept thread promptly, not block in accept()"
        );
        assert!(
            bridge.accept_thread_finished(),
            "accept thread must be observed exited after stop"
        );
        assert!(
            !bridge.accept_thread_failed(),
            "a requested stop is not a listener failure"
        );
        drop(bridge);
        assert!(!socket_path.exists(), "socket removed on stop/drop");
        assert!(
            std::os::unix::net::UnixStream::connect(&socket_path).is_err(),
            "nothing listens after stop"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // Cleanup: option-like and control-character targets are rejected before
    // any probe or bridge starts, even though the catalog is trusted.
    #[test]
    fn option_like_or_control_char_targets_are_rejected_before_any_probe() {
        let calls = Arc::new(AtomicUsize::new(0));
        let manager = manager_with(MachineManagerConfig {
            probe: counting_probe(Arc::clone(&calls), false),
            socket_dir: Some(home_test_root("or")),
            ..MachineManagerConfig::default()
        });
        for bad in [
            "-oProxyCommand=evil",
            "root@host\nrm -rf /",
            "root@host\u{0}-x",
            "root@host\t",
            "",
        ] {
            let mut endpoint = test_endpoint(&hex_id(8), "root@198.51.100.20");
            endpoint.target = bad.to_string();
            assert!(
                manager.ssh_state(&endpoint).is_err(),
                "target {bad:?} must be rejected"
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "rejection happens before probing"
        );

        assert!(!is_valid_ssh_target("-evil"));
        assert!(!is_valid_ssh_target("a\u{0}b"));
        assert!(!is_valid_ssh_target(""));
        assert!(is_valid_ssh_target("root@198.51.100.20"));
        assert!(is_valid_ssh_target("user@host.example:2222"));

        // The catalog also drops such endpoints entirely.
        let dir = unique_dir("bad-targets");
        let path = write_endpoints(
            &dir,
            r#"{
                "ssh": [
                    {"id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "label": "bad", "target": "-oProxyCommand=evil"},
                    {"id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "label": "ok", "target": "root@198.51.100.20"}
                ]
            }"#,
        );
        let machines = MachineCatalog::load_from(&path).machines();
        assert_eq!(machines.len(), 2, "only local + the valid target");
        assert_eq!(machines[1].id, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
