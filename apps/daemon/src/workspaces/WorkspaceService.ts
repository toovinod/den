import { basename, join } from "node:path";
import { ScriptRun, ScriptRunOutput } from "@repo/contracts/ScriptRun";
import {
	Workspace,
	WorkspaceHasUnsavedWorkError,
	WorkspaceNotFoundError,
	WorkspacePathInUseError,
} from "@repo/contracts/Workspace";
import type { CreateWorkspaceInput } from "@repo/contracts/WorkspaceRpcs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Context, Effect, FiberMap, FileSystem, Layer } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { ChildProcessSpawner } from "effect/process";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import {
	LocalDatabase,
	PRIVATE_DIRECTORY_MODE,
} from "../database/LocalDatabase.ts";
import { newId } from "../database/newId.ts";
import { nowIso } from "../database/nowIso.ts";
import { project, scriptRun, workspace } from "../database/schema.ts";
import { runGit } from "../git/runGit.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { CappedOutput } from "./CappedOutput.ts";
import { createWorktree } from "./createWorktree.ts";
import { findUnsavedWork, removeWorktree } from "./removeWorktree.ts";
import { applyScriptRunEvent, runSetupScript } from "./runSetupScript.ts";
import { SetupScriptSettings } from "./SetupScriptSettings.ts";

type WorkspaceRow = typeof workspace.$inferSelect;
type ScriptRunRow = typeof scriptRun.$inferInsert;

const UNFINISHED = ["pending", "processing"] as const;

