import { DATABASE_FILE_NAME, LocalDatabase } from "./LocalDatabase.ts";
import { testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, test } from "bun:test";
import { project } from "./schema.ts";
import { sql } from "drizzle-orm";
import { join } from "node:path";

const withDatabase = <A, E>(program: Effect.Effect<A, E, LocalDatabase>, dataDir: string) =>
	program.pipe(Effect.provide(LocalDatabase.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer]))));

const run = <A, E>(program: (dataDir: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* program(yield* fs.makeTempDirectoryScoped());
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

describe("LocalDatabase", () => {
	test("migrates a new file with WAL, foreign keys and a 5 second busy timeout", async () => {
		const pragmas = await run((dataDir) =>
			withDatabase(
				LocalDatabase.use((database) =>
					database.query((db) =>
						Effect.all([
							db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`),
							db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`),
							db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`),
							db.select().from(project),
						]),
					),
				),
				dataDir,
			),
		);
		expect(pragmas).toEqual([{ journal_mode: "wal" }, { foreign_keys: 1 }, { timeout: 5000 }, []]);
	});

	test("reopening an existing file applies no migration twice", async () => {
		const rows = await run((dataDir) =>
			Effect.gen(function* () {
				const insert = LocalDatabase.use((database) =>
					database.query((db) =>
						db.insert(project).values({
							id: "p1",
							name: "repo",
							path: "/repo",
							defaultBranch: "main",
							createdAt: "2026-01-01T00:00:00.000Z",
						}),
					),
				);
				yield* withDatabase(insert, dataDir);
				return yield* withDatabase(
					LocalDatabase.use((database) => database.query((db) => db.select().from(project))),
					dataDir,
				);
			}),
		);
		expect(rows.map((row) => row.id)).toEqual(["p1"]);
	});

	test("keeps the data dir and database files private to the user", async () => {
		const modes = await run((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const freshDir = join(tempDir, "fresh");
				const openDir = join(tempDir, "open");
				yield* fs.makeDirectory(openDir, { mode: 0o755 });
				yield* fs.chmod(openDir, 0o755);
				const modeOf = (path: string) => Effect.map(fs.stat(path), (info) => info.mode & 0o777);
				const modesIn = (dataDir: string) =>
					Effect.all([
						modeOf(dataDir),
						modeOf(join(dataDir, DATABASE_FILE_NAME)),
						modeOf(join(dataDir, `${DATABASE_FILE_NAME}-wal`)),
						modeOf(join(dataDir, `${DATABASE_FILE_NAME}-shm`)),
					]);
				return yield* Effect.all([withDatabase(modesIn(freshDir), freshDir), withDatabase(modesIn(openDir), openDir)]);
			}),
		);
		expect(modes).toEqual([
			[0o700, 0o600, 0o600, 0o600],
			[0o700, 0o600, 0o600, 0o600],
		]);
	});
});
