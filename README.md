# Swarm

Run Claude Code and Codex in parallel, one task per workspace.

Swarm is an open-source desktop app for working with coding agents.
Each task gets its own workspace: a git worktree on its own branch, or the project folder itself.
Swarm orchestrates the agents' own loops, shows their work as it streams, asks you to approve risky actions, and helps you review the diff and open a pull request.
It is built to stay small: a Tauri shell, a static UI and one Bun daemon.

> **Status: pre-alpha.** The foundations, projects, workspaces and agent adapters exist. The app is not usable end to end yet.

## How it works

- **Projects** are git repositories you add from your machine.
- **Workspaces** are worktrees of a project. Create as many as you like and run them in parallel.
- **Agents** run inside a workspace. Swarm talks to `codex app-server` and the Claude Agent SDK, and never implements its own agent loop.
- **Your data stays local.** Code, chats and terminal output stay on your machine. The agents you configure still send context to their model providers under those providers' terms.
- **Bring your own keys.** Agent API keys live in your OS keychain and are passed only to the agent processes.

The design, with every decision and its reasons, is in [docs/architecture.md](docs/architecture.md).

## Development

You need [Bun](https://bun.sh) 1.4.4 or later, [Rust](https://rustup.rs) 1.90 or later, [Docker](https://www.docker.com) and git.
To work on agents, install the [Codex CLI](https://github.com/openai/codex) and [Claude Code](https://code.claude.com).

```bash
cp .env.example .env
```

```bash
bun run setup
```

`setup` installs dependencies, starts Postgres and Redis in Docker, and applies the database migrations.

| Command                             | What it does                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bun run dev`                       | Runs the web UI, the API and the desktop app with its daemon. The API applies pending migrations first. |
| `bun test`                          | Runs all tests.                                                                                         |
| `bun run lint`                      | Checks formatting and lint rules with Biome. `bun run format` fixes them.                               |
| `bun run check-types`               | Type-checks every package.                                                                              |
| `bun run build`                     | Builds every app.                                                                                       |
| `bun run db:up` / `bun run db:down` | Starts or stops the local Postgres and Redis.                                                           |
| `bun run db:migrate`                | Applies pending cloud database migrations.                                                              |

## Repository layout

| Path                    | What it is                                                   |
| ----------------------- | ------------------------------------------------------------ |
| `apps/desktop`          | Tauri shell that starts the daemon and loads the UI          |
| `apps/web`              | Next.js UI, built as a static export                         |
| `apps/daemon`           | `swarmd`: local database, git, workspaces and agent adapters |
| `apps/api`              | Hono API: accounts, organizations and invitations            |
| `packages/contracts`    | Schemas and RPC definitions shared by the apps               |
| `packages/auth`         | Better Auth configuration                                    |
| `packages/db-cloud`     | Postgres schema, migrations and database service             |
| `packages/email`        | Transactional email through Resend                           |
| `packages/import-order` | Keeps imports ordered from the longest to the shortest       |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md), the rules every change follows.
Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
