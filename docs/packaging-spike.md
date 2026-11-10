# Packaging spike

This records the packaging spike from [architecture section 13](architecture.md#13-packaging-validate-before-building-more-features), run on 2026-11-07.
The question was whether the shipped shape works: a Tauri release app with `dend` compiled by `bun build --compile` as its sidecar.

## Supported and verified now

Checked on 2026-11-10 against `.github/workflows`, `apps/desktop/src-tauri/tauri.conf.json` and a local build.
Everything below this section is the historical spike record, not the current state.

| What                                | State now                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release workflow                    | `release-please.yml` only runs release-please, which bumps the version in `tauri.conf.json` and `Cargo.toml`. No workflow builds, signs or publishes the app. |
| Linux x64 desktop build             | CI's `desktop` job runs `tauri build --no-bundle` on `ubuntu-24.04` for every push and pull request. It compiles the app and `dend`, but makes no installer.  |
| macOS arm64 desktop build           | Not in CI. `bun run build` built the release app and `dend` on a local Apple silicon Mac on 2026-11-10, without a bundle. The app was not started.            |
| macOS x64 and Linux arm64           | `compileDaemon.ts` can cross-compile `dend` for them. No app is built for them in CI or in a release.                                                         |
| Windows                             | Not a target. `compileDaemon.ts` has no Windows target.                                                                                                       |
| Installers and bundles              | `tauri.conf.json` asks for every bundle type, but no workflow runs a bundling build.                                                                          |
| Code signing, notarization, updates | Not configured. `tauri.conf.json` has no signing settings and there is no updater plugin.                                                                     |

## Setup (historical, 2026-11-07)

- Machine: macOS on Apple silicon, Bun 1.4.4, Rust 1.99.1, Tauri CLI 2.12.4, Docker for Linux.
- Agents: Claude Code 2.1.318 at `~/.local/bin/claude`, Codex CLI 0.166.0 from npm at `~/.npm-global/bin/codex`.
- The Agent SDK is 0.3.319, which bundles Claude Code 2.1.319.
- `generated/CODEX_VERSION` pins 0.166.0, which matches the installed Codex.
- Neither global install was changed.
- Both agents used the user's existing CLI logins. Den did not read, store or proxy any credentials.

## How it builds (historical, 2026-11-07)

- `bun run --cwd apps/daemon build` runs `src/compileDaemon.ts`.
- With no arguments it compiles for the current machine. Any of `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64` and `bun-linux-arm64` can be passed to cross-compile.
- Each output is `apps/daemon/dist/dend-<rust target triple>`, the name Tauri's `externalBin` looks for.
- `tauri.conf.json` points `externalBin` at `../../daemon/dist/dend`, and `desktop#build` depends on `daemon#build` in `turbo.json`.
- Compiled binaries are built with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`, so a `.env` or `bunfig.toml` in the daemon's working directory cannot change its settings.
- `dist` is already ignored by git.

```text
$ bunx turbo run build --filter=desktop
daemon:build:  [374ms] compile  dist/dend-aarch64-apple-darwin
desktop:build:     Finished `release` profile [optimized] target(s) in 1m 58s
 Tasks:    3 successful, 3 total

$ bun src/compileDaemon.ts bun-linux-x64 bun-linux-arm64 bun-darwin-x64
dist/dend-aarch64-apple-darwin:      Mach-O 64-bit executable arm64
dist/dend-aarch64-unknown-linux-gnu: ELF 64-bit LSB executable, ARM aarch64, ... interpreter /lib/ld-linux-aarch64.so.1
dist/dend-x86_64-apple-darwin:       Mach-O 64-bit executable x86_64
dist/dend-x86_64-unknown-linux-gnu:  ELF 64-bit LSB executable, x86-64, ... interpreter /lib64/ld-linux-x86-64.so.2
```

Each binary is 90 to 110 MB.
`bunx tauri build --bundles app` produced a 99 MB `Den.app` with `Contents/MacOS/den` and `Contents/MacOS/dend`.

## How it was checked (historical, 2026-11-07)

- The release app was started from `Den.app/Contents/MacOS/den` with the environment Finder gives an app: `env -i` with `HOME`, `USER`, `SHELL`, `TMPDIR` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.
- The sandbox this spike ran in blocks `open`, so the app was not started through Launch Services.
- The session RPCs are placeholders, so a throwaway script drove the adapters directly. It was compiled with `bun build --compile` and deleted afterwards.
- For the child process checks, a throwaway layer was merged into `main.ts` for one build. It started a setup-script-style shell with grandchildren (`sh -c "sleep 1001 & sleep 1002; wait"`), a `Bun.Terminal` shell, a Claude session and a Codex session. It was removed afterwards.
- A temporary hook called `app.exit(0)` after 16 seconds to exercise the normal quit path, because the sandbox also blocks Apple Events. It was removed afterwards.

## Results (historical, 2026-11-07)

These are the spike's results on the code of that day. Later changes were not rechecked in a packaged app.

| Check                                                     | macOS arm64 (packaged app) | Linux x64 (Docker)      | Linux arm64 (Docker) |
| --------------------------------------------------------- | -------------------------- | ----------------------- | -------------------- |
| Migrations on a fresh data dir, no-op on the second start | Pass                       | Pass                    | Pass                 |
| Claude through the compiled adapter                       | Pass after fixes 2 and 4   | Not run                 | Not run              |
| Codex found at the pinned version, clear mismatch error   | Pass after fixes 3 and 4   | Not run                 | Not run              |
| `Bun.Terminal`: spawn, write, read, resize                | Pass                       | Pass, no job control    | Not run              |
| `Bun.secrets` set, get and delete                         | Pass                       | Fails without a keyring | Not run              |
| Children die on a normal quit                             | Pass after fix 1           | Partial, see below      | Not run              |
| Children die on kill -9 of the app                        | Pass after fix 1           | Partial, see below      | Not run              |
| One real agent turn per agent                             | Pass for both              | Not run                 | Not run              |

### Migrations

Both runs of the packaged app against a fresh `DEN_DATA_DIR` left exactly the two migrations, and a second start added nothing.

```text
$ sqlite3 appdata/den.db "select id, name from __drizzle_migrations"
1|20261107072057_init
2|20261107165335_projectTrust
# second start
$ sqlite3 appdata/den.db "select count(*), max(id) from __drizzle_migrations"
2|2
```

The same held for the linux-x64 and linux-arm64 binaries in `debian:bookworm-slim`.

### Claude

The SDK's own lookup fails inside a compiled binary, as expected:

```text
error: Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.
```

The adapter now finds `claude` on PATH and passes it as `pathToClaudeCodeExecutable`.
The `extractFromBunfs` workaround is not needed, because Den runs the user's own install instead of embedding the SDK's CLI.
A turn through the compiled adapter, with the user's subscription login:

```text
claude checkAuth { status: "loggedIn", account: <redacted> }
claude {"type":"session.started","nativeSessionId":"31a3f68c-..."}
claude {"type":"message.completed","itemId":"msg_011C...:0","text":"den-spike-ok"}
claude {"type":"turn.completed","turnId":"3371c50a-...","result":{"status":"completed"}}
```

The user's CLI (2.1.318) is one patch behind the CLI the SDK bundles (2.1.319), and the turn worked.

### Codex

Installed 0.166.0 equals the pinned 0.166.0, so `checkVersion` passed.
Against the `outdatedCodex.ts` fixture, the mismatch error had no message at all before fix 3. Now it reads:

```text
CodexVersionMismatchError: Den needs Codex 0.166.0, but the installed codex is 0.0.1. Install Codex 0.166.0 to use it with Den.
```

A turn through the compiled adapter, with the user's ChatGPT login:

```text
codex checkAuth { status: "loggedIn", account: <redacted> }
codex {"type":"session.started","nativeSessionId":"01a1b6fc-..."}
codex {"type":"message.completed","itemId":"msg_082f...","text":"den-spike-ok"}
codex {"type":"turn.completed","turnId":"01a1b6fc-...","result":{"status":"completed"}}
```

The npm `codex` is a `#!/usr/bin/env node` script, so it also needs `node` on PATH.

### Bun.Terminal

```text
pty-42        # echo pty-$((40+2))
24 80         # stty size
40 132        # stty size after terminal.resize(132, 40)
```

By default the shell gets the PTY as stdio but not as its controlling terminal (`TTY ??`, `TPGID 0`), so it prints "no job control in this shell" and stays in the daemon's process group.
With `Bun.spawn(..., { terminal, detached: true })` on macOS it becomes a session leader with `ttys005` as its controlling terminal, and job control works.
On Linux it gets no controlling terminal either way (`can't access tty; job control turned off`).

### Bun.secrets

On macOS, under the service `app.den.desktop` with a throwaway value:

```text
secrets get after set: throwaway-value-123
secrets delete: true
secrets get after delete: null
```

In `debian:bookworm-slim`, which has no libsecret and no keyring daemon, every call fails with `Error: libsecret not available`.
Nothing works around it.

### Child processes

On a crash of the packaged app (kill -9 of `den`), every descendant was gone within 8 seconds: the setup script and both `sleep`s, the PTY shell and its `sleep`, `claude` with its MCP servers and Bash tool shell, and the Codex app-server with its helpers, 17 processes in all.

```text
--- while running: app pid 2129, descendants 2387,2404,2407,...,2685,2686
 2404  2387  2404 /bin/sh -c sleep 1001 & sleep 1002; wait
 2410  2387  2125 /Users/.../.local/bin/claude --output-format stream-json ...
 2457  2387  2457 /Users/.../@openai/codex-darwin-arm64/vendor/.../codex app-server
 2409  2387  2409 ttys005  /bin/sh -c sleep 1003; echo done
sent kill -9 to 2129
--- 8s after the app is gone, survivors of 2387,2404,2407,...:
  PID  PPID  PGID COMMAND
```

The normal quit path (`app.exit(0)`) gave the same result.
There is no Tauri shell in the Linux container, so there dend's stdin was closed directly, which is what both quit paths do.
That stopped dend, the setup script group and the PTY shell, but the PTY shell's `sleep 1003` kept running.
It stopped once the release signalled the PTY's process group instead of only the shell (see Terminals below).

## What failed and how it was fixed (historical, 2026-11-07)

1. **dend outlived the app.**
   Before the fix, dend was still running 3 seconds after its stdin closed, so a crashed app left the daemon and everything it started.
   On a normal quit the shell called `CommandChild::kill()`, which sends SIGKILL to dend, so its children were orphaned.
   Now `DaemonConfig` keeps reading stdin after the token and exposes `parentExited`, and `main.ts` closes the daemon's layers when it completes, which releases every scoped process.
   On quit the shell drops its handle instead of killing, which closes stdin, so a normal quit and a crash take the same path.
2. **The compiled daemon could not run the SDK's CLI.**
   `ClaudeAdapterConfig` is now `{ executable }`, `"claude"` by default, the same shape as Codex.
   The adapter resolves it with `Bun.which`, always passes the path to the SDK, and fails with `AgentNotInstalledError` when it is missing.
3. **Agent setup errors had no message.**
   `CodexVersionMismatchError` and `AgentNotInstalledError` now say what failed and what to do.
4. **A Finder-launched app could not find any agent.**
   With launchd's PATH both adapters failed with `AgentNotInstalledError`, because `claude`, `codex` and `node` live in folders only the login shell adds.
   The shell now reads PATH from `$SHELL -ilc` with a 5 second limit and passes it to dend, falling back to its own PATH with a warning.
   That took about 2 seconds here (`-lc` alone took 1 second and missed 6 entries), so the daemon now starts off the setup thread and the window does not wait for it.
   In the packaged app, dend's PATH then had `~/.local/bin` and `~/.npm-global/bin`, and both agents were found.

## Decisions for later work (historical, 2026-11-07)

- **Terminals.** Spawn PTY shells with `detached: true` and stop them by signalling the process group (`process.kill(-pid, "SIGHUP")`).
  In the Linux container, sending SIGHUP only to the shell left its `sleep` running, and signalling the group stopped it.
  On Linux the shell still gets no controlling terminal, so job control needs another fix, such as `setsid --ctty`, when terminals are built.
- **A crash of dend itself is not covered.**
  After kill -9 of dend, the setup script group and `claude` with its tool shell kept running on macOS, while the PTY and the Codex app-server stopped.
  On Linux the setup script and the PTY kept running.
  The app crashing is covered, because dend survives it and cleans up.
  Covering dend crashing needs a supervisor or children that watch their stdin, and is left open.
  Since closed without a supervisor: the next dend stops what a crashed one left (architecture section 3.3).
- **Keychain on Linux.** `Bun.secrets` needs libsecret and a running Secret Service (GNOME Keyring or KWallet).
  The UI has to say that clearly instead of failing on save.
- **Claude.** The adapter runs the user's own `claude`. Den does not embed or extract the SDK's CLI.

## Still unverified (as of 2026-11-07)

- The darwin-x64 binary was compiled but not run, because this machine has no Rosetta, and no x64 or Linux Tauri app was built.
- The app was not started through Finder or `open`, only with Finder's environment.
- Code signing, notarization and how keychain access prompts behave for a signed app.
- Agents, `Bun.secrets` and the kill -9 of the app on Linux, because the container had no agent CLIs, keyring or Tauri shell.
- Whether the UI reaches the daemon in the packaged app. Only the ready line, the database and the processes were checked.
- The 5 second grace from section 3.3 and the shutdown RPC, which are not built yet.
