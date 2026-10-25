//! Tauri commands over the settings store. Errors use the same JSON-RPC error shape as the
//! relay, so the Workbench handles every Host error one way.

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use super::{Notice, SettingsError, SettingsStore};
use crate::rpc_relay::{rpc_error, APPLICATION_ERROR};

fn to_rpc(error: SettingsError) -> Value {
    rpc_error(APPLICATION_ERROR, error.code, &error.message, false)
}

#[tauri::command]
pub fn settings_get(store: State<'_, SettingsStore>) -> Value {
    store.settings()
}

/// Merges a partial update into the settings and saves it; returns the new settings.
#[tauri::command]
pub fn settings_update(patch: Value, store: State<'_, SettingsStore>) -> Result<Value, Value> {
    store.update(&patch).map_err(to_rpc)
}

/// Tells `on_change` about every later settings change.
#[tauri::command]
pub fn settings_subscribe(on_change: Channel<Value>, store: State<'_, SettingsStore>) {
    store.subscribe(on_change);
}

#[tauri::command]
pub fn ui_state_get(store: State<'_, SettingsStore>) -> Value {
    store.ui_state()
}

/// Replaces the given top-level UI-state keys (null removes one); returns the new state.
#[tauri::command]
pub fn ui_state_update(patch: Value, store: State<'_, SettingsStore>) -> Result<Value, Value> {
    store.update_ui_state(&patch).map_err(to_rpc)
}

/// Startup notices about the settings files, for the Workbench to show once.
#[tauri::command]
pub fn host_notices(store: State<'_, SettingsStore>) -> Vec<Notice> {
    store.notices()
}
