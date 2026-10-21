//! Reverse calls the Host answers for the runtime (ADR-0014). Only methods declared in
//! packages/protocol (the generated `REVERSE_METHODS`) reach this module.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::logging;
use crate::rpc_relay::{
    rpc_error, ReverseHandler, APPLICATION_ERROR, CODE_METHOD_NOT_FOUND, METHOD_NOT_FOUND,
};

const MODULE: &str = "host_methods";
const INVALID_PARAMS: i64 = -32602;
pub const CODE_TRASH_FAILED: &str = "fs.trash_failed";
pub const CODE_REVEAL_FAILED: &str = "fs.reveal_failed";
pub const CODE_INVALID_PATH: &str = "fs.invalid_path";
pub const CODE_NOT_FOUND: &str = "fs.not_found";

pub fn reverse_handler() -> ReverseHandler {
    Arc::new(|method, params| Box::pin(async move { handle(&method, params).await }))
}

async fn handle(method: &str, params: Value) -> Result<Value, Value> {
    match method {
        "host.fs.trash" => trash(params).await,
        "host.os.reveal" => reveal(params),
        other => Err(rpc_error(
            METHOD_NOT_FOUND,
            CODE_METHOD_NOT_FOUND,
            &format!("The Host does not implement {other}"),
            false,
        )),
    }
}

/// Moves a path to the OS trash after checking it again: the runtime already confined it,
/// but the Host does not rely on that for the basics.
async fn trash(params: Value) -> Result<Value, Value> {
    let Some(path) = params["path"].as_str() else {
        return Err(rpc_error(
            INVALID_PARAMS,
            "rpc.invalid_params",
            "host.fs.trash needs a path",
            false,
        ));
    };
    let path = check_trashable(Path::new(path), home_dir().as_deref())
        .map_err(|(code, message)| rpc_error(APPLICATION_ERROR, code, &message, false))?;
    let target = path.clone();
    let outcome = tokio::task::spawn_blocking(move || trash::delete(&target))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| error.to_string()));
    match outcome {
        Ok(()) => {
            logging::info(MODULE, format!("moved to the trash: {}", path.display()));
            Ok(json!({}))
        }
        Err(reason) => {
            logging::warn(
                MODULE,
                format!("could not trash {}: {reason}", path.display()),
            );
            Err(rpc_error(
                APPLICATION_ERROR,
                CODE_TRASH_FAILED,
                &format!("The OS could not move it to the trash: {reason}"),
                false,
            ))
        }
    }
}

/// Shows a path in the OS file manager (FR-072). The runtime already confined it; the Host
/// checks that it is absolute and exists.
fn reveal(params: Value) -> Result<Value, Value> {
    let Some(path) = params["path"].as_str() else {
        return Err(rpc_error(
            INVALID_PARAMS,
            "rpc.invalid_params",
            "host.os.reveal needs a path",
            false,
        ));
    };
    let path = check_revealable(Path::new(path))
        .map_err(|(code, message)| rpc_error(APPLICATION_ERROR, code, &message, false))?;
    match open_file_manager(&path) {
        Ok(()) => {
            logging::info(
                MODULE,
                format!("revealed in the file manager: {}", path.display()),
            );
            Ok(json!({}))
        }
        Err(reason) => {
            logging::warn(
                MODULE,
                format!("could not reveal {}: {reason}", path.display()),
            );
            Err(rpc_error(
                APPLICATION_ERROR,
                CODE_REVEAL_FAILED,
                &format!("The file manager could not be opened: {reason}"),
                false,
            ))
        }
    }
}

fn check_revealable(path: &Path) -> Result<PathBuf, (&'static str, String)> {
    if !path.is_absolute() {
        return Err((CODE_INVALID_PATH, "The path must be absolute".to_owned()));
    }
    if path.symlink_metadata().is_err() {
        return Err((CODE_NOT_FOUND, "Nothing exists at that path".to_owned()));
    }
    Ok(path.to_owned())
}

/// Starts the OS file manager with `path` selected (on Linux, its folder opened). It is the
/// user's program, so the Host does not track it; a thread only reaps it when it exits.
fn open_file_manager(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("explorer.exe");
        // Explorer parses `/select,"<path>"` itself; std's quoting would wrap the whole argument.
        command.raw_arg(format!("/select,\"{}\"", path.display()));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(path);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let folder = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        let mut command = std::process::Command::new("xdg-open");
        command.arg(folder);
        command
    };
    let mut child = command.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Refuses relative paths, missing paths, filesystem roots and the home folder.
