//! The Host is the single writer of `settings.json` and `ui-state.json` in the app config dir
//! (DATA_AND_PERSISTENCE.md sections 5 and 6.2):
//!
//! - Writes are atomic: a temporary file in the same folder, flushed, then renamed.
//! - A file that is not valid JSON, or not valid settings, is renamed to
//!   `<name>.corrupt-<time>` and defaults are used. For settings the user is told; for UI
//!   state, which is only convenience, the Host just logs it.
//! - A settings file from a newer Jesutobits (higher `schemaVersion`) is read leniently and
//!   never written, so a downgrade cannot destroy it.
//! - `ui-state.json`'s `window` belongs to the Host; every other key is the Workbench's,
//!   validated by the Workbench.

pub mod commands;
pub mod settings;
pub mod window;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::logging;
use settings::{merge, Settings, SCHEMA_VERSION};

const MODULE: &str = "settings_store";
const SETTINGS_FILE: &str = "settings.json";
const UI_STATE_FILE: &str = "ui-state.json";
/// UI state is small; a runaway Workbench must not fill the disk.
const MAX_UI_STATE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Why an update was refused; `code` is a JesutobitsError code from packages/protocol.
#[derive(Debug, PartialEq)]
pub struct SettingsError {
    pub code: &'static str,
    pub message: String,
}

pub const CODE_INVALID_SETTINGS: &str = "storage.invalid_settings";
pub const CODE_READ_ONLY: &str = "storage.read_only";
pub const CODE_WRITE_FAILED: &str = "storage.write_failed";
pub const CODE_SETTINGS_NEWER: &str = "storage.settings_newer";
pub const CODE_SETTINGS_CORRUPT: &str = "storage.settings_corrupt";

fn invalid(message: impl Into<String>) -> SettingsError {
    SettingsError {
        code: CODE_INVALID_SETTINGS,
        message: message.into(),
    }
}

fn write_failed(what: &str, error: std::io::Error) -> SettingsError {
    SettingsError {
        code: CODE_WRITE_FAILED,
        message: format!("Could not save {what}: {error}"),
    }
}

/// Told to the user once at startup (the Workbench shows it).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Notice {
    pub code: String,
    pub message: String,
}

struct State {
    settings: Settings,
    /// Newer settings file: read, never written.
    read_only: bool,
    ui_state: Value,
    notices: Vec<Notice>,
    subscribers: Vec<Channel<Value>>,
    /// The Host's own listeners (telling the runtime), called after every change.
    listeners: Vec<Listener>,
}

type Listener = Box<dyn Fn(&Value) + Send>;

pub struct SettingsStore {
    dir: PathBuf,
    state: Mutex<State>,
}

impl SettingsStore {
    pub fn load(dir: &Path) -> Self {
        if let Err(error) = fs::create_dir_all(dir) {
            logging::error(
                MODULE,
                format!("could not create {}: {error}", dir.display()),
            );
        }
        let mut notices = Vec::new();
        let (settings, read_only) = load_settings(dir, &mut notices);
        let ui_state = load_ui_state(dir);
        Self {
            dir: dir.to_owned(),
            state: Mutex::new(State {
                settings,
                read_only,
                ui_state,
                notices,
                subscribers: Vec::new(),
                listeners: Vec::new(),
            }),
        }
    }

    pub fn settings(&self) -> Value {
        self.state.lock().unwrap().settings.to_value()
    }

