//! Window bounds survive restarts (ROADMAP Phase 1, `ui-state.json`'s `window`). The main
//! window starts hidden (tauri.conf.json), is moved to its saved place if that is still on a
//! screen, and is then shown, so it never visibly jumps.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

use super::{SettingsStore, WindowState};
use crate::logging;

const MODULE: &str = "window";
/// Moves and resizes arrive in bursts; save once they settle.
const SAVE_DELAY: Duration = Duration::from_millis(500);
/// A saved window must show at least this much of itself on some screen.
const MIN_VISIBLE: i32 = 100;

/// Restores the saved bounds, shows the window and starts tracking changes.
pub fn restore_and_track(window: &WebviewWindow) {
    let store = window.state::<SettingsStore>();
    if let Some(saved) = store.window() {
        if is_on_screen(window, &saved) {
            let _ = window.set_size(PhysicalSize::new(saved.width, saved.height));
            let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
            if saved.maximized {
                let _ = window.maximize();
            }
        } else {
            logging::info(
                MODULE,
                "the saved window position is off screen; using the default",
            );
        }
    }
    if let Err(error) = window.show() {
        logging::error(MODULE, format!("could not show the window: {error}"));
    }

    let scheduled = Arc::new(AtomicBool::new(false));
    let tracked = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            remember(&tracked);
            if !scheduled.swap(true, Ordering::SeqCst) {
                let scheduled = scheduled.clone();
                let window = tracked.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(SAVE_DELAY).await;
                    scheduled.store(false, Ordering::SeqCst);
                    window.state::<SettingsStore>().flush_ui_state();
                });
            }
        }
        WindowEvent::CloseRequested { .. } => {
            remember(&tracked);
            tracked.state::<SettingsStore>().flush_ui_state();
        }
        _ => {}
    });
}

/// Records the current bounds. While maximized, only the flag changes, so un-maximizing
/// after a restart returns to the size the user chose.
fn remember(window: &WebviewWindow) {
    let store = window.state::<SettingsStore>();
    let maximized = window.is_maximized().unwrap_or(false);
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let next = if maximized {
        match store.window() {
            Some(previous) => WindowState {
                maximized: true,
                ..previous
            },
            None => return,
        }
    } else {
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            return;
        };
        WindowState {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized: false,
        }
    };
    store.set_window(next);
}

fn is_on_screen(window: &WebviewWindow, saved: &WindowState) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    let (width, height) = (saved.width as i32, saved.height as i32);
    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        overlap(saved.x, width, origin.x, size.width as i32) >= MIN_VISIBLE
            && overlap(saved.y, height, origin.y, size.height as i32) >= MIN_VISIBLE
    })
}

/// Length of the overlap of [a, a + a_len) and [b, b + b_len).
fn overlap(a: i32, a_len: i32, b: i32, b_len: i32) -> i32 {
    ((a + a_len).min(b + b_len) - a.max(b)).max(0)
}

#[cfg(test)]
mod tests {
    use super::overlap;

    #[test]
    fn measures_overlap() {
        assert_eq!(overlap(0, 100, 50, 100), 50);
        assert_eq!(overlap(0, 100, 200, 100), 0);
        assert_eq!(overlap(-50, 100, 0, 1920), 50);
        assert_eq!(overlap(100, 50, 0, 1920), 50);
    }
}
