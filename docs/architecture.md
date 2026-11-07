# Den architecture

This document records how Den is built and why.
`AGENTS.md` says how to write code; this file says what the code must do.
When code and this file disagree, fix one of them in the same pull request.
Items marked **Open** are decisions we have not made yet.

## 1. System overview

```
Desktop machine
  Tauri shell (Rust, small)
    webview: Next.js static export (UI only, no secrets)
      Effect RPC over WebSocket, 127.0.0.1, per-launch token
    dend (Bun sidecar, Effect)
      SQLite, git, gh, terminals, scripts
      ClaudeAdapter -> Claude Agent SDK -> claude CLI
      CodexAdapter  -> codex app-server (JSON-RPC over stdio)

Cloud
  apps/api (Hono on Bun): Better Auth, orgs, invites, cloud workspaces, relay
  Neon Postgres: users, orgs, members, invitations, cloud workspace records
  Redis + BullMQ: provisioning and reconcile jobs
  apps/worker: drives the SandboxProvider (Vercel Sandbox)
  Sandbox: the same dend binary, dialing out to the relay
```

- One daemon binary runs in two homes: as the desktop sidecar and inside a cloud sandbox.
- The UI talks to both through the same RPC contract (`packages/contracts`). A cloud workspace reaches its daemon through the relay instead of localhost.
- Local workspace data (code, chats, terminal output) stays on the machine. Neon stores accounts, orgs and cloud workspace records only.
- **Product bar.** Everything Conductor and Paradev do is the floor, not the target. Someone moving from either tool must not lose a feature they relied on, and should find more.
- **Workspaces and sessions.** A project has many workspaces, and a workspace has many agent sessions running at once, of either agent.
  - Sessions in one workspace share its folder and branch, so each sees the others' edits. Use this when agents should work on the same code, for example one implementing while another reviews or fixes tests.
  - Each session has its own transcript, approvals, turn queue and status.
  - Work that must not share a checkout goes in separate workspaces.

## 2. Accounts and agent authentication

A Den login authenticates the user to Den only.
It never authenticates Claude or Codex, and Den never sends agent credentials to its own servers.

### 2.1 What each provider permits (checked 2026-11-07)

- **Claude.** Anthropic's Agent SDK docs say that, unless previously approved, third-party developers may not offer claude.ai login or subscription rate limits in their products, and should use API keys (or Bedrock, Vertex AI, Azure).
- **Codex.** `codex app-server` is OpenAI's interface for rich clients. It has its own ChatGPT login flow (`account/login/start` with `chatgpt`, then `account/login/completed`), and Codex stores the resulting tokens itself. We found no official OpenAI statement on third-party use of ChatGPT plans. **Open:** confirm with OpenAI before we advertise ChatGPT plan support.

### 2.2 Auth modes

