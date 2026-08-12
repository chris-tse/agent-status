mod control;
mod lifecycle;

pub use lifecycle::{LifecycleAction, LifecycleClient, LifecycleOutcome};

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

struct PreserveServiceOnClose(std::sync::atomic::AtomicBool);

pub(crate) fn show_dashboard(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Ambient Status Dashboard")
        .inner_size(1100.0, 760.0)
        .min_inner_size(760.0, 520.0)
        .build()?;
    Ok(())
}

fn run_lifecycle(app: &AppHandle, action: LifecycleAction) {
    let lifecycle = app.state::<LifecycleClient>().inner().clone();
    std::thread::spawn(move || match lifecycle.run(action) {
        Ok(outcome) => println!("service lifecycle: {}", outcome.state),
        Err(error) => eprintln!("service lifecycle failed: {error}"),
    });
}

fn handle_menu_action(app: &AppHandle, id: &str) {
    match id {
        "show-dashboard" => {
            if let Err(error) = show_dashboard(app) {
                eprintln!("could not show dashboard: {error}");
            }
        }
        "close-dashboard" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.close() {
                    eprintln!("could not close dashboard: {error}");
                }
            }
        }
        "service-status" => run_lifecycle(app, LifecycleAction::Status),
        "service-start" => run_lifecycle(app, LifecycleAction::Start),
        "service-stop" => run_lifecycle(app, LifecycleAction::Stop),
        "service-restart" => run_lifecycle(app, LifecycleAction::Restart),
        "quit-presentation" => app.exit(0),
        "stop-and-quit" => {
            let lifecycle = app.state::<LifecycleClient>().inner().clone();
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = lifecycle.run(LifecycleAction::Stop) {
                    eprintln!("could not stop service before quit: {error}");
                }
                app.exit(0);
            });
        }
        _ => {}
    }
}

#[tauri::command]
fn service_status(
    lifecycle: tauri::State<'_, LifecycleClient>,
) -> Result<LifecycleOutcome, String> {
    lifecycle.run(LifecycleAction::Status)
}

#[tauri::command]
fn service_start(lifecycle: tauri::State<'_, LifecycleClient>) -> Result<LifecycleOutcome, String> {
    lifecycle.run(LifecycleAction::Start)
}

#[tauri::command]
fn service_stop(lifecycle: tauri::State<'_, LifecycleClient>) -> Result<LifecycleOutcome, String> {
    lifecycle.run(LifecycleAction::Stop)
}

#[tauri::command]
fn service_restart(
    lifecycle: tauri::State<'_, LifecycleClient>,
) -> Result<LifecycleOutcome, String> {
    lifecycle.run(LifecycleAction::Restart)
}

pub fn run() {
    let app = tauri::Builder::default()
        .menu(|app| {
            let application = SubmenuBuilder::new(app, "Ambient Status Dashboard")
                .text("show-dashboard", "Show Dashboard")
                .text("close-dashboard", "Close Dashboard")
                .separator()
                .text("service-status", "Service Status")
                .text("service-start", "Start Service")
                .text("service-stop", "Stop Service")
                .text("service-restart", "Restart Service")
                .separator()
                .text("quit-presentation", "Quit Presentation")
                .text("stop-and-quit", "Stop Service and Quit")
                .build()?;
            MenuBuilder::new(app).item(&application).build()
        })
        .on_menu_event(|app, event| handle_menu_action(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window
                    .app_handle()
                    .state::<PreserveServiceOnClose>()
                    .0
                    .store(true, std::sync::atomic::Ordering::Release);
            }
        })
        .invoke_handler(tauri::generate_handler![
            service_status,
            service_start,
            service_stop,
            service_restart
        ])
        .setup(|app| {
            let executable = std::env::current_exe()?;
            let resources = app.path().resource_dir()?;
            let lifecycle = LifecycleClient::for_bundle(&executable, &resources)
                .map_err(std::io::Error::other)?;
            app.manage(lifecycle.clone());
            app.manage(PreserveServiceOnClose(std::sync::atomic::AtomicBool::new(
                false,
            )));
            if let Ok(value) = std::env::var("STATUS_DASHBOARD_CONTROL_PORT") {
                let port = value
                    .parse::<u16>()
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                control::start(app.handle().clone(), port).map_err(std::io::Error::other)?;
            }

            let tray_menu = MenuBuilder::new(app)
                .text("show-dashboard", "Show Dashboard")
                .text("close-dashboard", "Close Dashboard")
                .separator()
                .text("service-status", "Service Status")
                .text("service-start", "Start Service")
                .text("service-stop", "Stop Service")
                .text("service-restart", "Restart Service")
                .separator()
                .text("quit-presentation", "Quit Presentation")
                .text("stop-and-quit", "Stop Service and Quit")
                .build()?;
            TrayIconBuilder::new()
                .title("AS")
                .tooltip("Ambient Status Dashboard")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| handle_menu_action(app, event.id().as_ref()))
                .build(app)?;

            std::thread::spawn(move || match lifecycle.run(LifecycleAction::Start) {
                Ok(outcome) => println!("service lifecycle: {}", outcome.state),
                Err(error) => eprintln!("could not start service: {error}"),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if app
                .state::<PreserveServiceOnClose>()
                .0
                .swap(false, std::sync::atomic::Ordering::AcqRel)
            {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Err(error) = show_dashboard(app) {
                eprintln!("could not reopen dashboard: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{LifecycleAction, LifecycleClient};

    #[test]
    fn lifecycle_operations_return_process_and_health_outcomes() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let script = temporary.path().join("lifecycle.sh");
        fs::write(
            &script,
            r#"printf '%s' '{"state":"running","health":{"status":"ok","service":"ambient-status-dashboard","protocolVersion":1,"version":7,"provider":"herdr"}}'"#,
        )
        .expect("fixture lifecycle script");
        let client = LifecycleClient::new("/bin/sh", &script);

        let outcome = client
            .run(LifecycleAction::Status)
            .expect("lifecycle status should succeed");

        assert_eq!(outcome.state, "running");
        let health = outcome.health.expect("health outcome");
        assert_eq!(health.service, "ambient-status-dashboard");
        assert_eq!(health.protocol_version, 1);
        assert_eq!(health.version, 7);
        assert_eq!(health.provider, "herdr");
    }
}
