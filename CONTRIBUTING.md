# Contributing to Den

Thanks for helping.
This guide covers how to set up, what a good change looks like and how it gets merged.
The coding rules are in [AGENTS.md](AGENTS.md), and the design is in [docs/architecture.md](docs/architecture.md).

## Before you start

- For a bug, open an issue with steps to reproduce it, unless it is a one-line fix.
- For a feature or a design change, open an issue first so we can agree on the approach before you write code.
- Security issues never go in public issues. See [SECURITY.md](SECURITY.md).

## Setup

Follow the Local Development section of the [README](README.md).
`bun run setup` starts Postgres and Redis in Docker and applies the migrations, and the API applies new migrations every time it starts in development.

| Command                             | What it does                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bun run dev`                       | Runs the web UI, the API and the desktop app with its daemon. The API applies pending migrations first. |
| `bun test`                          | Runs all tests.                                                                                         |
| `bun run lint`                      | Checks formatting and lint rules with Biome. `bun run format` fixes them.                               |
| `bun run check-types`               | Type-checks every package.                                                                              |
| `bun run build`                     | Builds every app.                                                                                       |
| `bun run db:up` / `bun run db:down` | Starts or stops the local Postgres and Redis.                                                           |
| `bun run db:migrate`                | Applies pending cloud database migrations.                                                              |

| Path                     | What it is                                                 |
| ------------------------ | ---------------------------------------------------------- |
| `apps/desktop`           | Tauri shell that starts the daemon and loads the UI        |
| `apps/web`               | Next.js UI, built as a static export                       |
| `apps/daemon`            | `dend`: local database, git, workspaces and agent adapters |
| `apps/api`               | Hono API: accounts, organizations and invitations          |
| `packages/contracts`     | Schemas and RPC definitions shared by the apps             |
| `packages/auth`          | Better Auth configuration                                  |
| `packages/db-cloud`      | Postgres schema, migrations and database service           |
| `packages/email`         | Transactional email through Resend                         |
| `scripts/sortImports.ts` | Keeps imports ordered from the longest to the shortest     |

The repo uses TypeScript 7, the native compiler, which no longer ships the `tsserver` that most editors load.
Editors that use the workspace TypeScript through `tsserver` show false "Cannot find module" errors.

- **Zed:** install the "TypeScript Language Server" extension. The repo's `.zed/settings.json` already selects it and pins TypeScript 7.0.2.
- **VS Code:** install the "TypeScript (Native Preview)" extension.

## Making a change

1. Branch from `main`.
2. Keep the change to one concern. A refactor and a feature are two pull requests.
3. Add or update tests. A bug fix starts with a test that fails without the fix.
4. Run the gates. All of them must pass:

```bash
bun run lint
```

```bash
bun run check-types
```

```bash
bun test
```

```bash
bun run build
```

The pre-commit hook runs Biome and the type check. Never skip it with `--no-verify`.

## Database changes

- Change `schema.ts`, then generate the migration and commit it with the change:
  - Cloud database: `bun run --cwd packages/db-cloud generate:migration`
  - Local database: `bun run --cwd apps/daemon db:generate`, then add the new folder to `apps/daemon/src/database/embeddedMigrations.ts`
- Never edit a migration that has been merged.
- CI fails if a schema change has no migration, or if the migrations do not apply cleanly to an empty database.

## Generated files

Never edit these by hand: `bun.lock`, Drizzle migrations, the Better Auth schema, the Codex protocol types, `CHANGELOG.md` and `next-env.d.ts`.
Regenerate them with their tool.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:`. Releases and the changelog are generated from them.
- Mark a breaking change with `!` (`feat!: ...`) and explain the migration path in the body.
- A pull request says what changed, why, and how you verified it.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).
It keeps a release pull request open with the next version and the changelog.
Merging that pull request tags the commit `vX.Y.Z` and publishes a GitHub release.
Nobody tags or edits the changelog by hand.

Until 1.0, versions move slowly on purpose:

- `fix:` and `feat:` bump the patch version, so 0.1.0 becomes 0.1.1.
- A breaking change (`feat!:` or a `BREAKING CHANGE:` footer) bumps the minor version, so 0.1.1 becomes 0.2.0.
- `docs:`, `chore:`, `refactor:` and `test:` do not bump the version.

Merge the release pull request only when there is a build worth shipping, not after every change.
It keeps collecting changes while it stays open, so one release can cover many merged pull requests.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
