import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schedule } from "effect";
import type { LocalDatabase } from "../database/LocalDatabase.ts";
import type { ProjectService } from "../projects/ProjectService.ts";
import { DaemonServices } from "../server/DaemonServices.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { testDaemonConfig } from "./testDaemonConfig.ts";

type Services =
	| LocalDatabase
	| ProjectService
	| WorkspaceService
	| BunServices.BunServices;

export const withServices =
	(dataDir: string) =>
	<A, E>(program: Effect.Effect<A, E, Services>) =>
		program.pipe(
			Effect.provide(
				DaemonServices.pipe(Layer.provide(testDaemonConfig(dataDir))),
			),
		);

export const runInTempDir = <A, E>(
	program: (tempDir: string) => Effect.Effect<A, E, BunServices.BunServices>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* program(yield* fs.makeTempDirectoryScoped());
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

export const runServiceTest = <A, E>(
	program: (tempDir: string) => Effect.Effect<A, E, Services>,
) =>
	runInTempDir((tempDir) =>
		withServices(join(tempDir, "data"))(program(tempDir)),
	);

export const waitForScriptRun = (workspaceId: string) =>
	Effect.flatMap(WorkspaceService, (workspaces) =>
		workspaces.listScriptRuns(workspaceId),
	).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("20 millis"),
			until: (runs) =>
				runs.length > 0 &&
				["completed", "failed", "deadLetter"].includes(
					runs.at(-1)?.status ?? "",
				),
		}),
		Effect.map((runs) => runs.at(-1)),
		Effect.timeout("10 seconds"),
	);
