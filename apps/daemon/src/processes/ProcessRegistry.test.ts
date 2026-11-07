import { isGoneWithin, killGroupOnExit, spawnDetachedShell, WITH_GRANDCHILD } from "../testing/processTesting.ts";
import { ProcessRegistry, REGISTRY_FILE_NAME, RegistryEntries } from "./ProcessRegistry.ts";
import { Clock, Context, Duration, Effect, FileSystem, Layer, Schema } from "effect";
import { testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { runInTempDir } from "../testing/runServiceTest.ts";
import { LOCK_FILE_NAME } from "./lockDataDirectory.ts";
import { processExists } from "./stopProcessGroup.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Entries = typeof RegistryEntries.Type;

// Writes the registry a crashed daemon would have left, starts a new registry on it, and returns
// what the new registry left in the file.
const startRegistryOn = (dataDir: string, entries: Entries) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const file = join(dataDir, REGISTRY_FILE_NAME);
		yield* fs.writeFileString(file, JSON.stringify(entries));
		yield* Effect.provide(
			Effect.void,
			ProcessRegistry.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer])),
		);
		return Schema.decodeUnknownSync(Schema.fromJsonString(RegistryEntries))(yield* fs.readFileString(file));
	});

describe("ProcessRegistry", () => {
	test("stops a recorded group whose leader is still the process we started", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const { shell, grandchild } = yield* spawnDetachedShell(WITH_GRANDCHILD);
				yield* killGroupOnExit(shell.pid);
				const startedAt = yield* Clock.currentTimeMillis;
				const left = yield* startRegistryOn(dataDir, [{ pgid: shell.pid, startedAt }]);
				return { left, grandchildGone: yield* isGoneWithin(grandchild) };
			}),
		);
		expect(result).toEqual({ left: [], grandchildGone: true });
	});

	test("stops what is left of a group whose leader already exited", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const { shell, grandchild } = yield* spawnDetachedShell("sleep 30 & echo $!");
				yield* killGroupOnExit(shell.pid);
				yield* Effect.promise(() => shell.exited);
				// Long ago on purpose: with the leader gone, only our leftovers can hold the group id.
				const left = yield* startRegistryOn(dataDir, [{ pgid: shell.pid, startedAt: 0 }]);
				return { left, grandchildGone: yield* isGoneWithin(grandchild) };
			}),
		);
		expect(result).toEqual({ left: [], grandchildGone: true });
	});

	test("leaves a reused pid alone", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const { shell } = yield* spawnDetachedShell(WITH_GRANDCHILD);
				yield* killGroupOnExit(shell.pid);
				const now = yield* Clock.currentTimeMillis;
				const recordedLongAgo = now - Duration.toMillis(Duration.hours(1));
				const left = yield* startRegistryOn(dataDir, [{ pgid: shell.pid, startedAt: recordedLongAgo }]);
				return { left, stillRunning: yield* processExists(shell.pid) };
			}),
		);
		expect(result).toEqual({ left: [], stillRunning: true });
	});

	test("a second daemon on the same data directory refuses to start and leaves the first one's children alone", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const { shell } = yield* spawnDetachedShell(WITH_GRANDCHILD);
				yield* killGroupOnExit(shell.pid);
				const layer = ProcessRegistry.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer]));
				// The first daemon keeps running, with the shell recorded as its child.
				const first = yield* Layer.build(layer);
				yield* Context.get(first, ProcessRegistry).add(shell.pid);
				const second = yield* Effect.flip(Effect.scoped(Layer.build(layer)));
				return { second, stillRunning: yield* processExists(shell.pid) };
			}),
		);
		expect(result.second._tag).toBe("DataDirectoryInUseError");
		expect(result.stillRunning).toBe(true);
	});

	test("a lock left by a daemon that is gone does not stop the next one", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const { shell } = yield* spawnDetachedShell("exit 0");
				yield* Effect.promise(() => shell.exited);
				yield* fs.writeFileString(join(dataDir, LOCK_FILE_NAME), JSON.stringify({ pid: shell.pid, startedAt: 0 }));
				yield* Effect.scoped(
					Layer.build(ProcessRegistry.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer]))),
				);
				return { lockLeft: yield* fs.exists(join(dataDir, LOCK_FILE_NAME)) };
			}),
		);
		expect(result).toEqual({ lockLeft: false });
	});
});