export class WorkspaceService extends Context.Service<WorkspaceService>()(
	"swarm/daemon/workspaces/WorkspaceService",
	{
		make: Effect.gen(function* () {
			const { dataDir } = yield* DaemonConfig;
			const database = yield* LocalDatabase;
			const projects = yield* ProjectService;
			const fs = yield* FileSystem.FileSystem;
			const services = yield* Effect.context<
				| LocalDatabase
				| ChildProcessSpawner.ChildProcessSpawner
				| SecureRandom.SecureRandom
			>();
			// One fiber per running script, interrupted when its workspace is archived
			// and when the daemon stops.
			const runningScripts = yield* FiberMap.make<string>();
			const outputs = new Map<string, CappedOutput>();

			const startSetupScript = (
				scriptRunId: string,
				script: string,
				cwd: string,
			) => {
				const output = new CappedOutput();
				outputs.set(scriptRunId, output);
				return FiberMap.run(
					runningScripts,
					scriptRunId,
					runSetupScript({ scriptRunId, script, cwd, output }).pipe(
						Effect.catch((error) =>
							Effect.logError("Setup script job stopped", error),
						),
						Effect.provide(services),
					),
				);
			};

			const insertWorkspace = (
				row: WorkspaceRow,
				setupRun: ScriptRunRow | null,
			) =>
				database.query((db) =>
					db.transaction((tx) =>
						Effect.gen(function* () {
							const taken = yield* tx.$count(
								workspace,
								and(
									eq(workspace.path, row.path),
									eq(workspace.status, "active"),
								),
							);
							if (taken > 0) {
								return false;
							}
							yield* tx.insert(workspace).values(row);
							if (setupRun !== null) {
								yield* tx.insert(scriptRun).values(setupRun);
							}
							return true;
						}),
					),
				);

			const isPathActive = (path: string) =>
				database
					.query((db) =>
						db.$count(
							workspace,
							and(eq(workspace.path, path), eq(workspace.status, "active")),
						),
					)
					.pipe(Effect.map((count) => count > 0));

			const create = Effect.fn("WorkspaceService.create")(function* (
				input: CreateWorkspaceInput,
			) {
				const owner = yield* projects.get(input.projectId);
				const now = yield* nowIso;
				const id = yield* newId;
				const base = {
					id,
					projectId: owner.id,
					baseBranch: owner.defaultBranch,
					status: "active",
					pullRequestUrl: null,
					createdAt: now,
					archivedAt: null,
				} as const;

				let row: WorkspaceRow;
				let setupRun: ScriptRunRow | null = null;
				if (input.kind === "worktree") {
					const worktreesDir = join(dataDir, "worktrees");
					const path = join(worktreesDir, basename(owner.path), input.name);
					// Checked before git touches the disk, so the user gets a clear error.
					if (yield* isPathActive(path)) {
						return yield* new WorkspacePathInUseError({ path });
					}
					// The worktrees folder holds checked-out code, so it is as private as the data dir.
					yield* fs
						.makeDirectory(worktreesDir, {
							recursive: true,
							mode: PRIVATE_DIRECTORY_MODE,
						})
						.pipe(
							Effect.andThen(fs.chmod(worktreesDir, PRIVATE_DIRECTORY_MODE)),
							Effect.orDie,
						);
					yield* createWorktree({
						repositoryPath: owner.path,
						worktreePath: path,
						branch: input.name,
						baseBranch: owner.defaultBranch,
					});
					row = {
						...base,
						name: input.name,
						kind: "worktree",
						path,
						branch: input.name,
					};
					if (owner.setupScript !== null) {
						setupRun = {
							id: yield* newId,
							workspaceId: id,
							kind: "setup",
							status: "pending",
							attempts: 0,
							createdAt: now,
							updatedAt: now,
						};
					}
				} else {
					const current = yield* runGit(owner.path, [
						"branch",
						"--show-current",
					]);
					row = {
						...base,
						name: owner.name,
						kind: "inPlace",
						path: owner.path,
						// An empty answer means a detached HEAD.
						branch: current === "" ? "HEAD" : current,
					};
				}

				if (!(yield* insertWorkspace(row, setupRun))) {
					return yield* new WorkspacePathInUseError({ path: row.path });
				}
				yield* Effect.logInfo("Created workspace").pipe(
					Effect.annotateLogs({
						workspaceId: id,
						kind: row.kind,
						path: row.path,
					}),
				);
				if (setupRun !== null && owner.setupScript !== null) {
					// Never block the RPC on the script.
					yield* startSetupScript(setupRun.id, owner.setupScript, row.path);
				}
				return new Workspace(row);
			}, Effect.provide(services));

			const get = Effect.fn("WorkspaceService.get")(function* (
				workspaceId: string,
			) {
				const [row] = yield* database.query((db) =>
					db.select().from(workspace).where(eq(workspace.id, workspaceId)),
				);
				if (row === undefined) {
					return yield* new WorkspaceNotFoundError({ workspaceId });
				}
				return new Workspace(row);
			});

			const list = (projectId: string) =>
				database
					.query((db) =>
						db
							.select()
							.from(workspace)
							.where(eq(workspace.projectId, projectId))
							.orderBy(asc(workspace.createdAt)),
					)
					.pipe(Effect.map((rows) => rows.map((row) => new Workspace(row))));

			const cancelScripts = Effect.fn("WorkspaceService.cancelScripts")(
				function* (workspaceId: string, reason: string) {
					const unfinished = yield* database.query((db) =>
						db
							.select({ id: scriptRun.id })
							.from(scriptRun)
							.where(
								and(
									eq(scriptRun.workspaceId, workspaceId),
									inArray(scriptRun.status, UNFINISHED),
								),
							),
					);
					for (const run of unfinished) {
						yield* FiberMap.remove(runningScripts, run.id);
						yield* applyScriptRunEvent(run.id, { _tag: "Cancelled", reason });
					}
				},
				Effect.provide(services),
			);

			const archive = Effect.fn("WorkspaceService.archive")(function* (
				workspaceId: string,
				options: { readonly force: boolean },
			) {
				const current = yield* get(workspaceId);
				if (current.status === "archived") {
					return current;
				}
				if (current.kind === "worktree") {
					// The foreign key keeps the project while it has workspaces.
					const owner = yield* projects
						.get(current.projectId)
						.pipe(Effect.catchTag("ProjectNotFoundError", Effect.die));
					if (yield* fs.exists(current.path).pipe(Effect.orDie)) {
						const unsaved = yield* findUnsavedWork(
							current.path,
							current.baseBranch,
						);
						const hasUnsaved =
							unsaved.changedFiles.length > 0 || unsaved.unpushedCommits > 0;
						if (hasUnsaved && !options.force) {
							return yield* new WorkspaceHasUnsavedWorkError({
								workspaceId,
								...unsaved,
							});
						}
						yield* cancelScripts(workspaceId, "The workspace was archived.");
						yield* removeWorktree({
							repositoryPath: owner.path,
							worktreePath: current.path,
							stashMessage:
								unsaved.changedFiles.length > 0
									? `swarm-archive/${workspaceId}`
									: null,
						});
					} else {
						// Someone deleted the folder already. Forget it in git and carry on.
						yield* Effect.logWarning(
							"Worktree folder is missing, pruning it",
						).pipe(Effect.annotateLogs({ workspaceId, path: current.path }));
						yield* cancelScripts(workspaceId, "The workspace was archived.");
						yield* runGit(owner.path, ["worktree", "prune"]);
					}
				} else {
					// In place: the folder is the project itself, so nothing is removed.
					yield* cancelScripts(workspaceId, "The workspace was archived.");
				}

				const archivedAt = yield* nowIso;
				yield* database.query((db) =>
					db
						.update(workspace)
						.set({ status: "archived", archivedAt })
						.where(eq(workspace.id, workspaceId)),
				);
				const runs = yield* listScriptRuns(workspaceId);
				for (const run of runs) {
					outputs.delete(run.id);
				}
				yield* Effect.logInfo("Archived workspace").pipe(
					Effect.annotateLogs({ workspaceId }),
				);
				return yield* get(workspaceId);
			}, Effect.provide(services));

			const listScriptRuns = (workspaceId: string) =>
				database
					.query((db) =>
						db
							.select()
							.from(scriptRun)
							.where(eq(scriptRun.workspaceId, workspaceId))
							.orderBy(asc(scriptRun.createdAt)),
					)
					.pipe(Effect.map((rows) => rows.map((row) => new ScriptRun(row))));

			const getScriptRunOutput = (scriptRunId: string) =>
				new ScriptRunOutput({
					scriptRunId,
					output: outputs.get(scriptRunId)?.toString() ?? "",
				});

			// Startup recovery: runs left in processing were cut off by a restart, which is a
			// retryable failure. Then every pending run of an active workspace starts again.
			const recoverScriptRuns = Effect.gen(function* () {
				const { maxAttempts } = yield* SetupScriptSettings;
				const cutOff = yield* database.query((db) =>
					db
						.select({ id: scriptRun.id })
						.from(scriptRun)
						.where(eq(scriptRun.status, "processing")),
				);
				for (const run of cutOff) {
					yield* applyScriptRunEvent(run.id, {
						_tag: "FailedRetryably",
						error: "The daemon restarted while the setup script was running.",
						maxAttempts,
					});
				}
				const pending = yield* database.query((db) =>
					db
						.select({
							id: scriptRun.id,
							path: workspace.path,
							workspaceStatus: workspace.status,
							script: project.setupScript,
						})
						.from(scriptRun)
						.innerJoin(workspace, eq(scriptRun.workspaceId, workspace.id))
						.innerJoin(project, eq(workspace.projectId, project.id))
						.where(eq(scriptRun.status, "pending")),
				);
				for (const run of pending) {
					if (run.workspaceStatus === "active" && run.script !== null) {
						yield* startSetupScript(run.id, run.script, run.path);
					} else {
						yield* applyScriptRunEvent(run.id, {
							_tag: "Cancelled",
							reason: "The workspace was archived or its setup script removed.",
						});
					}
				}
				if (cutOff.length > 0 || pending.length > 0) {
					yield* Effect.logInfo("Recovered setup scripts after a restart").pipe(
						Effect.annotateLogs({
							cutOff: cutOff.length,
							resumed: pending.length,
						}),
					);
				}
			});
			yield* recoverScriptRuns.pipe(Effect.provide(services));

			return { create, get, list, archive, listScriptRuns, getScriptRunOutput };
		}),
	},
) {
	static readonly layer = Layer.effect(WorkspaceService, WorkspaceService.make);
}
