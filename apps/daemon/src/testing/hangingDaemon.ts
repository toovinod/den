import { Shutdown, ShutdownSettings } from "../shutdown/Shutdown.ts";
import { BunRuntime, BunStdio } from "@effect/platform-bun";
import { Console, Duration, Effect, Layer } from "effect";
import { DaemonConfig } from "../config/DaemonConfig.ts";

// A daemon entry for Shutdown.test.ts whose finalizer never returns, so the deadline has to end it.
const HangOnShutdown = Layer.effectDiscard(
	Effect.gen(function* () {
		yield* Effect.addFinalizer(() => Effect.never);
		yield* Console.log("DEN_DAEMON_READY hanging");
	}),
);

const main = Effect.gen(function* () {
	const shutdown = yield* Shutdown;
	yield* shutdown.requested;
}).pipe(
	Effect.provide(
		HangOnShutdown.pipe(
			Layer.provideMerge(Shutdown.layer),
			Layer.provide(DaemonConfig.layer),
			Layer.provide(BunStdio.layer),
			Layer.provide(Layer.succeed(ShutdownSettings, { deadline: Duration.seconds(1) })),
		),
	),
);

BunRuntime.runMain(main);
