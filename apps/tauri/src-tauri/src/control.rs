use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{LifecycleAction, LifecycleClient};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    service_state: String,
    service_message: Option<String>,
    presentation_open: bool,
    pid: u32,
}

fn response(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(payload.as_bytes());
}

fn main_thread(
    app: &AppHandle,
    operation: impl FnOnce(AppHandle) + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = mpsc::sync_channel(0);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        operation(handle);
        let _ = send.send(());
    })
    .map_err(|error| error.to_string())?;
    receive.recv().map_err(|error| error.to_string())
}

fn handle(app: &AppHandle, stream: &mut TcpStream) {
    let mut buffer = [0_u8; 4096];
    let bytes = match stream.read(&mut buffer) {
        Ok(bytes) => bytes,
        Err(error) => {
            response(stream, "400 Bad Request", "text/plain", &error.to_string());
            return;
        }
    };
    let request = String::from_utf8_lossy(&buffer[..bytes]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    let result = match path {
        "/status" => {
            let lifecycle = app.state::<LifecycleClient>();
            lifecycle.run(LifecycleAction::Status).map(|outcome| {
                serde_json::to_string(&DesktopStatus {
                    service_state: outcome.state,
                    service_message: outcome.message,
                    presentation_open: app.get_webview_window("main").is_some(),
                    pid: std::process::id(),
                })
                .expect("desktop status is serializable")
            })
        }
        "/action/close-dashboard" => main_thread(app, |handle| {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.close();
            }
        })
        .map(|()| "{}".to_string()),
        "/action/show-dashboard" => main_thread(app, |handle| {
            let _ = crate::show_dashboard(&handle);
        })
        .map(|()| "{}".to_string()),
        "/action/start-service" => app
            .state::<LifecycleClient>()
            .run(LifecycleAction::Start)
            .and_then(|outcome| serde_json::to_string(&outcome).map_err(|error| error.to_string())),
        "/action/stop-service" => app
            .state::<LifecycleClient>()
            .run(LifecycleAction::Stop)
            .and_then(|outcome| serde_json::to_string(&outcome).map_err(|error| error.to_string())),
        "/action/restart-service" => app
            .state::<LifecycleClient>()
            .run(LifecycleAction::Restart)
            .and_then(|outcome| serde_json::to_string(&outcome).map_err(|error| error.to_string())),
        "/action/stop-and-quit" => {
            let lifecycle = app.state::<LifecycleClient>().inner().clone();
            crate::stop_service_and_quit(&lifecycle, || {
                main_thread(app, |handle| handle.exit(0))?;
                Ok(())
            })
            .and_then(|outcome| serde_json::to_string(&outcome).map_err(|error| error.to_string()))
        }
        "/action/quit" => main_thread(app, |handle| handle.exit(0)).map(|()| "{}".to_string()),
        _ => {
            response(stream, "404 Not Found", "text/plain", "Not found");
            return;
        }
    };

    match result {
        Ok(body) => response(stream, "200 OK", "application/json", &body),
        Err(error) => response(stream, "500 Internal Server Error", "text/plain", &error),
    }
}

pub fn start(app: AppHandle, port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("Could not bind Tauri control endpoint: {error}"))?;
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(mut stream) => handle(&app, &mut stream),
                Err(error) => eprintln!("Tauri control connection failed: {error}"),
            }
        }
    });
    Ok(())
}