    /// Merges `patch`, validates the result, writes it and tells subscribers.
    pub fn update(&self, patch: &Value) -> Result<Value, SettingsError> {
        if !patch.is_object() {
            return Err(invalid("A settings update must be an object"));
        }
        let mut state = self.state.lock().unwrap();
        if state.read_only {
            return Err(SettingsError {
                code: CODE_READ_ONLY,
                message: "These settings were saved by a newer version of Jesutobits and cannot be changed here".to_owned(),
            });
        }
        let mut value = state.settings.to_value();
        let mut patch = patch.clone();
        // The version is the Host's to manage.
        patch.as_object_mut().unwrap().remove("schemaVersion");
        merge(&mut value, &patch);
        let updated = Settings::from_value(value).map_err(invalid)?;
        write_json(&self.dir.join(SETTINGS_FILE), &updated.to_value())
            .map_err(|error| write_failed("settings", error))?;
        state.settings = updated;
        let value = state.settings.to_value();
        state
            .subscribers
            .retain(|channel| channel.send(value.clone()).is_ok());
        for listener in &state.listeners {
            listener(&value);
        }
        Ok(value)
    }

    /// Calls `listener` with the new settings after every change. It must not block.
    pub fn on_change(&self, listener: impl Fn(&Value) + Send + 'static) {
        self.state
            .lock()
            .unwrap()
            .listeners
            .push(Box::new(listener));
    }

    /// Adds a channel told about every settings change (a Workbench reload adds a new one).
    pub fn subscribe(&self, channel: Channel<Value>) {
        self.state.lock().unwrap().subscribers.push(channel);
    }

    pub fn ui_state(&self) -> Value {
        self.state.lock().unwrap().ui_state.clone()
    }

    /// Replaces the Workbench's top-level keys in `patch`; `window` and `schemaVersion` are
    /// the Host's and cannot be set this way. A null value removes the key.
    pub fn update_ui_state(&self, patch: &Value) -> Result<Value, SettingsError> {
        let Some(patch) = patch.as_object() else {
            return Err(invalid("A UI state update must be an object"));
        };
        let mut state = self.state.lock().unwrap();
        let mut next = state.ui_state.clone();
        let object = next.as_object_mut().expect("ui state is an object");
        for (key, value) in patch {
            if key == "window" || key == "schemaVersion" {
                return Err(invalid(format!("{key} cannot be changed by the Workbench")));
            }
            if value.is_null() {
                object.remove(key);
            } else {
                object.insert(key.clone(), value.clone());
            }
        }
        let size = serde_json::to_vec(&next)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if size > MAX_UI_STATE_BYTES {
            return Err(invalid(format!(
                "UI state would exceed {MAX_UI_STATE_BYTES} bytes"
            )));
        }
        write_json(&self.dir.join(UI_STATE_FILE), &next)
            .map_err(|error| write_failed("UI state", error))?;
        state.ui_state = next.clone();
        Ok(next)
    }

    pub fn window(&self) -> Option<WindowState> {
        let state = self.state.lock().unwrap();
        serde_json::from_value(state.ui_state.get("window")?.clone()).ok()
    }

    /// Remembers the window's bounds; written by `flush_window`.
    pub fn set_window(&self, window: WindowState) {
        let mut state = self.state.lock().unwrap();
        state.ui_state["window"] = serde_json::to_value(window).expect("window serialises");
    }

    pub fn flush_ui_state(&self) {
        let state = self.state.lock().unwrap();
        if let Err(error) = write_json(&self.dir.join(UI_STATE_FILE), &state.ui_state) {
            logging::warn(MODULE, format!("could not save UI state: {error}"));
        }
    }

    pub fn notices(&self) -> Vec<Notice> {
        self.state.lock().unwrap().notices.clone()
    }
}

