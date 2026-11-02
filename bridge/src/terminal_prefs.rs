//! Bridge-side persistent preference store for per-terminal client settings.
//!
//! Currently stores the "Send right-clicks to the pane" mode (`auto`/`off`)
//! per (machine key, terminal id). `terminal_id` is only unique within one
//! Herdr daemon, so every record is namespaced by the machine key of the
//! route that owns the pane ("local" or a saved SSH machine id) — colliding
//! terminal ids on different machines must never share a preference.
//!
//! Layout follows `agent_pins.rs`: a JSON file in a private state-dir, an
//! exclusive `LockFile` for every access, atomic 0600 writes, and a
//! copy-corrupt-once fallback that yields the default (`auto`) instead of
//! failing the terminal.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::store_util::{
    copy_corrupt_once, default_store_dir, ensure_private_dir, set_private_file_permissions,
    LockFile,
};

const TERMINAL_PREFS_STORE_VERSION: u32 = 1;
pub(crate) const MODE_AUTO: &str = "auto";
const MODE_OFF: &str = "off";
const MODES: [&str; 2] = [MODE_AUTO, MODE_OFF];

pub(crate) fn is_valid_mode(mode: &str) -> bool {
    MODES.contains(&mode)
}

#[derive(Clone)]
pub struct TerminalPrefsManager {
    prefs_path: PathBuf,
    prefs_lock_path: PathBuf,
}

#[derive(Debug)]
pub enum TerminalPrefsError {
    BadRequest(String),
    Io(io::Error),
    Store(String),
}

impl std::fmt::Display for TerminalPrefsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) => write!(f, "{message}"),
            Self::Io(err) => write!(f, "{err}"),
            Self::Store(message) => write!(f, "{message}"),
        }
    }
}

