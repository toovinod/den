<a href="https://github.com/toovinod/den">
  <img alt="Den is the open-source desktop app for running Claude Code and Codex in parallel." src=".github/assets/banner.svg">
</a>

<h3 align="center">Den</h3>

<p align="center">
    The open-source app for running coding agents in parallel.
    <br />
    <a href="docs/architecture.md"><strong>Learn more »</strong></a>
    <br />
    <br />
    <a href="#introduction"><strong>Introduction</strong></a> ·
    <a href="#tech-stack"><strong>Tech Stack</strong></a> ·
    <a href="#local-development"><strong>Local Development</strong></a> ·
    <a href="#contributing"><strong>Contributing</strong></a>
</p>

<p align="center">
  <a href="https://github.com/toovinod/den/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/toovinod/den/ci.yml?branch=main&label=CI&logo=github&logoColor=fff" alt="CI" />
  </a>
  <a href="https://github.com/toovinod/den/stargazers">
    <img src="https://img.shields.io/github/stars/toovinod/den?style=flat&label=stars&logo=github&color=0bf&logoColor=fff" alt="Stars" />
  </a>
  <a href="https://github.com/toovinod/den/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/toovinod/den?label=license&logo=github&color=f80&logoColor=fff" alt="License" />
  </a>
</p>

<br/>

## Introduction

Den is the open-source desktop app for running [Claude Code](https://code.claude.com) and [Codex](https://github.com/openai/codex) in parallel.

Every task gets its own workspace: a git worktree on its own branch, or the project folder itself.
Each workspace runs as many agent sessions as you need, side by side.
Review the diff, open a terminal, and create, review and merge the pull request without leaving the app.

Your code, chats and terminal output stay on your machine, and your API keys stay in your OS keychain.

> Den is in early development and not ready for daily use yet.

## Tech Stack

- [Tauri](https://tauri.app/) - desktop shell
- [Next.js](https://nextjs.org/) - framework
- [TypeScript](https://www.typescriptlang.org/) - language
- [Tailwind](https://tailwindcss.com/) - CSS
- [shadcn/ui](https://ui.shadcn.com/) - components
- [Bun](https://bun.sh/) - runtime
- [Effect](https://effect.website/) - services and errors
- [Drizzle](https://orm.drizzle.team/) - ORM
- [SQLite](https://sqlite.org/) - local database
- [Postgres](https://www.postgresql.org/) - cloud database
- [Hono](https://hono.dev/) - API
- [Better Auth](https://www.better-auth.com/) - auth
- [Resend](https://resend.com/) - emails
- [Turborepo](https://turborepo.com/) - monorepo
- [Biome](https://biomejs.dev/) - lint and format

## Local Development

```bash
cp .env.example .env
```

```bash
bun run setup
```

```bash
bun run dev
```

`setup` installs dependencies, starts Postgres and Redis in Docker and applies the migrations.
`dev` runs the web UI, the API and the desktop app with its daemon.
To work on agents, install [Claude Code](https://code.claude.com) and the [Codex CLI](https://github.com/openai/codex).

## Contributing

We love our contributors! Here's how you can contribute:

- [Open an issue](https://github.com/toovinod/den/issues) if you believe you've found a bug.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md), the rules every change follows.
- Make a [pull request](https://github.com/toovinod/den/pulls) to add features, improve quality of life or fix bugs.

Report security issues privately as described in [SECURITY.md](SECURITY.md).

### Recommended Versions

| Tool   | Version |
| ------ | ------- |
| bun    | 1.4.4   |
| rust   | 1.90    |
| docker | latest  |

## License

Den is open source under the [MIT License](LICENSE).
