use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store_util::{
    default_store_dir, ensure_private_dir, now_ms_string, set_private_file_permissions, LockFile,
};

const WORKSPACE_ZONES_STORE_VERSION: u32 = 1;
pub const WORKSPACE_ZONES_MODE_LOCAL_REMOTE: &str = "local_remote";
pub const WORKSPACE_ZONES_MODE_OFF: &str = "off";
const WORKSPACE_ZONES_MODES: [&str; 2] =
    [WORKSPACE_ZONES_MODE_LOCAL_REMOTE, WORKSPACE_ZONES_MODE_OFF];

#[derive(Clone)]
pub struct WorkspaceZonesManager {
    settings_path: PathBuf,
    lock_path: PathBuf,
}

#[derive(Debug)]
pub enum WorkspaceZonesError {
    BadRequest(String),
    Io(io::Error),
}

impl std::fmt::Display for WorkspaceZonesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) => write!(f, "{message}"),
            Self::Io(err) => write!(f, "{err}"),
        }
    }
}

impl From<io::Error> for WorkspaceZonesError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceZonesResponse {
    pub version: u32,
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct WorkspaceZonesSettings {
    version: u32,
    mode: String,
    updated_at: String,
}

impl WorkspaceZonesManager {
    pub fn new() -> io::Result<Self> {
        let dir = default_workspace_zones_dir();
        ensure_private_dir(&dir)?;
        Ok(Self {
            settings_path: dir.join("workspace-zones.json"),
            lock_path: dir.join("workspace-zones.lock"),
        })
    }

    #[cfg(test)]
    fn for_test(dir: PathBuf) -> io::Result<Self> {
        ensure_private_dir(&dir)?;
        Ok(Self {
            settings_path: dir.join("workspace-zones.json"),
            lock_path: dir.join("workspace-zones.lock"),
        })
    }

    /// Current zone grouping mode. Defaults to the CLI-like Local/Remote split.
    pub fn get(&self) -> Result<WorkspaceZonesResponse, WorkspaceZonesError> {
        let _lock = LockFile::exclusive(&self.lock_path)?;
        let mode = self.load_mode()?.unwrap_or_else(default_mode).to_string();
        Ok(WorkspaceZonesResponse {
            version: WORKSPACE_ZONES_STORE_VERSION,
            mode,
        })
    }

    pub fn set(&self, mode: &str) -> Result<WorkspaceZonesResponse, WorkspaceZonesError> {
        let mode = normalize_mode(mode)?;
        let _lock = LockFile::exclusive(&self.lock_path)?;
        if mode == default_mode() {
            // The default needs no stored state; drop any stale file so future
            // default changes are not masked by an old explicit record.
            match fs::remove_file(&self.settings_path) {
                Ok(()) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => return Err(err.into()),
            }
        } else {
            let settings = WorkspaceZonesSettings {
                version: WORKSPACE_ZONES_STORE_VERSION,
                mode: mode.clone(),
                updated_at: now_ms_string(),
            };
            write_json_atomic(&self.settings_path, &settings)?;
        }
        Ok(WorkspaceZonesResponse {
            version: WORKSPACE_ZONES_STORE_VERSION,
            mode,
        })
    }

    fn load_mode(&self) -> Result<Option<&'static str>, WorkspaceZonesError> {
        let bytes = match fs::read(&self.settings_path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        match serde_json::from_slice::<WorkspaceZonesSettings>(&bytes) {
            Ok(settings)
                if settings.version == WORKSPACE_ZONES_STORE_VERSION
                    && WORKSPACE_ZONES_MODES.contains(&settings.mode.as_str()) =>
            {
                Ok(Some(match settings.mode.as_str() {
                    WORKSPACE_ZONES_MODE_OFF => WORKSPACE_ZONES_MODE_OFF,
                    _ => WORKSPACE_ZONES_MODE_LOCAL_REMOTE,
                }))
            }
            _ => Ok(None),
        }
    }
}

fn default_mode() -> &'static str {
    WORKSPACE_ZONES_MODE_LOCAL_REMOTE
}

fn normalize_mode(mode: &str) -> Result<String, WorkspaceZonesError> {
    let normalized = mode.trim().to_ascii_lowercase();
    if WORKSPACE_ZONES_MODES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(WorkspaceZonesError::BadRequest(format!(
            "invalid workspace zones mode {mode:?}; expected \"local_remote\" or \"off\""
        )))
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let temp_path = path.with_extension("json.tmp");
    {
        let mut file = File::create(&temp_path)?;
        file.write_all(&bytes)?;
        file.flush()?;
    }
    set_private_file_permissions(&temp_path)?;
    fs::rename(&temp_path, path)?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn default_workspace_zones_dir() -> PathBuf {
    default_store_dir(
        "HERDR_WEB_WORKSPACE_ZONES_DIR",
        "workspace-zones",
        "herdr-web-workspace-zones",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herdr-web-workspace-zones-test-{name}-{}",
            now_ms_string()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_returns_default_mode() {
        let manager = WorkspaceZonesManager::for_test(unique_test_dir("default")).unwrap();
        let response = manager.get().unwrap();
        assert_eq!(response.version, 1);
        assert_eq!(response.mode, "local_remote");
    }

    #[test]
    fn set_off_persists_and_round_trips() {
        let manager = WorkspaceZonesManager::for_test(unique_test_dir("roundtrip")).unwrap();
        let response = manager.set("off").unwrap();
        assert_eq!(response.mode, "off");
        assert_eq!(manager.get().unwrap().mode, "off");
    }

    #[test]
    fn setting_default_mode_removes_stored_file() {
        let manager = WorkspaceZonesManager::for_test(unique_test_dir("reset")).unwrap();
        manager.set("off").unwrap();
        manager.set("local_remote").unwrap();
        assert!(!manager.settings_path.exists());
        assert_eq!(manager.get().unwrap().mode, "local_remote");
    }

    #[test]
    fn invalid_mode_is_rejected() {
        let manager = WorkspaceZonesManager::for_test(unique_test_dir("invalid")).unwrap();
        let err = manager.set("zones").unwrap_err().to_string();
        assert!(err.contains("invalid workspace zones mode"), "{err}");
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {
        let dir = unique_test_dir("corrupt");
        let manager = WorkspaceZonesManager::for_test(dir.clone()).unwrap();
        fs::write(&manager.settings_path, "{not json").unwrap();
        assert_eq!(manager.get().unwrap().mode, "local_remote");
    }

    #[test]
    fn unknown_version_falls_back_to_default() {
        let dir = unique_test_dir("version");
        let manager = WorkspaceZonesManager::for_test(dir.clone()).unwrap();
        fs::write(
            &manager.settings_path,
            r#"{"version":99,"mode":"off","updated_at":"1"}"#,
        )
        .unwrap();
        assert_eq!(manager.get().unwrap().mode, "local_remote");
    }
}