fn load_settings(dir: &Path, notices: &mut Vec<Notice>) -> (Settings, bool) {
    let path = dir.join(SETTINGS_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Settings::default(), false)
        }
        Err(error) => {
            logging::error(MODULE, format!("could not read settings: {error}"));
            return (Settings::default(), false);
        }
    };
    let parsed: Result<Value, String> =
        serde_json::from_str(&text).map_err(|error| format!("not valid JSON: {error}"));
    let version = parsed
        .as_ref()
        .ok()
        .and_then(|value| value["schemaVersion"].as_u64());
    if let (Ok(value), Some(version)) = (&parsed, version) {
        if version > u64::from(SCHEMA_VERSION) {
            // Lenient: take what this version understands, never write the file.
            let mut lenient: Settings = serde_json::from_value(value.clone()).unwrap_or_default();
            lenient.schema_version = SCHEMA_VERSION;
            logging::warn(
                MODULE,
                format!("settings schema {version} is newer than {SCHEMA_VERSION}; read-only"),
            );
            notices.push(Notice {
                code: CODE_SETTINGS_NEWER.to_owned(),
                message: "Your settings were saved by a newer version of Jesutobits. They are used as far as possible, and changes cannot be saved until you update.".to_owned(),
            });
            return (
                if lenient.validate().is_ok() {
                    lenient
                } else {
                    Settings::default()
                },
                true,
            );
        }
    }
    match parsed.and_then(Settings::from_value) {
        Ok(settings) => (settings, false),
        Err(reason) => {
            let aside = move_aside(&path);
            logging::error(
                MODULE,
                format!("settings could not be loaded ({reason}); moved to {aside}"),
            );
            notices.push(Notice {
                code: CODE_SETTINGS_CORRUPT.to_owned(),
                message: format!(
                    "Your settings file could not be read, so Jesutobits started with default settings. The old file was kept as {aside}."
                ),
            });
            (Settings::default(), false)
        }
    }
}

fn load_ui_state(dir: &Path) -> Value {
    let path = dir.join(UI_STATE_FILE);
    let default = json!({ "schemaVersion": 1, "window": null });
    let Ok(text) = fs::read_to_string(&path) else {
        return default;
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(mut object)) => {
            // An unusable window is dropped; everything else is the Workbench's to check.
            let window_ok = object
                .get("window")
                .is_some_and(|w| serde_json::from_value::<WindowState>(w.clone()).is_ok());
            if !window_ok {
                object.insert("window".to_owned(), Value::Null);
            }
            object.insert("schemaVersion".to_owned(), json!(1));
            Value::Object(object)
        }
        _ => {
            let aside = move_aside(&path);
            logging::warn(
                MODULE,
                format!("UI state could not be read; moved to {aside}"),
            );
            default
        }
    }
}

/// Renames a bad file to `<name>.corrupt-<unix ms>` and returns the new name.
fn move_aside(path: &Path) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!(
        "{}.corrupt-{millis}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    );
    if let Err(error) = fs::rename(path, path.with_file_name(&name)) {
        logging::error(
            MODULE,
            format!("could not move {} aside: {error}", path.display()),
        );
    }
    name
}

