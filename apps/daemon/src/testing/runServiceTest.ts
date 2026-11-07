import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import type { CredentialStore } from "../agents/CredentialStore.ts";
import type { ProjectService } from "../projects/ProjectService.ts";
import type { SessionService } from "../sessions/SessionService.ts";
import type { LocalDatabase } from "../database/LocalDatabase.ts";
import { DaemonServices } from "../server/DaemonServices.ts";
import { Effect, FileSystem, Layer, Schedule } from "effect";
import { testAgentServices } from "./testAgentServices.ts";
import { testDaemonConfig } from "./testDaemonConfig.ts";
import { BunServices } from "@effect/platform-bun";
import { join } from "node:path";

export type Services =
	| LocalDatabase
	| ProjectService
	| WorkspaceService
	| SessionService
	| CredentialStore
	| BunServices.BunServices;

export const withServices =
	(dataDir: string, agents: ReturnType<typeof testAgentServices> = testAgentServices()) =>
	<A, E>(program: Effect.Effect<A, E, Services>) =>
		program.pipe(
			Effect.provide(DaemonServices.pipe(Layer.provideMerge(agents), Layer.provide(testDaemonConfig(dataDir)))),
		);

export const runInTempDir = <A, E>(program: (tempDir: string) => Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* program(yield* fs.makeTempDirectoryScoped());
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

export const runServiceTest = <A, E>(program: (tempDir: string) => Effect.Effect<A, E, Services>) =>
	runInTempDir((tempDir) => withServices(join(tempDir, "data"))(program(tempDir)));

export const waitForScriptRun = (workspaceId: string) =>
	Effect.flatMap(WorkspaceService, (workspaces) => workspaces.listScriptRuns(workspaceId)).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("20 millis"),
			until: (runs) => runs.length > 0 && ["completed", "failed", "deadLetter"].includes(runs.at(-1)?.status ?? ""),
		}),
		Effect.map((runs) => runs.at(-1)),
		Effect.timeout("10 seconds"),
	);