impl From<io::Error> for TerminalPrefsError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TerminalPrefsStore {
    version: u32,
    created_at: String,
    updated_at: String,
    prefs: Vec<TerminalPrefRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TerminalPrefRecord {
    machine_key: String,
    terminal_id: String,
    mode: String,
    /// Unix seconds of the last successful write. Telemetry only: nothing
    /// expires, a stored mode stays until it is explicitly changed.
    last_seen: u64,
}

impl TerminalPrefsManager {
    pub fn new() -> io::Result<Self> {
        let prefs_dir = default_terminal_prefs_dir();
        ensure_private_dir(&prefs_dir)?;
        Ok(Self {
            prefs_path: prefs_dir.join("terminal-prefs.json"),
            prefs_lock_path: prefs_dir.join("terminal-prefs.lock"),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(dir: PathBuf) -> io::Result<Self> {
        ensure_private_dir(&dir)?;
        Ok(Self {
            prefs_path: dir.join("terminal-prefs.json"),
            prefs_lock_path: dir.join("terminal-prefs.lock"),
        })
    }

    /// Returns the stored mode for (machine_key, terminal_id); `None` means
    /// the default (`auto`). An unreadable (corrupt) store falls back to the
    /// default after copying the file aside once; only real IO failures are
    /// reported as errors.
    pub fn get(
        &self,
        machine_key: &str,
        terminal_id: &str,
    ) -> Result<Option<String>, TerminalPrefsError> {
        let _lock = LockFile::exclusive(&self.prefs_lock_path)?;
        let store = self.load_store()?;
        Ok(store
            .prefs
            .iter()
            .find(|record| record.matches(machine_key, terminal_id))
            .map(|record| record.mode.clone()))
    }

    /// Persists `mode` for (machine_key, terminal_id), stamps `last_seen`
    /// with `now_secs` (telemetry), and writes atomically. Corrupt store
    /// contents are replaced by a fresh store
    /// (after copy-corrupt-once); IO failures are reported to the caller so
    /// it can refuse the state change.
    pub fn set(
        &self,
        machine_key: &str,
        terminal_id: &str,
        mode: &str,
        now_secs: u64,
    ) -> Result<(), TerminalPrefsError> {
        let (machine_key, terminal_id) = normalize_key(machine_key, terminal_id)?;
        if !is_valid_mode(mode) {
            return Err(TerminalPrefsError::BadRequest(format!(
                "unsupported right-click passthrough mode: {mode}"
            )));
        }
        let _lock = LockFile::exclusive(&self.prefs_lock_path)?;
        let mut store = self.load_store()?;
        store
            .prefs
            .retain(|record| !record.matches(&machine_key, &terminal_id));
        store.prefs.push(TerminalPrefRecord {
            machine_key,
            terminal_id,
            mode: mode.to_string(),
            last_seen: now_secs,
        });
        store.updated_at = now_secs.to_string();
        write_json_atomic(&self.prefs_path, &store)
    }

    /// Loads the store; a corrupt or unsupported file is copied aside once
    /// and replaced by the default (empty) store instead of failing callers.
    fn load_store(&self) -> Result<TerminalPrefsStore, TerminalPrefsError> {
        match fs::read(&self.prefs_path) {
            Ok(bytes) => match parse_store(&bytes) {
                Ok(store) => Ok(store),
                Err(err) => {
                    copy_corrupt_once(&self.prefs_path);
                    warn!("terminal prefs store is unreadable, using defaults: {err}");
                    Ok(default_store())
                }
            },
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(default_store()),
            Err(err) => Err(TerminalPrefsError::Io(err)),
        }
    }
}

impl TerminalPrefRecord {
    fn matches(&self, machine_key: &str, terminal_id: &str) -> bool {
        self.machine_key == machine_key && self.terminal_id == terminal_id
    }
}

fn default_store() -> TerminalPrefsStore {
    let now = "0".to_string();
    TerminalPrefsStore {
        version: TERMINAL_PREFS_STORE_VERSION,
        created_at: now.clone(),
        updated_at: now,
        prefs: Vec::new(),
    }
}

fn normalize_key(
    machine_key: &str,
    terminal_id: &str,
) -> Result<(String, String), TerminalPrefsError> {
    let machine_key = machine_key.trim();
    let terminal_id = terminal_id.trim();
    if machine_key.is_empty() {
        return Err(TerminalPrefsError::BadRequest(
            "machine_key is required".to_string(),
        ));
    }
    if terminal_id.is_empty() {
        return Err(TerminalPrefsError::BadRequest(
            "terminal_id is required".to_string(),
        ));
    }
    Ok((machine_key.to_string(), terminal_id.to_string()))
}

fn parse_store(bytes: &[u8]) -> Result<TerminalPrefsStore, TerminalPrefsError> {
    let store: TerminalPrefsStore = serde_json::from_slice(bytes).map_err(|err| {
        TerminalPrefsError::Store(format!("terminal prefs store is unreadable: {err}"))
    })?;
    if store.version != TERMINAL_PREFS_STORE_VERSION {
        return Err(TerminalPrefsError::Store(format!(
            "unsupported terminal prefs store version: {}",
            store.version
        )));
    }
    Ok(store)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), TerminalPrefsError> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let temp_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|err| {
        TerminalPrefsError::Store(format!("failed to serialize terminal prefs: {err}"))
    })?;
    let mut file = File::create(&temp_path)?;
    set_private_file_permissions(&temp_path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp_path, path)?;
    set_private_file_permissions(path)?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn default_terminal_prefs_dir() -> PathBuf {
    default_store_dir(
        "HERDR_WEB_TERMINAL_PREFS_DIR",
        "terminal-prefs",
        "herdr-web-terminal-prefs",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store_util::corrupt_copy_exists;

    #[test]
    fn set_then_get_round_trips_across_manager_instances() {
        let dir = test_dir("round-trip");
        let manager = TerminalPrefsManager::for_test(dir.clone()).unwrap();

        assert_eq!(manager.get("local", "term-1").unwrap(), None);

        manager
            .set("local", "term-1", MODE_OFF, 1_000_000_000)
            .unwrap();
        assert_eq!(
            manager.get("local", "term-1").unwrap(),
            Some(MODE_OFF.to_string())
        );

        // A fresh manager (e.g. bridge restart) reads the same file.
        let reloaded = TerminalPrefsManager::for_test(dir).unwrap();
        assert_eq!(
            reloaded.get("local", "term-1").unwrap(),
            Some(MODE_OFF.to_string())
        );
    }

    #[test]
    fn concurrent_sets_keep_the_store_consistent() {
        let dir = test_dir("concurrent");
        let a = TerminalPrefsManager::for_test(dir.clone()).unwrap();
        let b = TerminalPrefsManager::for_test(dir.clone()).unwrap();

        let writer = |manager: TerminalPrefsManager, mode: &'static str| {
            std::thread::spawn(move || {
                for i in 0..25u64 {
                    manager
                        .set("local", "term-1", mode, 1_000_000_000 + i)
                        .unwrap();
                }
            })
        };
        let left = writer(a, MODE_AUTO);
        let right = writer(b, MODE_OFF);
        left.join().unwrap();
        right.join().unwrap();

        let final_mode = TerminalPrefsManager::for_test(dir.clone())
            .unwrap()
            .get("local", "term-1")
            .unwrap();
        assert!(
            final_mode.as_deref() == Some(MODE_AUTO) || final_mode.as_deref() == Some(MODE_OFF),
            "final mode must be one of the written values, got {final_mode:?}"
        );
        // Exactly one record for the key: the store never duplicated entries.
        let store = read_store(&dir);
        assert_eq!(store.prefs.len(), 1);
        assert_eq!(store.prefs[0].mode, final_mode.unwrap());
    }

    #[test]
    fn corrupt_store_yields_default_and_copies_aside_once() {
        let dir = test_dir("corrupt");
        TerminalPrefsManager::for_test(dir.clone()).unwrap();
        let path = dir.join("terminal-prefs.json");
        fs::write(&path, b"{not json").unwrap();

        let manager = TerminalPrefsManager::for_test(dir.clone()).unwrap();
        assert_eq!(manager.get("local", "term-1").unwrap(), None);
        assert!(corrupt_copy_exists(&path));

        // The store recovers: a later set writes a fresh file.
        manager
            .set("local", "term-1", MODE_OFF, 1_000_000_000)
            .unwrap();
        assert_eq!(
            manager.get("local", "term-1").unwrap(),
            Some(MODE_OFF.to_string())
        );

        // An unsupported version is treated like a corrupt file.
        let bad_version = br#"{"version":99,"created_at":"0","updated_at":"0","prefs":[]}"#;
        fs::write(&path, bad_version).unwrap();
        assert_eq!(manager.get("local", "term-1").unwrap(), None);
    }

    #[test]
    fn terminal_ids_are_namespaced_by_machine() {
        let dir = test_dir("namespace");
        let manager = TerminalPrefsManager::for_test(dir.clone()).unwrap();

        manager
            .set("local", "term-1", MODE_OFF, 1_000_000_000)
            .unwrap();
        manager
            .set("machine-a", "term-1", MODE_AUTO, 1_000_000_001)
            .unwrap();

        assert_eq!(
            manager.get("local", "term-1").unwrap(),
            Some(MODE_OFF.to_string())
        );
        assert_eq!(
            manager.get("machine-a", "term-1").unwrap(),
            Some(MODE_AUTO.to_string())
        );
        let store = read_store(&dir);
        assert_eq!(store.prefs.len(), 2);
    }

    #[test]
    fn write_failure_is_reported_and_keeps_old_contents() {
        let dir = test_dir("write-failure");
        let manager = TerminalPrefsManager::for_test(dir.clone()).unwrap();
        manager
            .set("local", "term-1", MODE_OFF, 1_000_000_000)
            .unwrap();

        // A directory at the atomic-write temp path makes only the write
        // fail; the previous file stays readable and must not be clobbered.
        let temp_path = dir
            .join("terminal-prefs.json")
            .with_extension(format!("{}.tmp", std::process::id()));
        fs::create_dir(&temp_path).unwrap();
        assert!(manager
            .set("local", "term-1", MODE_AUTO, 2_000_000_000)
            .is_err());
        fs::remove_dir(&temp_path).unwrap();

        // A read never rewrites the file, so the failed write's contents
        // stay untouched on disk.
        let mode = manager.get("local", "term-1").unwrap();
        assert_eq!(mode.as_deref(), Some(MODE_OFF));
        let store = read_store(&dir);
        assert_eq!(store.prefs.len(), 1);
        assert_eq!(store.prefs[0].mode, MODE_OFF);
        assert_eq!(store.prefs[0].last_seen, 1_000_000_000);
    }

    #[test]
    fn invalid_mode_or_empty_key_is_rejected() {
        let dir = test_dir("invalid-mode");
        let manager = TerminalPrefsManager::for_test(dir).unwrap();

        assert!(manager.set("local", "term-1", "bogus", 1).is_err());
        assert!(manager.set("", "term-1", MODE_OFF, 1).is_err());
        assert!(manager.set("local", " ", MODE_OFF, 1).is_err());
        assert!(manager.set("local", "", MODE_OFF, 1).is_err());
        assert_eq!(manager.get("local", "term-1").unwrap(), None);
    }

    fn read_store(dir: &Path) -> TerminalPrefsStore {
        let bytes = fs::read(dir.join("terminal-prefs.json")).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "herdr-web-terminal-prefs-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ))
    }
}
