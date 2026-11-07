import { Clock, Context, DateTime, Duration, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";
import { processExists, signalProcessGroup, stopProcessGroup } from "./stopProcessGroup.ts";
import { PRIVATE_FILE_MODE } from "../database/LocalDatabase.ts";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { processStartTime } from "./processStartTime.ts";
import { join } from "node:path";

export const REGISTRY_FILE_NAME = "children.json";

// `ps` reports start times to the second, and the time is taken just after the spawn.
const SAME_PROCESS_TOLERANCE = Duration.seconds(2);

export const RegistryEntries = Schema.Array(Schema.Struct({ pgid: Schema.Int, startedAt: Schema.Number }));
const RegistryFile = Schema.fromJsonString(RegistryEntries);

// A process group left by a daemon that died without cleaning up. Its leader is ours when it
// started when we recorded it. A gone leader is safe too: a process group id cannot be reused
// while any member of the group is alive, so signalling -pgid only reaches our leftovers.
const reapEntry = Effect.fn("reapEntry")(function* (entry: { readonly pgid: number; readonly startedAt: number }) {
	if (yield* processExists(entry.pgid)) {
		const startedAt = yield* processStartTime(entry.pgid);
		const recorded = DateTime.makeUnsafe(entry.startedAt);
		const isOurs = Option.match(startedAt, {
			onNone: () => false,
			onSome: (started) =>
				Duration.isLessThanOrEqualTo(Duration.abs(DateTime.distance(started, recorded)), SAME_PROCESS_TOLERANCE),
		});
		if (!isOurs) {
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
>()("swarm/daemon/processes/ProcessRegistry") {
	static readonly layer = Layer.effect(
		ProcessRegistry,
		Effect.gen(function* () {
			const { dataDir } = yield* DaemonConfig;
			const fs = yield* FileSystem.FileSystem;
			const file = join(dataDir, REGISTRY_FILE_NAME);

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
