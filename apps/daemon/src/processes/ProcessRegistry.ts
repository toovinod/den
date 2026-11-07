import { processExists, signalProcessGroup, stopProcessGroup } from "./stopProcessGroup.ts";
import { Clock, Context, Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import { PRIVATE_FILE_MODE } from "../database/LocalDatabase.ts";
import { lockDataDirectory } from "./lockDataDirectory.ts";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { wasStartedAt } from "./processStartTime.ts";
import { join } from "node:path";

export const REGISTRY_FILE_NAME = "children.json";

export const RegistryEntries = Schema.Array(Schema.Struct({ pgid: Schema.Int, startedAt: Schema.Number }));
const RegistryFile = Schema.fromJsonString(RegistryEntries);

// A process group left by a daemon that died without cleaning up. Its leader is ours when it
// started when we recorded it. A gone leader is safe too: a process group id cannot be reused
// while any member of the group is alive, so signalling -pgid only reaches our leftovers.
const reapEntry = Effect.fn("reapEntry")(function* (entry: { readonly pgid: number; readonly startedAt: number }) {
	if (yield* processExists(entry.pgid)) {
		if (!(yield* wasStartedAt(entry.pgid, entry.startedAt))) {
			return yield* Effect.logWarning("A recorded child's pid now belongs to another process, leaving it alone").pipe(
				Effect.annotateLogs({ pgid: entry.pgid }),
			);
		}
	}
	yield* Effect.logWarning("Stopping a child left by a previous daemon").pipe(
		Effect.annotateLogs({ pgid: entry.pgid }),
	);
	yield* stopProcessGroup(entry.pgid);
});

// Records every child process group in a private file in the data directory, so a daemon that
// starts after a crash can stop what the crashed one left running.
export class ProcessRegistry extends Context.Service<
	ProcessRegistry,
	{
		readonly add: (pgid: number) => Effect.Effect<void>;
		readonly remove: (pgid: number) => Effect.Effect<void>;
	}
>()("den/daemon/processes/ProcessRegistry") {
	static readonly layer = Layer.effect(
		ProcessRegistry,
		Effect.gen(function* () {
			const { dataDir } = yield* DaemonConfig;
			const fs = yield* FileSystem.FileSystem;
			const file = join(dataDir, REGISTRY_FILE_NAME);
			// Before reaping: only with the lock held is a recorded child known to be a crashed daemon's.
			yield* lockDataDirectory(dataDir);

			if (yield* fs.exists(file)) {
				const entries = yield* fs.readFileString(file).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(RegistryFile)),
					Effect.catch((cause) =>
						Effect.logWarning("Could not read the child process registry, so nothing was reaped", cause).pipe(
							Effect.as([]),
						),
					),
				);
				yield* Effect.forEach(entries, reapEntry, { concurrency: "unbounded", discard: true });
			}

			const groups = new Map<number, number>();
			const lock = yield* Semaphore.make(1);
			// Written to a temporary file and renamed, so a crash never leaves half a file.
			const save = Effect.gen(function* () {
				const entries = [...groups].map(([pgid, startedAt]) => ({ pgid, startedAt }));
				const encoded = yield* Schema.encodeEffect(RegistryFile)(entries);
				yield* fs.writeFileString(`${file}.tmp`, encoded, { mode: PRIVATE_FILE_MODE });
				yield* fs.rename(`${file}.tmp`, file);
			}).pipe(
				Effect.catch((cause) => Effect.logWarning("Could not write the child process registry", cause)),
				lock.withPermits(1),
			);
			yield* save;
			// Runs after every layer that spawns has closed. A removal can still be pending for a child
			// that exited a moment ago, and a clean shutdown should leave nothing for the next start.
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					for (const pgid of [...groups.keys()]) {
						if (!(yield* signalProcessGroup(pgid, 0))) groups.delete(pgid);
					}
					yield* save;
				}),
			);

			return ProcessRegistry.of({
				add: (pgid) =>
					Effect.gen(function* () {
						groups.set(pgid, yield* Clock.currentTimeMillis);
						yield* save;
					}),
				remove: (pgid) =>
					Effect.gen(function* () {
						if (groups.delete(pgid)) yield* save;
					}),
			});
		}),
	);
}
