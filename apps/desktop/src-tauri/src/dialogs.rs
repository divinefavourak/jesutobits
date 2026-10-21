//! Native dialogs (ARCHITECTURE.md section 5.1). The Host calls `rfd` itself, so the webview
//! gets one narrow command instead of a dialog plugin's permissions (NFR-008). A picked
//! path goes back only to the Workbench call that asked for it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use crate::logging;
use crate::rpc_relay::{rpc_error, APPLICATION_ERROR};

const MODULE: &str = "dialogs";
const MAX_TITLE_CHARS: usize = 120;
pub const CODE_DIALOG_OPEN: &str = "runtime.dialog_open";

/// One dialog at a time: a second request while one is open is refused, not stacked.
static OPEN: AtomicBool = AtomicBool::new(false);

/// Shows the OS folder picker over the main window. `None` when the user cancels.
#[tauri::command]
pub async fn dialog_pick_folder(
    window: tauri::WebviewWindow,
    title: Option<String>,
    default_path: Option<String>,
) -> Result<Option<String>, Value> {
    if OPEN.swap(true, Ordering::SeqCst) {
        return Err(rpc_error(
            APPLICATION_ERROR,
            CODE_DIALOG_OPEN,
            "A folder dialog is already open",
            false,
        ));
    }
    let options = FolderOptions::new(title, default_path);
    let mut dialog = rfd::AsyncFileDialog::new().set_parent(&window);
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(directory) = &options.directory {
        dialog = dialog.set_directory(directory);
    }
    let picked = dialog.pick_folder().await;
    OPEN.store(false, Ordering::SeqCst);
    let path = picked.map(|handle| handle.path().to_string_lossy().into_owned());
    logging::info(
        MODULE,
        if path.is_some() {
            "folder picked"
        } else {
            "folder dialog cancelled"
        },
    );
    Ok(path)
}

/// The Workbench's options, made safe: a short title, and a start folder only if it exists.
#[derive(Debug, PartialEq)]
struct FolderOptions {
    title: Option<String>,
    directory: Option<String>,
}

impl FolderOptions {
    fn new(title: Option<String>, default_path: Option<String>) -> Self {
        Self {
            title: title
                .map(|title| title.chars().take(MAX_TITLE_CHARS).collect::<String>())
                .filter(|title| !title.trim().is_empty()),
            directory: default_path.filter(|path| Path::new(path).is_dir()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_short_title_and_an_existing_start_folder() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        assert_eq!(
            FolderOptions::new(Some("Open folder".into()), Some(dir.clone())),
            FolderOptions {
                title: Some("Open folder".into()),
                directory: Some(dir),
            }
        );
    }

    #[test]
    fn drops_a_missing_start_folder_and_a_blank_title() {
        assert_eq!(
            FolderOptions::new(Some("  ".into()), Some("Z:\\does\\not\\exist".into())),
            FolderOptions {
                title: None,
                directory: None,
            }
        );
    }

    #[test]
    fn caps_long_titles() {
        let options = FolderOptions::new(Some("x".repeat(500)), None);
        assert_eq!(options.title.unwrap().chars().count(), MAX_TITLE_CHARS);
    }
}
