# Swarm

Swarm is an open-source desktop app for running Claude Code and Codex in parallel.
Each workspace is a git worktree or the project folder itself, and runs any number of agent sessions side by side.
Everything Conductor and Paradev do is the floor for Swarm, not the target.
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
Always use the latest stable release of every tool and dependency.
Look the version up on the registry when adding or upgrading, never from memory, and use beta, rc or canary releases only when agreed.

| Concern                                  | Choice                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Runtime, package manager, tests, bundler | Bun only. Never Node.js, npm, pnpm or yarn.                               |
| Monorepo                                 | Turborepo with Bun workspaces                                             |
| Language                                 | TypeScript, strict                                                        |
| Effects, errors, services                | Effect 4                                                                  |
| Validation                               | `Schema` from `effect`. Never Zod in our code.                            |
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
- A file whose main export is a component or class (Effect service, error, schema class) uses PascalCase and matches it: `WorkspaceList.tsx`, `WorktreeManager.ts`.
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
- Order imports from the longest line to the shortest. `bun run format` does it, and `bun run lint` fails when the order is wrong.

## Effect

We use Effect 4.
Its APIs differ from Effect 3, so never copy v3 code (`Context.Tag`, `Effect.Service`, `Data.TaggedError`, `Effect.catchAll`).
Follow Effect's own guide, [`LLMS.md`](https://github.com/Effect-TS/effect/blob/main/LLMS.md), and the installed source in `node_modules/effect`.

### Where Effect runs

- The daemon, the API and every shared package are written in Effect. Pure logic stays a plain function.
- React components stay plain React. They reach Effect code only through the app's `ManagedRuntime`.

### Writing effects

- Write inline code with `Effect.gen`.
- Write reusable functions with `Effect.fn("functionName")`, where the name matches the function. Use `Effect.fnUntraced` on hot paths and small internal helpers.
- Never write a function that only wraps and returns `Effect.gen`.
- Add behavior with combinators: `.pipe(...)` on effects, extra arguments to `Effect.fn`. Never call `.pipe` on an `Effect.fn`.
- Raise an error with `return yield* new SomeError(...)`, so TypeScript knows the code stops there.

### Errors

- Define one `Schema.TaggedError` class per failure, named for what failed: `WorktreeCreateError`.
- Handle errors with `Effect.catchTag` or `Effect.catchTags`. Use `Effect.catch` only as a last fallback.
- No `throw` and no `try`/`catch`. Wrap promise APIs with `Effect.tryPromise({ try, catch })` and map the failure to a tagged error.
- Keep an unexpected underlying error in a `Schema.Defect()` field named `cause`.

### Services and layers

- Put behavior in services: `class Name extends Context.Service<Name, Interface>()("swarm/<package>/<path>/Name")`.
- Give each service a `static readonly layer` built with `Layer.effect`, and return the implementation with `Name.of({...})`.
- Compose layers with `Layer.provide` and `Layer.provideMerge`. No module-level singletons or globals.
- Use `Context.Reference` for settings and flags that have a default value.

### Validation, config and time

- All validation and domain modeling uses `Schema`. Decode untrusted input at the boundary: HTTP bodies, agent CLI output, files, env vars, JSON columns. Inside the boundary, trust the types.
- Never hand-write parsing or type checks. Runtime guards come from `Predicate`, never home-made helpers like `isRecord`.
- Read configuration with `Config` and secrets with `Config.Redacted`. Never read `process.env` or `Bun.env` directly.
- The one exception is `NEXT_PUBLIC_*` variables in Next.js browser code, which Next.js inlines from `process.env` at build time.
- Use `DateTime` and `Clock` for time. Never `Date` or `Date.now`.

### Resources and concurrency

- Acquire processes, PTYs, watchers and connections with `Effect.acquireRelease`, scoped to the workspace or session that owns them.
- Run background loops as `Layer.effectDiscard` with `Effect.forkScoped`.
- Use `PubSub` for in-process events, `Stream` for data over time and `Schedule` for retries and polling.
- Spawn commands such as `git`, `gh` and the agent CLIs with the `effect/process` modules.

### Running and observing

- Start each process with `BunRuntime.runMain` from `@effect/platform-bun`, launching the main layer with `Layer.launch`.
- The exception is a Hono app: build its `ManagedRuntime`, start `Bun.serve`, and on SIGINT or SIGTERM stop the server and then dispose the runtime.
- At framework edges (Hono handlers, Next.js server code), build one `ManagedRuntime` from the app layer and call `runtime.runPromise` there, nowhere else.
- Log with `Effect.log*` and `Effect.annotateLogs`. No `console.log` in committed code.
- Spans come from `Effect.fn` names and `Effect.withSpan`. Export telemetry with the Otlp modules in `effect/observability`.

## Agents and jobs

- Swarm orchestrates Claude Code and Codex. It does not implement its own agent loop.
- Every agent sits behind one adapter interface. Agent-specific code stays inside its adapter.
- Keep the daemon stateless: durable state lives in the database, not in memory. A restart loses only in-flight output.
- Run slow work as async jobs. Never block a request on an agent run, script or clone.
- Make every session, job and script observable: status, logs and spans.
- Automations we build are agents designed as loops with evals. Measure them on real runs before trusting them, then improve from the results.
- Memory is a product feature. Cap buffers like terminal scrollback and streamed output, stream instead of loading whole files, and release everything when a workspace closes.

## States, retries and fallbacks

- Every job (setup and run scripts, clones, pushes, sandbox provisioning, queued cloud work) has one status union: `pending`, `processing`, `completed`, `failed`, `deadLetter`.
- A job's row stores `status`, `attempts`, `lastError` and timestamps. Each transition is one write, so after a restart we know exactly where every job stopped.
- Each state machine has one `transition` function that allows only legal moves, with a test per move. Never set a status anywhere else.
- Classify every tagged error as retryable (network, timeout, rate limit, busy database) or permanent (bad input, auth, missing file).
- A retryable failure puts the job back to `pending` with `attempts + 1` and `lastError`. Retry with `Schedule.exponential` and `Schedule.jittered`, capped by attempts. BullMQ jobs use `attempts` with exponential `backoff`.
- When attempts run out the job moves to `deadLetter`. Dead-letter jobs are never retried automatically: the UI lists them and the user retries or discards them.
- A permanent failure goes straight to `failed`.
- On startup, jobs still in `processing` were cut off by the restart. Treat that as a retryable failure.
- Agent sessions are not jobs. They keep their own union: `idle`, `running`, `awaitingApproval`, `interrupted`, `failed`.
- A fallback must return a correct alternative and log that it was used, for example reading the default branch from `origin/HEAD` and then from `git config init.defaultBranch`. Never swallow an error just to keep going.
- Errors shown to users say what failed and what to do next. Raw causes go to logs, never to the UI.

## Data

- SQLite holds what happens on the user's machine: projects, workspaces, agent sessions and their events.
- Neon holds what is shared: users, orgs, members, invitations and cloud features.
- Never send local code, chats or terminal output to Neon.
- Secrets (API keys, auth tokens) live in the OS keychain. Never in a database, a log or a committed file.
- We use Drizzle, not `effect/sql`, through its official Effect drivers: `drizzle-orm/effect-sqlite-bun` locally and `drizzle-orm/effect-postgres` for Neon.
- Each database is a `Context.Service`. Its methods run Drizzle queries as effects and map driver failures to tagged errors. Never wrap a Drizzle promise in `Effect.tryPromise`.
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
- Unit tests never touch the network or real agent CLIs. Provide test layers in place of real services.
- Run an effect in a test with `Effect.runPromise`, after providing its layers.

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
