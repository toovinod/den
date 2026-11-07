import { Context, Deferred, Duration, Effect, Layer, Schema } from "effect";
import { DaemonConfig } from "../config/DaemonConfig.ts";

export const ShutdownReason = Schema.Literals(["SIGTERM", "SIGINT", "parentExited", "rpc"]);
export type ShutdownReason = typeof ShutdownReason.Type;

export const ShutdownSettings = Context.Reference<{
	// Longer than the children's stop grace, so a clean stop always fits inside it.
	readonly deadline: Duration.Duration;
}>("swarm/daemon/shutdown/ShutdownSettings", {
	defaultValue: () => ({ deadline: Duration.seconds(8) }),
});

// The exit code when shutdown cannot finish cleanly.
export const FORCED_EXIT_CODE = 1;

const forceExit = (message: string) => {
	Effect.runSync(Effect.logError(message));
	process.exit(FORCED_EXIT_CODE);
};

// The one way the daemon stops. A signal, the app closing stdin or the shutdown RPC asks for it,
// main sees `requested` complete and returns, and the daemon's layers close in reverse order:
// the HTTP server stops taking connections, workspace runtimes stop their children, and the
// database closes last.
export class Shutdown extends Context.Service<
	Shutdown,
	{
		readonly request: (reason: ShutdownReason) => Effect.Effect<void>;
		readonly requested: Effect.Effect<ShutdownReason>;
	}
>()("swarm/daemon/shutdown/Shutdown") {
	static readonly layer = Layer.effect(
		Shutdown,
		Effect.gen(function* () {
			const { deadline } = yield* ShutdownSettings;
			const { parentExited } = yield* DaemonConfig;
			const requested = yield* Deferred.make<ShutdownReason>();

			const request = (reason: ShutdownReason) =>
				Effect.gen(function* () {
					if (!(yield* Deferred.succeed(requested, reason))) return;
					yield* Effect.logInfo("Shutting down").pipe(Effect.annotateLogs({ reason }));
					// A plain timer, not a fiber: closing scopes interrupts fibers, and this has to fire
					// even when a finalizer never returns.
					setTimeout(
						() => forceExit(`Shutdown did not finish within ${Duration.format(deadline)}, exiting anyway`),
						Duration.toMillis(deadline),
					).unref();
				});

			// BunRuntime.runMain also interrupts main on these signals. This listener adds the reason,
			// the deadline and the second signal that exits at once.
			const onSignal = (signal: "SIGTERM" | "SIGINT") => () => {
				if (Deferred.isDoneUnsafe(requested)) return forceExit(`${signal} during shutdown, exiting at once`);
				Effect.runFork(request(signal));
			};
			const onTerm = onSignal("SIGTERM");
			const onInt = onSignal("SIGINT");
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					process.on("SIGTERM", onTerm);
					process.on("SIGINT", onInt);
				}),
				() =>
					Effect.sync(() => {
						process.off("SIGTERM", onTerm);
						process.off("SIGINT", onInt);
					}),
			);

			yield* parentExited.pipe(Effect.andThen(request("parentExited")), Effect.forkScoped);

			return Shutdown.of({ request, requested: Deferred.await(requested) });
		}),
	);
}
