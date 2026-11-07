# web

The Swarm user interface, a Next.js static export that the desktop app loads from disk.

In the desktop app it reaches the daemon through Tauri.
In a plain browser, set `NEXT_PUBLIC_SWARM_DAEMON_URL` to the daemon's WebSocket URL, for example a dev daemon whose sessions replay recorded turns:

```bash
echo devtoken | SWARM_DAEMON_PORT=4799 SWARM_DATA_DIR="$(mktemp -d)" bun run --cwd apps/daemon dev:fake
NEXT_PUBLIC_SWARM_DAEMON_URL="ws://127.0.0.1:4799/rpc?token=devtoken" bun run --cwd apps/web dev
```

UI components come from shadcn/ui in `packages/ui`.
Add one with `bunx --bun shadcn@latest add <name>` from `packages/ui`, then replace its `from "cn"` import with `@repo/ui/lib/utils`.
