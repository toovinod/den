use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::{
  process::{CommandChild, CommandEvent},
  ShellExt,
};
use tokio::sync::watch;

// Must match READY_LINE_PREFIX in apps/daemon/src/server/DaemonServer.ts.
const READY_LINE_PREFIX: &str = "SWARM_DAEMON_READY ";

#[derive(Clone, Serialize)]
struct DaemonConnection {
  url: String,
  token: String,
}

struct Daemon {
  connection: watch::Receiver<Option<DaemonConnection>>,
  child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
async fn daemon_connection(daemon: State<'_, Daemon>) -> Result<DaemonConnection, String> {
  let mut connection = daemon.connection.clone();
  let ready = connection
    .wait_for(Option::is_some)
    .await
    .map_err(|_| "The daemon stopped before it was ready".to_string())?;
  Ok(ready.clone().expect("checked by wait_for"))
}

// A fresh secret per launch, so only this window can talk to this daemon.
fn generate_token() -> Result<String, getrandom::Error> {
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes)?;
  Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn spawn_daemon(app: &tauri::App) -> Result<Daemon, Box<dyn std::error::Error>> {
  let token = generate_token()?;
  let (mut events, mut child) = app.shell().sidecar("swarmd")?.spawn()?;
  // Through stdin, not the environment: agents, scripts and git inherit the daemon's environment.
  child.write(format!("{token}\n").as_bytes())?;
  let (ready, connection) = watch::channel(None);

  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      match event {
        CommandEvent::Stdout(line) => {
          let line = String::from_utf8_lossy(&line);
          match line.trim().strip_prefix(READY_LINE_PREFIX) {
            Some(url) => {
              let _ = ready.send(Some(DaemonConnection { url: url.to_string(), token: token.clone() }));
            }
            None => log::info!("swarmd: {}", line.trim_end()),
          }
        }
        CommandEvent::Stderr(line) => log::warn!("swarmd: {}", String::from_utf8_lossy(&line).trim_end()),
        CommandEvent::Terminated(status) => log::error!("swarmd exited: {status:?}"),
        _ => {}
      }
    }
  });

  Ok(Daemon { connection, child: Mutex::new(Some(child)) })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .setup(|app| {
      let daemon = spawn_daemon(app)?;
      app.manage(daemon);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![daemon_connection])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        let child = app.state::<Daemon>().child.lock().ok().and_then(|mut child| child.take());
        if let Some(child) = child {
          let _ = child.kill();
        }
      }
    });
}
