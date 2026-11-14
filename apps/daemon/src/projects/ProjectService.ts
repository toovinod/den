import {
	NotAGitRepositoryError,
	Project,
	ProjectAlreadyAddedError,
	ProjectCreateError,
	ProjectFolderExistsError,
	ProjectFolderNotFoundError,
	ProjectHasActiveWorkspacesError,
	ProjectNotFoundError,
} from "@repo/contracts/Project";
import { type GitCommandError, type GitSpawnError, runGit } from "../git/runGit.ts";
import { detectDefaultBranch } from "./detectDefaultBranch.ts";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { Context, Effect, FileSystem, Layer } from "effect";
import { project, workspace } from "../database/schema.ts";
import type { ChildProcessSpawner } from "effect/process";
import type { SecureRandom } from "effect/crypto";
import { nowIso } from "../database/nowIso.ts";
import { newId } from "../database/newId.ts";
import { and, asc, eq } from "drizzle-orm";
import { basename, join } from "node:path";

const normalizeScript = (script: string | null) => script?.trim() || null;

export class ProjectService extends Context.Service<ProjectService>()("octopus/daemon/projects/ProjectService", {
	make: Effect.gen(function* () {
		const database = yield* LocalDatabase;
		const fs = yield* FileSystem.FileSystem;
		const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom>();

		const get = Effect.fn("ProjectService.get")(function* (projectId: string) {
			const [row] = yield* database.query((db) => db.select().from(project).where(eq(project.id, projectId)));
			if (row === undefined) {
				return yield* new ProjectNotFoundError({ projectId });
			}
			return new Project(row);
		});

		const add = Effect.fn("ProjectService.add")(function* (path: string) {
			if (!(yield* fs.exists(path).pipe(Effect.orDie))) {
				return yield* new ProjectFolderNotFoundError({ path });
			}
			// A folder inside a repository becomes a project for the whole repository.
			const repositoryPath = yield* runGit(path, ["rev-parse", "--show-toplevel"]).pipe(
				Effect.catchTag("GitCommandError", () => Effect.fail(new NotAGitRepositoryError({ path }))),
			);
			const existing = yield* database.query((db) => db.select().from(project).where(eq(project.path, repositoryPath)));
			if (existing.length > 0) {
				return yield* new ProjectAlreadyAddedError({ path: repositoryPath });
			}
			const row = {
				id: yield* newId,
				name: basename(repositoryPath),
				path: repositoryPath,
				defaultBranch: yield* detectDefaultBranch(repositoryPath),
				setupScript: null,
				runScript: null,
				trusted: false,
				createdAt: yield* nowIso,
			};
			yield* database.query((db) => db.insert(project).values(row));
			yield* Effect.logInfo("Added project").pipe(Effect.annotateLogs({ projectId: row.id, path: row.path }));
			return new Project(row);
		}, Effect.provide(services));

		const list = database
			.query((db) => db.select().from(project).orderBy(asc(project.createdAt)))
			.pipe(Effect.map((rows) => rows.map((row) => new Project(row))));

		const remove = Effect.fn("ProjectService.remove")(function* (projectId: string) {
			// Count and delete in one transaction so no workspace can appear in between.
			const outcome = yield* database.query((db) =>
				db.transaction((tx) =>
					Effect.gen(function* () {
						const found = yield* tx.$count(project, eq(project.id, projectId));
						const activeWorkspaces = yield* tx.$count(
							workspace,
							and(eq(workspace.projectId, projectId), eq(workspace.status, "active")),
						);
						if (found > 0 && activeWorkspaces === 0) {
							yield* tx.delete(project).where(eq(project.id, projectId));
						}
						return { found, activeWorkspaces };
					}),
				),
			);
			if (outcome.found === 0) {
				return yield* new ProjectNotFoundError({ projectId });
			}
			if (outcome.activeWorkspaces > 0) {
				return yield* new ProjectHasActiveWorkspacesError({
					projectId,
					activeWorkspaces: outcome.activeWorkspaces,
				});
			}
		});

		const updateScripts = Effect.fn("ProjectService.updateScripts")(function* (
			projectId: string,
			scripts: {
				readonly setupScript: string | null;
				readonly runScript: string | null;
			},
		) {
			const [row] = yield* database.query((db) =>
				db
					.update(project)
					.set({
						setupScript: normalizeScript(scripts.setupScript),
						runScript: normalizeScript(scripts.runScript),
					})
					.where(eq(project.id, projectId))
					.returning(),
			);
			if (row === undefined) {
				return yield* new ProjectNotFoundError({ projectId });
			}
			return new Project(row);
		});

		const setTrust = Effect.fn("ProjectService.setTrust")(function* (projectId: string, trusted: boolean) {
			const [row] = yield* database.query((db) =>
				db.update(project).set({ trusted }).where(eq(project.id, projectId)).returning(),
			);
			if (row === undefined) {
				return yield* new ProjectNotFoundError({ projectId });
			}
			return new Project(row);
		});

		const create = Effect.fn("ProjectService.create")(function* (parentPath: string, name: string) {
			if (!(yield* fs.exists(parentPath).pipe(Effect.orDie))) {
				return yield* new ProjectFolderNotFoundError({ path: parentPath });
			}
			const path = join(parentPath, name);
			if (yield* fs.exists(path).pipe(Effect.orDie)) {
				return yield* new ProjectFolderExistsError({ path });
			}
			yield* fs.makeDirectory(path).pipe(Effect.orDie);
			const giveUp = (cause: GitCommandError | GitSpawnError) =>
				Effect.logError("Could not create a repository", cause).pipe(
					// The folder is new and holds nothing of the user's, so it goes too.
					Effect.andThen(fs.remove(path, { recursive: true }).pipe(Effect.ignore)),
					Effect.andThen(Effect.fail(new ProjectCreateError({ path }))),
				);
			yield* Effect.gen(function* () {
				yield* runGit(path, ["init", "--initial-branch=main"]);
				yield* runGit(path, ["commit", "--allow-empty", "--message", "Initial commit"]);
			}).pipe(Effect.provide(services), Effect.catchTags({ GitCommandError: giveUp, GitSpawnError: giveUp }));
			return yield* add(path);
		});

		return { get, add, create, list, remove, updateScripts, setTrust };
	}),
}) {
	static readonly layer = Layer.effect(ProjectService, ProjectService.make);
}
