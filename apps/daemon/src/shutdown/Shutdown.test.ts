import { type Cause, Duration, Effect, FileSystem, Option, Queue, Ref, Stream } from "effect";
import { REGISTRY_FILE_NAME } from "../processes/ProcessRegistry.ts";
import { DATABASE_FILE_NAME } from "../database/LocalDatabase.ts";
import { runInTempDir } from "../testing/runServiceTest.ts";
import { TEST_TOKEN } from "../testing/testDaemonConfig.ts";
import { describe, expect, test } from "bun:test";
import { ChildProcess } from "effect/process";
import { join } from "node:path";

const DAEMON_DIR = join(import.meta.dir, "..", "..");
const TIMEOUT = 20_000;
const encoder = new TextEncoder();

// Starts a daemon entry as the desktop shell does: the token on stdin, which then stays open
// until `closeStdin`. Resolves once the daemon printed its ready line.
const startDaemon = (entry: string, dataDir: string) =>
	Effect.gen(function* () {
		const stdin = yield* Queue.make<Uint8Array, Cause.Done>();
		yield* Queue.offer(stdin, encoder.encode(`${TEST_TOKEN}\n`));
		const handle = yield* ChildProcess.make("bun", [entry], {
			cwd: DAEMON_DIR,
			stdin: Stream.fromQueue(stdin),
			env: { OCTOPUS_DATA_DIR: dataDir },
			extendEnv: true,
		});
		const output = yield* Ref.make<ReadonlyArray<string>>([]);
		yield* handle.all.pipe(
			Stream.decodeText,
			Stream.splitLines,
			Stream.runForEach((line) => Ref.update(output, (lines) => [...lines, line])),
			Effect.forkScoped,
		);
		yield* Ref.get(output).pipe(
			Effect.repeat({ while: (lines) => !lines.some((line) => line.startsWith("OCTOPUS_DAEMON_READY")) }),
			Effect.timeout(Duration.seconds(10)),
		);
		return {
			signal: (signal: NodeJS.Signals) => Effect.sync(() => process.kill(handle.pid, signal)),
			closeStdin: Queue.end(stdin),
			exit: Effect.gen(function* () {
				const code = yield* handle.exitCode;
				return { code: Number(code), output: (yield* Ref.get(output)).join("\n") };
			}).pipe(Effect.timed),
		};
	});

const fileSize = (path: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.stat(path).pipe(
			Effect.map((info) => Number(info.size)),
			Effect.option,
		),
	);

const readRegistry = (dataDir: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(dataDir, REGISTRY_FILE_NAME)));

describe("daemon shutdown", () => {
	test(
		"SIGTERM stops the daemon cleanly and checkpoints the database",
		async () => {
			const result = await runInTempDir((dataDir) =>
				Effect.gen(function* () {
					const daemon = yield* startDaemon("src/main.ts", dataDir);
					yield* daemon.signal("SIGTERM");
					const [, exit] = yield* daemon.exit;
					return {
						code: exit.code,
						loggedReason: exit.output.includes('reason: "SIGTERM"'),
						walSize: yield* fileSize(join(dataDir, `${DATABASE_FILE_NAME}-wal`)),
						registry: yield* readRegistry(dataDir),
					};
				}),
			);
			expect(result.code).toBe(0);
			expect(result.loggedReason).toBe(true);
			// SQLite may remove the WAL on close or leave it truncated.
			expect(Option.getOrElse(result.walSize, () => 0)).toBe(0);
			expect(result.registry).toBe("[]");
		},
		TIMEOUT,
	);

	test(
		"closing stdin stops the daemon cleanly",
		async () => {
			const result = await runInTempDir((dataDir) =>
				Effect.gen(function* () {
					const daemon = yield* startDaemon("src/main.ts", dataDir);
					yield* daemon.closeStdin;
					const [, exit] = yield* daemon.exit;
					return { code: exit.code, loggedReason: exit.output.includes('reason: "parentExited"') };
				}),
			);
			expect(result).toEqual({ code: 0, loggedReason: true });
		},
		TIMEOUT,
	);

	test(
		"a finalizer that hangs is cut off at the deadline with a failing exit code",
		async () => {
			const result = await runInTempDir((dataDir) =>
				Effect.gen(function* () {
					const daemon = yield* startDaemon("src/testing/hangingDaemon.ts", dataDir);
					yield* daemon.signal("SIGTERM");
					const [took, exit] = yield* daemon.exit;
					return { code: exit.code, took: Duration.toMillis(took) };
				}),
			);
			expect(result.code).toBe(1);
			expect(result.took).toBeGreaterThanOrEqual(900);
		},
		TIMEOUT,
	);

	test(
		"a second signal during shutdown exits at once",
		async () => {
			const result = await runInTempDir((dataDir) =>
				Effect.gen(function* () {
					const daemon = yield* startDaemon("src/testing/hangingDaemon.ts", dataDir);
					yield* daemon.signal("SIGTERM");
					yield* Effect.sleep(Duration.millis(100));
					yield* daemon.signal("SIGINT");
					const [took, exit] = yield* daemon.exit;
					return { code: exit.code, took: Duration.toMillis(took), output: exit.output };
				}),
			);
			expect(result.code).toBe(1);
			expect(result.took).toBeLessThan(800);
			expect(result.output).toContain("SIGINT during shutdown");
		},
		TIMEOUT,
	);
});
