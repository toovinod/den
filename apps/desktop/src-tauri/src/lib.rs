use std::{
  io::Read,
  process::{Command, Stdio},
  sync::Mutex,
  thread,
  time::{Duration, Instant},
};

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

// An app opened from Finder or a desktop launcher gets a minimal PATH without the user's
// `claude`, `codex`, `node` or `gh`. Their login shell sets the real one.
fn login_shell_path() -> Option<String> {
  let shell = std::env::var("SHELL").ok()?;
  // Interactive too, because many people set PATH in .zshrc or .bashrc. Taking the last line
  // skips anything the shell's startup files print.
  let mut child = Command::new(shell)
    .args(["-ilc", r#"printf '\n%s' "$PATH""#])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let deadline = Instant::now() + Duration::from_secs(5);
  while child.try_wait().ok()?.is_none() {
    if Instant::now() > deadline {
      let _ = child.kill();
      return None;
    }
    thread::sleep(Duration::from_millis(20));
  }
  let mut output = String::new();
  child.stdout.take()?.read_to_string(&mut output).ok()?;
  output.lines().last().filter(|path| !path.is_empty()).map(str::to_string)
}

fn spawn_daemon(
  app: &tauri::AppHandle,
  ready: watch::Sender<Option<DaemonConnection>>,
) -> Result<CommandChild, Box<dyn std::error::Error>> {
  let token = generate_token()?;
  let mut sidecar = app.shell().sidecar("swarmd")?;
  match login_shell_path() {
    Some(path) => sidecar = sidecar.env("PATH", path),
    None => log::warn!("Could not read PATH from the login shell, so swarmd keeps the app's own PATH"),
  }
  let (mut events, mut child) = sidecar.spawn()?;
  // Through stdin, not the environment: agents, scripts and git inherit the daemon's environment.
  child.write(format!("{token}\n").as_bytes())?;

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

  Ok(child)
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
      let (ready, connection) = watch::channel(None);
      app.manage(Daemon { connection, child: Mutex::new(None) });
      let app = app.handle().clone();
      // Reading the login shell's PATH can take seconds, so the window does not wait for it.
      tauri::async_runtime::spawn_blocking(move || match spawn_daemon(&app, ready) {
        Ok(child) => {
          if let Ok(mut slot) = app.state::<Daemon>().child.lock() {
            *slot = Some(child);
          }
        }
        Err(error) => log::error!("Could not start swarmd: {error}"),
      });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![daemon_connection])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // Dropping the child closes the daemon's stdin, and it shuts down and stops everything it
      // started. A crash closes stdin too. `kill()` would SIGKILL the daemon and orphan its children.
      if let RunEvent::Exit = event {
        drop(app.state::<Daemon>().child.lock().ok().and_then(|mut child| child.take()));
      }
    });
}
