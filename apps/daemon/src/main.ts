import { BunRuntime, BunStdio } from "@effect/platform-bun";
import { DaemonConfig } from "./config/DaemonConfig.ts";
import { DaemonServer } from "./server/DaemonServer.ts";
import { Effect, Layer } from "effect";

const DaemonLayer = DaemonServer.pipe(Layer.provideMerge(DaemonConfig.layer), Layer.provide(BunStdio.layer));

// Like Layer.launch, but the daemon also stops when the app that started it is gone, even after
// a crash or kill -9. Closing the layer releases every process the daemon started.
const main = Effect.gen(function* () {
	const { parentExited } = yield* DaemonConfig;
	yield* parentExited;
	yield* Effect.logInfo("stdin closed, so the app has exited. Shutting down.");
}).pipe(Effect.provide(DaemonLayer));

BunRuntime.runMain(main);
