use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug)]
pub enum LifecycleAction {
    Status,
    Start,
    Stop,
    Restart,
}

impl LifecycleAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthOutcome {
    pub status: String,
    pub service: String,
    pub protocol_version: u64,
    pub version: u64,
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LifecycleOutcome {
    pub state: String,
    pub health: Option<HealthOutcome>,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LifecycleClient {
    runtime_path: PathBuf,
    lifecycle_cli_path: PathBuf,
}

impl LifecycleClient {
    pub fn new(runtime_path: impl Into<PathBuf>, lifecycle_cli_path: impl Into<PathBuf>) -> Self {
        Self {
            runtime_path: runtime_path.into(),
            lifecycle_cli_path: lifecycle_cli_path.into(),
        }
    }

    pub fn for_bundle(executable: &Path, resource_directory: &Path) -> Result<Self, String> {
        let executable_directory = executable
            .parent()
            .ok_or_else(|| "The Tauri executable has no parent directory".to_string())?;
        Ok(Self::new(
            executable_directory.join("status-service-runtime"),
            resource_directory.join("service/lifecycle-cli.js"),
        ))
    }

    pub fn run(&self, action: LifecycleAction) -> Result<LifecycleOutcome, String> {
        let output = Command::new(&self.runtime_path)
            .arg(&self.lifecycle_cli_path)
            .arg("--json")
            .arg(action.as_str())
            .env(
                "CORS_ORIGINS",
                "tauri://localhost,http://tauri.localhost,https://tauri.localhost",
            )
            .env("STATUS_PROVIDER", "herdr")
            .output()
            .map_err(|error| format!("Could not run the packaged lifecycle helper: {error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("Lifecycle helper exited with {}", output.status)
            } else {
                detail
            });
        }

        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Lifecycle helper returned invalid JSON: {error}"))
    }
}
