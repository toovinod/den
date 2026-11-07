import { isGoneWithin, WITH_GRANDCHILD } from "../testing/processTesting.ts";
import { TrackedChildProcessSpawner } from "./TrackedChildProcessSpawner.ts";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ProcessRegistry } from "./ProcessRegistry.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";

describe("TrackedChildProcessSpawner", () => {
	test("records a child until it exits and stops its grandchildren with it", async () => {
		const events: Array<string> = [];
		const recordingRegistry = Layer.succeed(
			ProcessRegistry,
			ProcessRegistry.of({
				add: (pgid) => Effect.sync(() => events.push(`add ${pgid}`)),
				remove: (pgid) => Effect.sync(() => events.push(`remove ${pgid}`)),
			}),
		);
		const result = await Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const { pid, grandchild } = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", WITH_GRANDCHILD]));
					const line = yield* handle.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
					return { pid: handle.pid, grandchild: Number(Option.getOrThrow(line)) };
				}),
			);
			const grandchildGone = yield* isGoneWithin(grandchild);
			yield* Effect.sync(() => events.length).pipe(
				Effect.repeat({ schedule: Schedule.spaced(Duration.millis(10)), while: (count) => count < 2 }),
				Effect.timeout(Duration.seconds(2)),
			);
			return { events, grandchildGone, pid };
		}).pipe(
			Effect.provide(TrackedChildProcessSpawner.pipe(Layer.provide([recordingRegistry, BunServices.layer]))),
			Effect.runPromise,
		);
		expect(result.grandchildGone).toBe(true);
		expect(result.events).toEqual([`add ${result.pid}`, `remove ${result.pid}`]);
	});
});