fn check_trashable(path: &Path, home: Option<&Path>) -> Result<PathBuf, (&'static str, String)> {
    if !path.is_absolute() {
        return Err((CODE_INVALID_PATH, "The path must be absolute".to_owned()));
    }
    if path.parent().is_none() {
        return Err((
            CODE_INVALID_PATH,
            "A drive or filesystem root cannot be trashed".to_owned(),
        ));
    }
    if path.symlink_metadata().is_err() {
        return Err((CODE_NOT_FOUND, "Nothing exists at that path".to_owned()));
    }
    if let Some(home) = home {
        let same = |a: &Path, b: &Path| {
            if cfg!(windows) {
                a.to_string_lossy()
                    .eq_ignore_ascii_case(&b.to_string_lossy())
            } else {
                a == b
            }
        };
        let trimmed = |p: &Path| PathBuf::from(p.to_string_lossy().trim_end_matches(['\\', '/']));
        if same(&trimmed(path), &trimmed(home)) {
            return Err((
                CODE_INVALID_PATH,
                "The home folder cannot be trashed".to_owned(),
            ));
        }
    }
    Ok(path.to_owned())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jesutobits-host-trash-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn refuses_what_must_never_be_trashed() {
        let dir = temp("checks");
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let root = if cfg!(windows) { "C:\\" } else { "/" };

        assert_eq!(
            check_trashable(Path::new("relative.txt"), None)
                .unwrap_err()
                .0,
            CODE_INVALID_PATH
        );
        assert_eq!(
            check_trashable(Path::new(root), None).unwrap_err().0,
            CODE_INVALID_PATH
        );
        assert_eq!(
            check_trashable(&dir.join("missing.txt"), None)
                .unwrap_err()
                .0,
            CODE_NOT_FOUND
        );
        assert_eq!(
            check_trashable(&dir, Some(&dir)).unwrap_err().0,
            CODE_INVALID_PATH
        );
        assert!(check_trashable(&file, Some(&dir)).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn refuses_unknown_methods_and_missing_params() {
        assert_eq!(
            handle("host.other", json!({})).await.unwrap_err()["data"]["code"],
            CODE_METHOD_NOT_FOUND
        );
        assert_eq!(
            handle("host.fs.trash", json!({})).await.unwrap_err()["code"],
            INVALID_PARAMS
        );
        assert_eq!(
            handle("host.os.reveal", json!({})).await.unwrap_err()["code"],
            INVALID_PARAMS
        );
    }

    #[test]
    fn reveals_only_absolute_paths_that_exist() {
        let dir = temp("reveal");
        assert_eq!(
            check_revealable(Path::new("relative.txt")).unwrap_err().0,
            CODE_INVALID_PATH
        );
        assert_eq!(
            check_revealable(&dir.join("missing.txt")).unwrap_err().0,
            CODE_NOT_FOUND
        );
        assert!(check_revealable(&dir).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The real OS trash. The item is purged from the trash afterwards, so nothing is left in
    /// the user's Recycle Bin.
    #[cfg(any(windows, target_os = "linux"))]
    #[tokio::test]
    async fn moves_a_file_to_the_trash() {
        let dir = temp("real");
        let stem = format!("jesutobits-trash-test-{}", std::process::id());
        let name = format!("{stem}.txt");
        let file = dir.join(&name);
        std::fs::write(&file, "x").unwrap();

        handle("host.fs.trash", json!({ "path": file.to_string_lossy() }))
            .await
            .unwrap();
        assert!(!file.exists());

        let listed = trash::os_limited::list().unwrap();
        let total = listed.len();
        // On Windows the name is the shell's display name, which drops the extension when
        // Explorer hides known ones (the default, and on CI runners).
        let items: Vec<_> = listed
            .into_iter()
            .filter(|item| {
                let shown = item.name.to_string_lossy();
                shown == name || shown == stem
            })
            .collect();
        assert_eq!(
            items.len(),
            1,
            "the file is in the trash (the trash lists {total} items; {})",
            recycle_bin_records(&file, &name)
        );
        trash::os_limited::purge_all(items).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// For the failure message: whether the Recycle Bin folder on disk has a record for `name`,
    /// which tells "recycled but not listed by the shell" from "deleted for good".
    #[cfg(windows)]
    fn recycle_bin_records(file: &Path, name: &str) -> String {
        let Some(std::path::Component::Prefix(drive)) = file.components().next() else {
            return "no drive in the path".into();
        };
        let bin = format!("{}\\$Recycle.Bin", drive.as_os_str().to_string_lossy());
        let Ok(users) = std::fs::read_dir(&bin) else {
            return format!("{bin} is not readable");
        };
        let mut records = 0;
        for user in users.flatten() {
            for entry in std::fs::read_dir(user.path())
                .into_iter()
                .flatten()
                .flatten()
            {
                if !entry.file_name().to_string_lossy().starts_with("$I") {
                    continue;
                }
                let bytes = std::fs::read(entry.path()).unwrap_or_default();
                let units: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_le_bytes(*pair))
                    .collect();
                if String::from_utf16_lossy(&units).contains(name) {
                    records += 1;
                }
            }
        }
        format!("{records} $I records for it under {bin}")
    }

    #[cfg(not(windows))]
    fn recycle_bin_records(_file: &Path, _name: &str) -> String {
        "no Recycle Bin check on this platform".into()
    }
}
