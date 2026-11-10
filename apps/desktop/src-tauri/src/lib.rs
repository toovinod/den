use std::{
  io::Read,
  process::{Command, Stdio},
  sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
  },
  thread,
  time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::{
  process::{CommandChild, CommandEvent},
  ShellExt,
};
use tokio::sync::watch;

// Must match READY_LINE_PREFIX in apps/daemon/src/server/DaemonServer.ts.
const READY_LINE_PREFIX: &str = "DEN_DAEMON_READY ";

// Longer than dend's own 8 second shutdown deadline, so a daemon that is still stopping its
// children is not cut off. Only a daemon that hangs past its own deadline gets killed.
const DAEMON_EXIT_WAIT: Duration = Duration::from_secs(10);

// Must match the event the webview listens for in apps/web/lib/daemonRuntime.ts.
const DAEMON_STOPPED_EVENT: &str = "daemon-stopped";

#[derive(Clone, Debug, PartialEq, Serialize)]
struct DaemonConnection {
  url: String,
  token: String,
}

// A stopped daemon has no connection, so nothing hands out the URL and token of a process that is gone.
#[derive(Clone, Debug, PartialEq)]
enum DaemonStatus {
  Starting,
  Ready(DaemonConnection),
  Stopped,
}

impl DaemonStatus {
  // None while dend is still starting, so callers keep waiting.
  fn connection(&self) -> Option<Result<DaemonConnection, String>> {
    match self {
      DaemonStatus::Starting => None,
      DaemonStatus::Ready(connection) => Some(Ok(connection.clone())),
      DaemonStatus::Stopped => Some(Err("The daemon stopped".to_string())),
    }
  }

  // Only a stopped daemon is started again, so two restart calls never run two daemons on one data dir.
  fn begin_restart(&mut self) -> bool {
    if *self != DaemonStatus::Stopped {
      return false;
    }
    *self = DaemonStatus::Starting;
    true
  }
}

// The status an event from dend moves to, or None when the event does not change it.
fn status_after(event: &CommandEvent, token: &str) -> Option<DaemonStatus> {
  match event {
    CommandEvent::Stdout(line) => String::from_utf8_lossy(line)
      .trim()
      .strip_prefix(READY_LINE_PREFIX)
      .map(|url| DaemonStatus::Ready(DaemonConnection { url: url.to_string(), token: token.to_string() })),
    // The plugin sends this only after it reaped the process, so the old dend and its data dir lock are gone.
    CommandEvent::Terminated(_) => Some(DaemonStatus::Stopped),
    _ => None,
  }
}

struct Daemon {
  status: watch::Sender<DaemonStatus>,
  // With the pid read at spawn: `CommandChild::pid` waits on a lock the plugin's waiter thread
  // can hold while dend is stopped, and quitting runs on the UI thread.
  child: Mutex<Option<(CommandChild, u32)>>,
  quitting: AtomicBool,
}

async fn wait_for_connection(daemon: &Daemon) -> Result<DaemonConnection, String> {
  let mut status = daemon.status.subscribe();
  let settled = status.wait_for(|status| status.connection().is_some()).await.map_err(|error| error.to_string())?;
  settled.connection().expect("checked by wait_for")
}

#[tauri::command]
async fn daemon_connection(daemon: State<'_, Daemon>) -> Result<DaemonConnection, String> {
  wait_for_connection(&daemon).await
}

// Started only by the user from the webview, never automatically, so a daemon that crashes on start
// does not restart in a loop.
#[tauri::command]
async fn restart_daemon(app: tauri::AppHandle, daemon: State<'_, Daemon>) -> Result<DaemonConnection, String> {
  if daemon.status.send_if_modified(DaemonStatus::begin_restart) {
    drop(take_daemon_child(&app));
    start_daemon(app.clone());
  }
  wait_for_connection(&daemon).await
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

fn spawn_daemon(app: &tauri::AppHandle) -> Result<CommandChild, Box<dyn std::error::Error>> {
  let token = generate_token()?;
  let mut sidecar = app.shell().sidecar("dend")?;
  match login_shell_path() {
    Some(path) => sidecar = sidecar.env("PATH", path),
    None => log::warn!("Could not read PATH from the login shell, so dend keeps the app's own PATH"),
  }
  let (mut events, mut child) = sidecar.spawn()?;
  // Through stdin, not the environment: agents, scripts and git inherit the daemon's environment.
  child.write(format!("{token}\n").as_bytes())?;

  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      let status = status_after(&event, &token);
      match &event {
        CommandEvent::Stdout(line) if status.is_none() => log::info!("dend: {}", String::from_utf8_lossy(line).trim_end()),
        CommandEvent::Stderr(line) => log::warn!("dend: {}", String::from_utf8_lossy(line).trim_end()),
        CommandEvent::Terminated(payload) => log::info!("dend exited: {payload:?}"),
        _ => {}
      }
      let Some(status) = status else { continue };
      let stopped = status == DaemonStatus::Stopped;
      let daemon = app.state::<Daemon>();
      daemon.status.send_replace(status);
      // Quitting stops dend on purpose, so only an unexpected exit tells the webview.
      if stopped && !daemon.quitting.load(Ordering::SeqCst) {
        let _ = app.emit(DAEMON_STOPPED_EVENT, ());
      }
    }
  });

  Ok(child)
}

