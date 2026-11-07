import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";

// The SDK's own spawn leaves claude in the daemon's process group. In a group of its own, one
// signal reaches claude and everything it started, like every other child of the daemon.
// stderr goes to the daemon's stderr, which the app logs.
export const spawnInProcessGroup = (options: SpawnOptions) =>
	spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
		stdio: ["pipe", "pipe", "inherit"],
		detached: true,
	});
