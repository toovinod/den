import { BunRuntime, BunServices, BunStdio } from "@effect/platform-bun";
import type { ClaudeAdapter } from "../agents/claude/ClaudeAdapter.ts";
import type { CodexAdapter } from "../agents/codex/CodexAdapter.ts";
import type { CredentialStore } from "../agents/CredentialStore.ts";
import { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { Cause, Effect, Exit, Layer } from "effect";
import { Shutdown } from "../shutdown/Shutdown.ts";
import { DaemonServer } from "./DaemonServer.ts";

type Agents = ClaudeAdapter | CodexAdapter | CredentialStore;

// Starts the daemon with the given agents: the real ones in main.ts, replayed ones in devDaemon.ts.
export const runDaemon = (agents: Layer.Layer<Agents, never, ProcessRegistry>) => {
	// Shutdown is built first, so it is closed last and its signal handlers and deadline cover
	// every other finalizer. The process registry is shared by the services and the agent adapters,
	// and is closed after both, once nothing is left to spawn.
	const DaemonLayer = DaemonServer.pipe(
		Layer.provide(agents),
		Layer.provideMerge(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer))),
		Layer.provideMerge(Shutdown.layer),
		Layer.provideMerge(DaemonConfig.layer),
		Layer.provide(BunStdio.layer),
	);

	// Like Layer.launch, but it returns once shutdown is requested, which closes the layers.
	const main = Effect.gen(function* () {
		const shutdown = yield* Shutdown;
		yield* shutdown.requested;
	}).pipe(Effect.provide(DaemonLayer));

	BunRuntime.runMain(main, {
		// A signal interrupts main, which is still a clean shutdown when every finalizer succeeded.
		// Exiting explicitly also stops the process when a library leaves a handle open.
		teardown: (exit) => process.exit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
	});
};