// Reading the login shell's PATH can take seconds, so the window does not wait for it.
fn start_daemon(app: tauri::AppHandle) {
  tauri::async_runtime::spawn_blocking(move || {
    let daemon = app.state::<Daemon>();
    match spawn_daemon(&app) {
      Ok(child) => {
        let pid = child.pid();
        if let Ok(mut slot) = daemon.child.lock() {
          *slot = Some((child, pid));
        }
      }
      Err(error) => {
        log::error!("Could not start dend: {error}");
        daemon.status.send_replace(DaemonStatus::Stopped);
      }
    }
  });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .setup(|app| {
      let (status, _) = watch::channel(DaemonStatus::Starting);
      app.manage(Daemon { status, child: Mutex::new(None), quitting: AtomicBool::new(false) });
      start_daemon(app.handle().clone());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![daemon_connection, restart_daemon])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| match event {
      RunEvent::ExitRequested { api, .. } => quit(app, api),
      // In case the app exits without asking first. A crash closes stdin too.
      RunEvent::Exit => drop(take_daemon_child(app)),
      _ => {}
    });
}

fn take_daemon_child(app: &tauri::AppHandle) -> Option<(CommandChild, u32)> {
  app.state::<Daemon>().child.lock().ok().and_then(|mut child| child.take())
}

// Dropping the child closes the daemon's stdin, and it shuts down and stops everything it
// started. `kill()` would SIGKILL it at once and orphan its children, so the app hides its
// windows, waits off the UI thread for the daemon to exit, and kills it only when it hangs.
fn quit(app: &tauri::AppHandle, api: tauri::ExitRequestApi) {
  let daemon = app.state::<Daemon>();
  // The second request is our own `app.exit` below.
  if daemon.quitting.swap(true, Ordering::SeqCst) {
    return;
  }
  let Some((child, pid)) = take_daemon_child(app) else {
    return;
  };
  api.prevent_exit();
  for window in app.webview_windows().values() {
    let _ = window.hide();
  }
  drop(child);
  let mut status = daemon.status.subscribe();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let stopped = status.wait_for(|status| *status == DaemonStatus::Stopped);
    if tokio::time::timeout(DAEMON_EXIT_WAIT, stopped).await.is_err() {
      log::error!("dend did not exit within {DAEMON_EXIT_WAIT:?}, killing it");
      // Still dend's pid: it has not exited, so the pid cannot have been reused. The children
      // it leaves are stopped by the next dend from its process registry.
      unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
    app.exit(0);
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  use tauri_plugin_shell::process::TerminatedPayload;

  fn connection() -> DaemonConnection {
    DaemonConnection { url: "http://127.0.0.1:4799".to_string(), token: "secret".to_string() }
  }

  #[test]
  fn the_ready_line_makes_the_daemon_ready() {
    let line = CommandEvent::Stdout(b"DEN_DAEMON_READY http://127.0.0.1:4799\n".to_vec());
    assert_eq!(status_after(&line, "secret"), Some(DaemonStatus::Ready(connection())));
    assert_eq!(status_after(&CommandEvent::Stdout(b"listening\n".to_vec()), "secret"), None);
  }

  #[test]
  fn an_exited_daemon_stops_handing_out_its_connection() {
    let exited = CommandEvent::Terminated(TerminatedPayload { code: Some(1), signal: None });
    let status = status_after(&exited, "secret");
    assert_eq!(status, Some(DaemonStatus::Stopped));
    assert!(matches!(status.and_then(|status| status.connection()), Some(Err(_))));
  }

  #[test]
  fn only_a_stopped_daemon_restarts() {
    let mut stopped = DaemonStatus::Stopped;
    assert!(stopped.begin_restart());
    assert_eq!(stopped, DaemonStatus::Starting);
    assert!(stopped.connection().is_none());

    let mut starting = DaemonStatus::Starting;
    assert!(!starting.begin_restart());
    let mut ready = DaemonStatus::Ready(connection());
    assert!(!ready.begin_restart());
    assert_eq!(ready, DaemonStatus::Ready(connection()));
  }
}
