import { isGoneWithin, killGroupOnExit, spawnDetachedShell, WITH_GRANDCHILD } from "../testing/processTesting.ts";
import { Clock, Context, Duration, Effect, Exit, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ProcessRegistry, REGISTRY_FILE_NAME, RegistryEntries } from "./ProcessRegistry.ts";
import { testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { runInTempDir } from "../testing/runServiceTest.ts";
import { processExists } from "./stopProcessGroup.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { ChildProcess } from "effect/process";
import { join } from "node:path";

type Entries = typeof RegistryEntries.Type;

const DAEMON_DIR = join(import.meta.dir, "..", "..");

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

// Starts a registry on the data directory and closes it again.
const startRegistry = (dataDir: string) =>
	Effect.scoped(Layer.build(ProcessRegistry.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer]))));

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

	test("a lock held by a daemon that was killed does not stop the next one", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const holder = yield* ChildProcess.make("bun", ["src/testing/dataDirectoryHolder.ts"], {
					cwd: DAEMON_DIR,
					env: { OCTOPUS_DATA_DIR: dataDir },
					extendEnv: true,
				});
				const ready = yield* holder.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
				const heldBefore = yield* Effect.flip(startRegistry(dataDir));
				// SIGKILL runs no finalizer, so only the kernel can release what the holder held.
				process.kill(holder.pid, "SIGKILL");
				yield* holder.exitCode.pipe(Effect.ignore);
				yield* startRegistry(dataDir);
				return { ready: Option.getOrUndefined(ready), heldBefore: heldBefore._tag };
			}),
		);
		expect(result).toEqual({ ready: "OCTOPUS_LOCK_HELD", heldBefore: "DataDirectoryInUseError" });
	}, 20_000);

	test("two daemons starting at once: exactly one gets the data directory", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const layer = ProcessRegistry.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer]));
				const race = Effect.scoped(
					Effect.all([Effect.exit(Layer.build(layer)), Effect.exit(Layer.build(layer))], {
						concurrency: "unbounded",
					}).pipe(Effect.map((exits) => exits.filter(Exit.isSuccess).length)),
				);
				// The race is decided by timing, so run it often enough that a wrong lock shows up.
				const rounds = [];
				for (let i = 0; i < 30; i++) {
					rounds.push(yield* race);
				}
				return rounds.filter((winners) => winners !== 1).length;
			}),
		);
		expect(result).toBe(0);
	});
});
