mod control;
mod diagnostics;
mod lifecycle;

pub use lifecycle::{LifecycleAction, LifecycleClient, LifecycleOutcome};

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

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

pub(crate) fn stop_service_and_quit(
    lifecycle: &LifecycleClient,
    quit: impl FnOnce() -> Result<(), String>,
) -> Result<LifecycleOutcome, String> {
    let outcome = lifecycle.run(LifecycleAction::Stop)?;
    quit()?;
    Ok(outcome)
}

#[tauri::command]
async fn service_status(lifecycle: State<'_, LifecycleClient>) -> Result<LifecycleOutcome, String> {
    run_lifecycle_command(lifecycle.inner().clone(), LifecycleAction::Status).await
}

#[tauri::command]
async fn service_start(lifecycle: State<'_, LifecycleClient>) -> Result<LifecycleOutcome, String> {
    run_lifecycle_command(lifecycle.inner().clone(), LifecycleAction::Start).await
}

#[tauri::command]
async fn service_stop(lifecycle: State<'_, LifecycleClient>) -> Result<LifecycleOutcome, String> {
    run_lifecycle_command(lifecycle.inner().clone(), LifecycleAction::Stop).await
}

#[tauri::command]
async fn service_restart(
    lifecycle: State<'_, LifecycleClient>,
) -> Result<LifecycleOutcome, String> {
    run_lifecycle_command(lifecycle.inner().clone(), LifecycleAction::Restart).await
}

#[tauri::command]
async fn open_diagnostic_logs() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        diagnostics::open_diagnostic_logs().map(|path| path.display().to_string())
    })
    .await
    .map_err(|error| format!("Diagnostic log task failed: {error}"))?
}

async fn run_lifecycle_command(
    lifecycle: LifecycleClient,
    action: LifecycleAction,
) -> Result<LifecycleOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || lifecycle.run(action))
        .await
        .map_err(|error| format!("Lifecycle task failed: {error}"))?
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
        "open-diagnostic-logs" => {
            std::thread::spawn(|| {
                if let Err(error) = diagnostics::open_diagnostic_logs() {
                    eprintln!("could not open diagnostic logs: {error}");
                }
            });
        }
        "quit-presentation" => app.exit(0),
        "stop-and-quit" => {
            let lifecycle = app.state::<LifecycleClient>().inner().clone();
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = stop_service_and_quit(&lifecycle, || {
                    app.exit(0);
                    Ok(())
                }) {
                    eprintln!("could not stop service before quit: {error}");
                }
            });
        }
        _ => {}
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            service_status,
            service_start,
            service_stop,
            service_restart,
            open_diagnostic_logs
        ])
        .menu(|app| {
            let application = SubmenuBuilder::new(app, "Ambient Status Dashboard")
                .text("show-dashboard", "Show Dashboard")
                .text("close-dashboard", "Close Dashboard")
                .separator()
                .text("service-status", "Service Status")
                .text("service-start", "Start Service")
                .text("service-stop", "Stop Service")
                .text("service-restart", "Restart Service")
                .text("open-diagnostic-logs", "Open Diagnostic Logs")
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
                .text("open-diagnostic-logs", "Open Diagnostic Logs")
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
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::{
        LifecycleAction, LifecycleClient, diagnostics::open_diagnostic_logs_at,
        stop_service_and_quit,
    };

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

    #[test]
    fn lifecycle_status_preserves_visible_unhealthy_details() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let script = temporary.path().join("lifecycle.sh");
        fs::write(
            &script,
            r#"printf '%s' '{"state":"unhealthy","health":null,"message":"The status endpoint is occupied by an unrelated process."}'; exit 1"#,
        )
        .expect("fixture lifecycle script");
        let client = LifecycleClient::new("/bin/sh", &script);

        let outcome = client
            .run(LifecycleAction::Status)
            .expect("unhealthy lifecycle status remains observable");

        assert_eq!(outcome.state, "unhealthy");
        assert_eq!(
            outcome.message.as_deref(),
            Some("The status endpoint is occupied by an unrelated process.")
        );
    }

    #[test]
    fn lifecycle_helper_failures_remain_errors() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let script = temporary.path().join("lifecycle.sh");
        fs::write(&script, r#"printf '%s' 'helper failed' >&2; exit 1"#)
            .expect("fixture lifecycle script");
        let client = LifecycleClient::new("/bin/sh", &script);

        let error = client
            .run(LifecycleAction::Status)
            .expect_err("non-JSON helper failure remains an error");

        assert_eq!(error, "helper failed");
    }

    #[test]
    fn stop_service_and_quit_keeps_the_presentation_open_when_stop_fails() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let script = temporary.path().join("lifecycle.sh");
        fs::write(&script, r#"printf '%s' 'stop failed' >&2; exit 1"#)
            .expect("fixture lifecycle script");
        let client = LifecycleClient::new("/bin/sh", &script);
        let quit = AtomicBool::new(false);

        let error = stop_service_and_quit(&client, || {
            quit.store(true, Ordering::Release);
            Ok(())
        })
        .expect_err("failed stop prevents presentation quit");

        assert_eq!(error, "stop failed");
        assert!(!quit.load(Ordering::Acquire));
    }

    #[test]
    fn diagnostic_log_action_creates_and_opens_the_service_log_directory() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let logs = temporary.path().join("logs");
        let mut opened = None::<PathBuf>;

        open_diagnostic_logs_at(&logs, |path| {
            opened = Some(path.to_path_buf());
            Ok(())
        })
        .expect("open diagnostic logs");

        assert!(logs.is_dir());
        assert_eq!(opened.as_deref(), Some(logs.as_path()));
    }
}