/// Atomic write: temporary file in the same folder, flushed, then renamed over the target.
fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).expect("JSON values always serialise");
    bytes.push(b'\n');
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("jesutobits-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(dir: &Path, file: &str) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(file)).unwrap()).unwrap()
    }

    #[test]
    fn starts_with_defaults_and_writes_nothing_until_changed() {
        let dir = temp_dir("defaults");
        let store = SettingsStore::load(&dir);
        assert_eq!(store.settings(), Settings::default().to_value());
        assert!(!dir.join(SETTINGS_FILE).exists());
        assert!(store.notices().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tells_listeners_about_saved_changes_only() {
        let dir = temp_dir("listeners");
        let store = SettingsStore::load(&dir);
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        store.on_change(move |settings| {
            sink.lock()
                .unwrap()
                .push(settings["agent"]["limits"]["stepsPerTurn"].clone())
        });
        store
            .update(&json!({ "agent": { "limits": { "stepsPerTurn": 60 } } }))
            .unwrap();
        store
            .update(&json!({ "agent": { "limits": { "stepsPerTurn": 0 } } }))
            .unwrap_err();
        assert_eq!(*seen.lock().unwrap(), vec![json!(60)]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn updates_validate_persist_and_survive_a_restart() {
        let dir = temp_dir("update");
        let store = SettingsStore::load(&dir);
        let updated = store
            .update(&json!({ "appearance": { "uiScale": 1.25 }, "schemaVersion": 99 }))
            .unwrap();
        assert_eq!(updated["appearance"]["uiScale"], 1.25);
        assert_eq!(updated["schemaVersion"], 1);
        assert!(store
            .update(&json!({ "appearance": { "uiScale": 3 } }))
            .is_err());
        assert_eq!(read(&dir, SETTINGS_FILE)["appearance"]["uiScale"], 1.25);

        let reloaded = SettingsStore::load(&dir);
        assert_eq!(reloaded.settings()["appearance"]["uiScale"], 1.25);
        // No temporary files left behind.
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![SETTINGS_FILE.to_owned()]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_corrupt_settings_file_is_kept_aside_with_a_notice() {
        let dir = temp_dir("corrupt");
        fs::write(dir.join(SETTINGS_FILE), "{ not json").unwrap();
        let store = SettingsStore::load(&dir);
        assert_eq!(store.settings(), Settings::default().to_value());
        assert_eq!(store.notices()[0].code, "storage.settings_corrupt");
        let kept = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("settings.json.corrupt-")
        });
        assert!(kept);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_settings_count_as_corrupt() {
        let dir = temp_dir("invalid");
        fs::write(
            dir.join(SETTINGS_FILE),
            r#"{ "appearance": { "uiScale": 9 } }"#,
        )
        .unwrap();
        let store = SettingsStore::load(&dir);
        assert_eq!(store.settings()["appearance"]["uiScale"], 1.0);
        assert_eq!(store.notices().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_newer_settings_file_is_read_but_never_written() {
        let dir = temp_dir("newer");
        let original = r#"{ "schemaVersion": 7, "appearance": { "uiScale": 1.1 }, "future": 1 }"#;
        fs::write(dir.join(SETTINGS_FILE), original).unwrap();
        let store = SettingsStore::load(&dir);
        assert_eq!(store.settings()["appearance"]["uiScale"], 1.1);
        assert_eq!(store.notices()[0].code, "storage.settings_newer");
        assert!(store
            .update(&json!({ "appearance": { "uiScale": 1.2 } }))
            .is_err());
        assert_eq!(
            fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap(),
            original
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ui_state_keeps_workbench_keys_and_guards_the_window() {
        let dir = temp_dir("ui");
        let store = SettingsStore::load(&dir);
        store
            .update_ui_state(&json!({ "onboarding": { "step": 3 }, "layout": { "a": 1 } }))
            .unwrap();
        assert!(store.update_ui_state(&json!({ "window": null })).is_err());
        store.update_ui_state(&json!({ "layout": null })).unwrap();

        store.set_window(WindowState {
            x: 10,
            y: 20,
            width: 1200,
            height: 800,
            maximized: false,
        });
        store.flush_ui_state();

        let reloaded = SettingsStore::load(&dir);
        assert_eq!(reloaded.ui_state()["onboarding"]["step"], 3);
        assert!(reloaded.ui_state().get("layout").is_none());
        assert_eq!(reloaded.window().unwrap().width, 1200);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_ui_state_is_replaced_quietly() {
        let dir = temp_dir("ui-corrupt");
        fs::write(dir.join(UI_STATE_FILE), "[1, 2").unwrap();
        let store = SettingsStore::load(&dir);
        assert_eq!(
            store.ui_state(),
            json!({ "schemaVersion": 1, "window": null })
        );
        assert!(store.notices().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unusable_window_is_dropped() {
        let dir = temp_dir("ui-window");
        fs::write(
            dir.join(UI_STATE_FILE),
            r#"{ "window": { "x": "left" }, "keep": true }"#,
        )
        .unwrap();
        let store = SettingsStore::load(&dir);
        assert!(store.window().is_none());
        assert_eq!(store.ui_state()["keep"], true);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ui_state_has_a_size_limit() {
        let dir = temp_dir("ui-size");
        let store = SettingsStore::load(&dir);
        let big = "x".repeat(MAX_UI_STATE_BYTES);
        assert!(store.update_ui_state(&json!({ "blob": big })).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
