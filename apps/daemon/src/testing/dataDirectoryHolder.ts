import { lockDataDirectory } from "../processes/lockDataDirectory.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect } from "effect";

// A daemon stand-in for ProcessRegistry.test.ts that holds the data directory lock until it is
// killed, so the test can check what a daemon that died without cleaning up leaves behind.
const main = Effect.gen(function* () {
	yield* lockDataDirectory(yield* Config.String("OCTOPUS_DATA_DIR"));
	yield* Console.log("OCTOPUS_LOCK_HELD");
	yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

BunRuntime.runMain(main);
