# Swarm

Swarm is an open-source desktop app for running Claude Code and Codex in parallel.
Each task runs in its own workspace: a git worktree, or the project folder itself.
This file is the contract for everyone who writes code here, human or agent.
Architecture decisions will live in `docs/architecture.md`.

## Principles

- Write the minimum code that solves the real problem. No speculative abstractions, options or config.
- Never overcomplicate. If a stranger cannot follow it on first read, simplify it.
- DRY: one source of truth for every fact. Split logic into small functions and composable modules.
- Match the existing style, structure and naming. Reuse existing utilities before writing new ones.
- If it can be automated, automate it.
- Verify before claiming done. Run the gates below.

## Stack

Do not swap any of these without a discussion first.

| Concern                                  | Choice                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Runtime, package manager, tests, bundler | Bun only. Never Node.js, npm, pnpm or yarn.                               |
| Monorepo                                 | Turborepo with Bun workspaces                                             |
| Language                                 | TypeScript, strict                                                        |
| Effects, errors, services                | Effect                                                                    |
| Validation                               | Effect Schema. Never Zod in our code.                                     |
| UI                                       | Next.js                                                                   |
| API                                      | Hono                                                                      |
| Databases                                | Drizzle with SQLite (`bun:sqlite`) locally and Neon Postgres in the cloud |
| Auth                                     | Better Auth                                                               |
| Email                                    | Resend                                                                    |
| Background jobs                          | Effect queues locally. BullMQ on Redis in the cloud only.                 |
| Lint and format                          | Biome. Never ESLint or Prettier.                                          |

## Repo layout

- `apps/*` are things we run or ship: the desktop app, web app, API.
- `packages/*` are shared libraries. Each does one job, and its name says which.
- Import a package only through its `exports`. Never reach into another package's files.

## Naming

- A name says what the code does: `sendEmail.ts`, `createWorktree.ts`. Never `utils.ts`, `helpers.ts`, `misc/` or `common/`.
- Files and source folders use camelCase: `sendEmail.ts`, `agentAdapters/`. Never snake_case or kebab-case.
- React component files use PascalCase and match their export: `WorkspaceList.tsx`.
- Package folders use kebab-case to match their npm name (`packages/db-local`), because npm names must be lowercase.
- Framework-reserved files keep the framework's names: `page.tsx`, `layout.tsx`, `route.ts`.
- Tests sit next to the code they test: `createWorktree.test.ts`.

## TypeScript

- No `any`. Use `unknown` and narrow it.
- No `as` casts, except `as const` and after a value was decoded by a schema.
- Let inference work. Annotate public function boundaries, not every local.
- Derive types from one source: `typeof`, `Schema.Type`, Drizzle's `$inferSelect`. Never hand-write a type that copies a schema.
- Model states as discriminated unions, not as booleans or optional fields that depend on each other.
- Use string literal unions and `as const` objects, not `enum`.
- Use `satisfies` to check config objects without widening them.
- Never loosen compiler settings to silence an error. Fix the type.

## Effect

- Every side effect (files, processes, network, database, clock) is an `Effect`. Pure logic stays a plain function.
- Errors are values. Define a `Data.TaggedError` per failure and handle it with `Effect.catchTag`.
- No `throw` and no `try`/`catch` in app code. Wrap promises with `Effect.tryPromise` and map them to a tagged error.
- Dependencies are services provided through `Layer`. No module-level singletons or globals.
- Decode every external input with Effect Schema at the boundary: HTTP bodies, agent CLI output, env vars, files, JSON columns. Inside the boundary, trust the types.
- Read configuration through Effect `Config`, never from `process.env` or `Bun.env` directly.
- Acquire processes, PTYs, watchers and connections with `Effect.acquireRelease` so they are always released.
- Log with `Effect.log*` and trace with `Effect.withSpan`. No `console.log` in committed code.
- Check the installed Effect version's docs before using an API you have not seen in this repo.

## Agents and jobs

- Swarm orchestrates Claude Code and Codex. It does not implement its own agent loop.
- Every agent sits behind one adapter interface. Agent-specific code stays inside its adapter.
- Keep the daemon stateless: durable state lives in the database, not in memory. A restart loses only in-flight output.
- Run slow work as async jobs. Never block a request on an agent run, script or clone.
- Make every session, job and script observable: status, logs and spans.
- Automations we build are agents designed as loops with evals. Measure them on real runs before trusting them, then improve from the results.
- Memory is a product feature. Cap buffers like terminal scrollback and streamed output, stream instead of loading whole files, and release everything when a workspace closes.

## Data

- SQLite holds what happens on the user's machine: projects, workspaces, agent sessions and their events.
- Neon holds what is shared: users, orgs, members, invitations and cloud features.
- Never send local code, chats or terminal output to Neon.
- Secrets (API keys, auth tokens) live in the OS keychain. Never in a database, a log or a committed file.
- Change schemas only through Drizzle migrations. Never edit a migration that has been applied.
- Wrap multi-row writes in a transaction at the isolation level the invariant needs.
- Cache only what is measured to be slow. Partition or shard only when the data demands it.
- IDs are text. Better Auth tables use Better Auth's IDs. Our tables use UUIDv7.

## Generated files

Never hand-edit these. Regenerate them with their tool:

- `bun.lock`
- Drizzle migrations and the Better Auth schema
- `CHANGELOG.md`
- `next-env.d.ts`
- The Turborepo and Next.js managed blocks in `AGENTS.md` files

## Tests

- Use `bun test`. Test behavior through public functions, not internals.
- A bug fix starts with a failing test that reproduces the bug.
- New behavior ships with tests for the main path and the edge cases that matter.
- Unit tests never touch the network or real agent CLIs. Provide test layers instead.

## Gates

Run these before calling work done. All must pass.

```bash
bun run lint
bun run check-types
bun run build
```

Run `bun test` too once the package you changed has tests.
`bun run format` fixes formatting and import order.
The pre-commit hook runs Biome on staged files and then the typecheck. Never bypass it with `--no-verify`.

## Commits and pull requests

- Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- One concern per commit and per pull request. Never mix a refactor into a feature.
- Do not add AI agents as commit co-authors.
- Flag breaking changes, migrations and risky rollouts in the description.
- A pull request says what changed, why, and how it was verified.

## Writing

- Never use em dashes in code, comments, UI copy or docs. Use a plain hyphen.
- Comments explain why, not what.
- In long Markdown, put one sentence per line.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