| Mode               | Claude                                                                                                                                                                                  | Codex                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey` (default) | User pastes an Anthropic key. Stored in the OS keychain. Passed only as `ANTHROPIC_API_KEY` to the child process.                                                                       | User pastes an OpenAI key. Stored in the OS keychain. Passed only as `OPENAI_API_KEY` to the child process.                                                                 |
| `nativeLogin`      | Off until Anthropic approves it in writing. If enabled, Den spawns the user's own `claude` CLI, which uses the login the user created with `claude` itself. Den never reads that login. | The user signs in through `codex app-server` (`account/login/start`), which opens the browser and stores tokens in Codex's own files. Den only reads `account/read` status. |

- Den never reads, copies, refreshes or proxies OAuth tokens for either provider. We do not use the Codex "external tokens" login mode.
- `checkAuth` reports `loggedIn`, `loggedOut` or `unknown`, plus an account label when the CLI prints one.
- **Account switching.** Credentials are keyed by provider and account label in the keychain. A session records which credential it started with. Switching the active credential affects new sessions only; running sessions keep theirs until they end.
- **Expiry and revocation.** API keys do not expire, but they can be revoked. A provider auth failure is a permanent error (`AgentAuthError`), which stops the turn and asks the user to fix the credential. Native logins refresh inside the CLI; Den only sees the result through `checkAuth`.

### 2.3 Cloud workspaces

- Cloud workspaces support `apiKey` mode only in the MVP. Moving a native login into a sandbox would mean Den handles OAuth tokens.
- See section 4 for how a sandbox gets its keys.

## 3. Daemon

### 3.1 Start-up

1. Tauri generates a 32-byte token, spawns `dend` and writes the token as the first line on its stdin. It never goes in the environment, which every agent, script and git process inherits.
2. `dend` opens SQLite (WAL, foreign keys, 5 s busy timeout), runs embedded migrations, then recovers interrupted work (section 6).
3. It binds `127.0.0.1` on a random port and prints `DEN_DAEMON_READY <url>`.
4. Tauri hands `{ url, token }` to the UI through the `daemon_connection` command.

- Migrations are embedded in the compiled binary. A compiled daemon needs no files on disk besides its data directory.
- The daemon exits when its parent shell dies (stdin closes). It never outlives the app.
- There is one shutdown path, for SIGTERM, SIGINT, stdin closing and the `shutdown` RPC.
  The daemon logs the reason and closes its layers in reverse order: the HTTP server, then workspace runtimes and their children, then the process registry, then SQLite after a WAL checkpoint.
- A clean shutdown exits 0.
  If a finalizer hangs past 8 s, or a second signal arrives, the daemon exits 1 at once.

### 3.2 Ownership

- Agent processes, terminals, setup scripts and watchers belong to a **workspace runtime** in the daemon, never to an RPC call or a UI subscription.
- A UI subscription only reads. Closing it never stops work.
- Each workspace runtime owns one Effect `Scope`. Stopping the workspace closes that scope, and every process in it is released with `Effect.acquireRelease`.

### 3.3 Lifecycles

| Action              | What happens                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Close a tab         | The UI unsubscribes. Nothing stops.                                                                                                                                                                                                                                                                                                                 |
| Close the window    | macOS: the app keeps running in the dock and agents keep working. Linux: same as quit.                                                                                                                                                                                                                                                              |
| Quit Den            | The UI warns if turns are running or approvals are pending. Then the shell closes the daemon's stdin (later the `shutdown` RPC), hides its windows and waits up to 10 s, off the UI thread, before killing it. The daemon stops every workspace runtime (below).                                                                                    |
| Stop a workspace    | Pending approvals resolve as `cancelled`. Running turns are interrupted and their sessions become `interrupted`. Terminals get SIGHUP. Setup scripts get SIGTERM, and their jobs return to `pending` so they can be retried. Files are untouched.                                                                                                   |
| Archive a workspace | Stop it first. If the worktree has uncommitted changes or unpushed commits, archive fails with `WorkspaceHasUnsavedWork` unless the user forces it. A forced archive saves changes with `git stash push --include-untracked -m den-archive/<workspaceId>`, then removes the worktree and keeps the branch. An in-place archive never deletes files. |

- Every child (setup and run scripts, agents, terminals) runs in its own process group, so a stop reaches its grandchildren too.
  A stop sends SIGTERM to the group (SIGHUP for terminals), then SIGKILL after a 5 s grace.
- While a child runs, its group is recorded in `children.json` in the data directory, readable only by the user.
  On start-up the daemon stops every recorded group a crashed daemon left, then clears the file.
  It skips a live pid whose start time does not match the record, because that pid now belongs to another process.

## 4. Cloud credentials and recovery

**Decision for the MVP: the sandbox waits for the desktop.**

- Keys live in the desktop keychain. When a cloud workspace starts, the desktop sends the keys it needs through the relay. The sandbox daemon keeps them in memory only.
- If the sandbox restarts (sleep, crash, new instance), its memory is gone. The daemon comes back in state `awaitingCredentials`. Agent turns cannot start until a desktop of an authorized member reconnects and sends keys again. The UI shows this state.
- When the user revokes or replaces a key on the desktop, the desktop pushes the change. The sandbox drops the old key and interrupts sessions that use it.
- This means a cloud workspace keeps working while the laptop sleeps, but it cannot _resume after its own restart_ while every member is offline.
- **Open:** a backend secret service (envelope encryption with a cloud KMS, never plain rows in Neon) would remove that limit. We revisit after the MVP.

## 5. Resuming a cloud workspace

What must survive a sandbox stop:

| Data                                                                         | Where it lives                 | How it survives                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| Repository, including uncommitted changes                                    | Sandbox filesystem             | Vercel persistent sandbox: the filesystem is saved on stop and restored on resume |
| Den SQLite (sessions, events, jobs)                                          | `$DEN_DATA_DIR` in the sandbox | Same filesystem                                                                   |
| Native agent transcripts (`~/.claude/projects/...`, `~/.codex/sessions/...`) | Sandbox home directory         | Same filesystem. Resuming by `nativeSessionId` needs these files.                 |
| Agent and Den config, minus secrets                                          | Sandbox home and data dir      | Same filesystem                                                                   |
| Keys                                                                         | Memory only                    | Re-sent by the desktop (section 4)                                                |

Resume order after a stop or sleep:

1. The worker resumes the sandbox with `Sandbox.getOrCreate({ name: <workspaceId>, resume: true })`.
2. A small supervisor in the sandbox image starts `dend`.
3. `dend` migrates, recovers interrupted work (section 6), and dials the relay with its workspace credentials.
4. The api records the new `sandboxInstanceId` and drops connections from older instances.
5. The daemon waits in `awaitingCredentials` until a desktop sends keys. Then sessions resume through their native ids.

## 6. Jobs, states and recovery

The rules are in `AGENTS.md`, under "States, retries and fallbacks". In short:

- Jobs use `pending`, `processing`, `completed`, `failed`, `deadLetter`, plus `attempts` and `lastError`. One `transition` function per machine allows only legal moves.
- Retryable failures return to `pending` with exponential, jittered backoff. When attempts run out the job goes to `deadLetter`, and only the user retries it from there.
- On start-up, rows still in `processing` count as retryable failures. Agent sessions left `running` or `awaitingApproval` become `interrupted`.

## 7. Agent adapters

```ts
interface AgentAdapter {
	readonly kind: "claude" | "codex";
	readonly capabilities: AgentCapabilities;
	checkAuth: Effect<AgentAuthStatus, AgentError>;
	startSession(input: StartSessionInput): Effect<AgentSessionHandle, AgentError, Scope>;
}
```

- **Capabilities differ by agent.** For example: resume, interrupt, file-change approvals, MCP approvals, steering a running turn, and available models. The UI reads capabilities instead of assuming both agents behave the same.
- **Approvals are per request.** `approval.requested` carries its own `choices` (a subset of `allowOnce`, `allowForSession`, `deny`). A decision outside `choices` is rejected.
- **No native id yet.** A session exists before the agent reports its native id. The handle exposes the id as an effect that waits for it, and `session.started` carries it. Messages sent before then are queued.
- **One turn at a time.** A message sent during a turn waits in a bounded queue of 8, or steers the turn when the adapter supports it and the user asks. A full queue fails with `SessionBusyError`.
- **Interrupt during an approval.** Pending approvals resolve as `cancelled` first, then the turn is interrupted.
- **Unknown server requests** (Codex) get a JSON-RPC "method not found" reply at once and a non-fatal `error` event. Nothing is left hanging.
- **Pinned Codex.** Protocol types are generated from a specific Codex version, recorded in `generated/CODEX_VERSION`. The adapter checks `codex --version` and fails with `CodexVersionMismatchError` on a mismatch. Releases bundle that Codex version.
- **Claude executable.** Inside a compiled Bun binary the SDK cannot find its own CLI, so the adapter takes an explicit `pathToClaudeCodeExecutable`.
- **Project trust.** A repo's own agent settings (for Claude, `.claude/settings.json`) can add hooks that run commands and rules that skip approvals. They load only for projects the user has marked trusted, which is stored on the project row. Untrusted sessions load only the user's own settings and always start in the default permission mode.
- **Session approvals.** "Allow for session" only adds allow rules, and only for the current session. It never changes the permission mode, adds directories or writes a settings file.
- A `ReplayAdapter` plays recorded fixtures so sessions, approvals and the UI are tested without real agents.

## 8. Events and replay

- Every stored event has `(sessionId, sequence)`, which is UNIQUE and gapless per session. The daemon assigns the sequence and writes the row before it publishes.
- Streaming deltas are live only. They have no sequence and are never stored. The completed message is stored.
- **Subscribe with a cursor.** `subscribe(sessionId, afterSequence)`:
  1. Subscribe to the live `PubSub` first and buffer.
  2. Page stored rows where `sequence > afterSequence`, 200 at a time, and send them.
  3. Drain the buffer, skipping anything already sent, then stream live.
     This leaves no gap between history and live events.
- **Slow clients.** Each subscriber has a bounded buffer (1,000 events or 1 MB). On overflow the subscription ends with `ResubscribeRequired`, and the client resubscribes from its last sequence.
- History in the UI is paginated with the same cursor.

## 9. Relay protocol (cloud)

- **Sandbox side.** At provisioning the worker mints a relay credential bound to `(workspaceId, sandboxInstanceId)`, short-lived and renewed over the connection. The api accepts a sandbox connection only if that pair matches the current row. A newer instance supersedes the old one.
- **Desktop side.** The desktop connects with its Better Auth session. The api checks server-side that the user is a member of the workspace's org on connect, and again on every `MembershipEvents` change (member removed, role changed). On a change it closes that user's connections.
- **Envelope.** Every request carries `requestId` (UUIDv7, set by the client), `deadline`, and for state-changing calls an `idempotencyKey`.
- **No accidental repeats.** The daemon stores `(idempotencyKey, status, result)` for consequential commands: send message, approve, run script, commit, push, open PR, archive. A retried key returns the stored result instead of running the command again.
- **Reconnect.** Both sides reconnect with exponential, jittered backoff. Subscriptions resume from their last sequence (section 8). Reads may retry freely; writes retry only with the same idempotency key.
- **Routing.** In the MVP one api instance holds both ends of a workspace. Scaling out routes through Redis pub/sub per workspace. (Later.)

## 10. Cloud provisioning

`cloudWorkspace` separates what the user asked for from what exists:

- `requestedState`: `running`, `stopped` or `archived`. Set by the user.
- `observedState`: `provisioning`, `running`, `sleeping`, `stopped`, `failed` or `unknown`. Set from the provider.
- Also `provisioningStep`, `sandboxInstanceId`, `attempts`, `lastErrorCode`, `lastErrorMessage`, `lastSeenAt` and timestamps.

Rules:

- **No duplicate sandboxes.** The sandbox name is the workspace id, and the worker uses `getOrCreate` by name. The BullMQ job id is the workspace id plus the requested transition. A retried job finds the existing sandbox instead of creating a new one.
- **Progress.** Each step (create, clone, setup, start daemon) writes `provisioningStep` before moving on, so a retry continues where it stopped.
- **Reconcile.** A repeating job compares Neon with the provider. It stops sandboxes whose row says stopped or archived, or that have no row (orphans), and marks rows `unknown` when the provider has no sandbox.
- **Limits.** The sandbox stops after 30 minutes of inactivity (the daemon reports activity). Each sandbox has a hard runtime limit and fixed CPU and memory per plan. Exact values: **Open**.
- **Failed setup.** The sandbox is stopped, the row becomes `failed` with error details, and the user can retry or archive.

## 11. Data invariants

- **Local IDs** are UUIDv7 text. Times are ISO strings.
- **Active paths are unique.** There is a partial unique index on `workspace.path` where `status = 'active'`, so one folder never has two active workspaces, in place or not.
- **Foreign keys:**
  - A project cannot be deleted while it has active workspaces. Deleting it cascades to archived ones.
  - A workspace cascades to its sessions, events and script runs.
  - In Neon, deleting an org cascades to its cloud workspaces, and deleting the user who created one is restricted.
- **Sessions per workspace** are unlimited in the schema. Only the daemon-wide cap on concurrent sessions (section 14) applies.
- **Event order** is `sequence` per session, never time.
- **No raw output** is stored. Script output keeps the last 64 KB or 2,000 lines in memory, whichever is smaller.

## 12. Web app and deployment

- `apps/web` is one Next.js app, always built as a static export. No Next.js server exists in any deployment.
- Desktop routes run inside Tauri and talk only to the daemon.
- Hosted pages (sign-in, device approval, invite accept) are static client pages served from a static host. They call `apps/api` from the browser, with credentials, and the api allows only the configured web origin.
- **API shutdown.** On SIGTERM or SIGINT the api stops accepting connections, waits up to `API_SHUTDOWN_GRACE` (10 s) for requests in flight, closes the database client and exits 0.
  If cleanup hangs 5 s past the grace, or a second signal arrives, it exits 1 at once.
- The only build-time variables are `NEXT_PUBLIC_*` values that are safe to publish, such as the api URL. Server secrets live only in `apps/api` and `apps/worker`.

## 13. Packaging (validate before building more features)

A release spike comes right after the current merge and before milestone 5:

1. Build a real Tauri release containing the compiled `dend` for macOS (arm64 and x64) and Linux (x64 and arm64), from the same daemon code with `bun build --compile --target`.
2. In the packaged app, check each of these:
   - SQLite migrations run.
   - The Claude CLI path works when compiled.
   - Codex is found at the pinned version.
   - `Bun.Terminal` works.
   - Keychain read and write through `Bun.secrets` works.
   - Every child process dies when the app quits or crashes.
3. Run one real agent turn per agent in the packaged app.

The spike ran on 2026-11-07. Results, evidence and open items are in [packaging-spike.md](packaging-spike.md).
It changed these decisions:

- `dend` exits when its stdin closes, which section 3.1 asked for. Until the `shutdown` RPC exists, quitting closes stdin instead of killing the daemon.
- The Claude adapter runs the user's own `claude` from PATH. Den does not embed or extract the SDK's bundled CLI.
- The shell starts `dend` with the PATH of the user's login shell, because an app opened from Finder cannot otherwise find `claude`, `codex` or `node`.
- Terminals spawn with `detached: true` and are stopped by signalling their process group.
- A crash of `dend` itself leaves children running until the next start, which stops them from the process registry (section 3.3).

## 14. Memory and privacy

- **Caps by bytes and lines.**
  - Terminal scrollback: 5,000 lines or 2 MB.
  - Script output: 64 KB or 2,000 lines.
  - Subscriber buffers: 1,000 events or 1 MB.
- **Limits.** One file watcher per open workspace. Concurrent agent sessions are capped (default 8, configurable).
- **Measure the whole thing.** Report the combined memory of the shell, the webview processes, the daemon and the agent processes, measured by a script in the repo against the same task in other tools. We publish only claims we measured.
- **Privacy statement.** Den keeps local workspace data on your machine. The agents you configure still send context to their model providers under those providers' terms. Native agent histories (Claude Code and Codex transcripts) may keep output that Den itself drops.

## 15. Open decisions

- Claude `nativeLogin`: needs written approval from Anthropic.
- Codex with ChatGPT plans in third-party clients: confirm with OpenAI.
- A backend secret service for cloud workspaces that restart while everyone is offline.
- Sandbox idle, runtime and resource limits.
