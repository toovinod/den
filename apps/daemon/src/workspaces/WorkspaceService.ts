import {
	Workspace,
	WorkspaceArchivedError,
	WorkspaceHasUnsavedWorkError,
	WorkspaceNotFoundError,
	WorkspacePathInUseError,
} from "@repo/contracts/Workspace";
import { Context, Effect, FiberMap, FileSystem, Layer, PubSub, Semaphore, Stream } from "effect";
import { RunScriptMissingError, ScriptRun, ScriptRunOutput } from "@repo/contracts/ScriptRun";
import { discardWorktree, findUnsavedWork, removeWorktree } from "./removeWorktree.ts";
import { LocalDatabase, PRIVATE_DIRECTORY_MODE } from "../database/LocalDatabase.ts";
import { applyScriptRunEvent, runSetupScript } from "./runSetupScript.ts";
import type { CreateWorkspaceInput } from "@repo/contracts/WorkspaceRpcs";
import { project, scriptRun, workspace } from "../database/schema.ts";
import { TerminalService } from "../terminals/TerminalService.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { SessionService } from "../sessions/SessionService.ts";
import { SetupScriptSettings } from "./SetupScriptSettings.ts";
import type { ScriptRunKind } from "@repo/contracts/ScriptRun";
import type { ChildProcessSpawner } from "effect/process";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { ScriptRunChanges } from "./ScriptRunChanges.ts";
import { createWorktree } from "./createWorktree.ts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { WorkspaceLock } from "./WorkspaceLock.ts";
import type { SecureRandom } from "effect/crypto";
import { CappedOutput } from "./CappedOutput.ts";
import { runRunScript } from "./runRunScript.ts";
import { nowIso } from "../database/nowIso.ts";
import { newId } from "../database/newId.ts";
import { runGit } from "../git/runGit.ts";
import { join } from "node:path";

type WorkspaceRow = typeof workspace.$inferSelect;
type ScriptRunRow = typeof scriptRun.$inferInsert;
type ScriptServices =
	| LocalDatabase
	| ScriptRunChanges
	| ChildProcessSpawner.ChildProcessSpawner
	| SecureRandom.SecureRandom;

const UNFINISHED = ["pending", "processing"] as const;

// The kept tail of a run's output, plus live lines for clients following it.
// A null line marks the end of the run.
type LiveLine = { readonly index: number; readonly line: string | null };

interface ScriptOutput {
	readonly lines: CappedOutput;
	readonly live: PubSub.PubSub<LiveLine>;
	count: number;
	finished: boolean;
}

// A slow follower loses old lines rather than growing the daemon's memory.
const LIVE_LINES = 1000;

// Finished output stays so the UI can show why a run failed, but only for the latest runs: a
// daemon that runs scripts for weeks would otherwise hold the output of every one.
export const MAX_FINISHED_OUTPUTS = 20;

export class WorkspaceService extends Context.Service<WorkspaceService>()(
	"octopus/daemon/workspaces/WorkspaceService",
	{
		make: Effect.gen(function* () {
			const { dataDir } = yield* DaemonConfig;
			const database = yield* LocalDatabase;
			const projects = yield* ProjectService;
			const sessions = yield* SessionService;
			const terminals = yield* TerminalService;
			const workspaceLock = yield* WorkspaceLock;
			const scriptRunChanges = yield* ScriptRunChanges;
			const fs = yield* FileSystem.FileSystem;
			const services = yield* Effect.context<ScriptServices>();
			// One fiber per running script, interrupted when its workspace is archived
			// and when the daemon stops.
			const runningScripts = yield* FiberMap.make<string>();
			// Archiving runs git on the worktree folder, so two archives at once could both try to remove it.
			const archiveLock = yield* Semaphore.make(1);
			// Two quick clicks on Run must not start the run script twice.
			const runScriptLock = yield* Semaphore.make(1);
			const outputs = new Map<string, ScriptOutput>();

			const startScript = Effect.fn("WorkspaceService.startScript")(function* (
				scriptRunId: string,
				job: (onLine: (line: string) => void) => Effect.Effect<void, unknown, ScriptServices>,
			) {
				const output: ScriptOutput = {
					lines: new CappedOutput(),
					live: yield* PubSub.sliding<LiveLine>(LIVE_LINES),
					count: 0,
					finished: false,
				};
				outputs.set(scriptRunId, output);
				const publish = (line: string | null) => {
					output.count++;
					PubSub.publishUnsafe(output.live, { index: output.count, line });
				};
				const onLine = (line: string) => {
					output.lines.append(line);
					publish(line);
				};
				return yield* FiberMap.run(
					runningScripts,
					scriptRunId,
					job(onLine).pipe(
						Effect.catch((error) => Effect.logError("Script job stopped", error)),
						Effect.ensuring(
							Effect.sync(() => {
								output.finished = true;
								const finished = [...outputs].filter(([, kept]) => kept.finished);
								for (const [id] of finished.slice(0, -MAX_FINISHED_OUTPUTS)) outputs.delete(id);
								// Last: a follower waiting on the end resumes inside this call.
								publish(null);
							}),
						),
						Effect.provide(services),
					),
				);
			});

			const startSetupScript = (scriptRunId: string, script: string, cwd: string) =>
				startScript(scriptRunId, (onLine) => runSetupScript({ scriptRunId, script, cwd, onLine }));

			const insertWorkspace = (row: WorkspaceRow, setupRun: ScriptRunRow | null) =>
				database.query((db) =>
					db.transaction((tx) =>
						Effect.gen(function* () {
							const taken = yield* tx.$count(
								workspace,
								and(eq(workspace.path, row.path), eq(workspace.status, "active")),
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
					.query((db) => db.$count(workspace, and(eq(workspace.path, path), eq(workspace.status, "active"))))
					.pipe(Effect.map((count) => count > 0));

			const create = Effect.fn("WorkspaceService.create")(function* (input: CreateWorkspaceInput) {
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
					// Keyed by project id: two repositories can share a folder name. The UI shows the workspace name.
					const path = join(worktreesDir, owner.id, input.name);
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
						.pipe(Effect.andThen(fs.chmod(worktreesDir, PRIVATE_DIRECTORY_MODE)), Effect.orDie);
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
					const current = yield* runGit(owner.path, ["branch", "--show-current"]);
					row = {
						...base,
						name: owner.name,
						kind: "inPlace",
						path: owner.path,
						// An empty answer means a detached HEAD.
						branch: current === "" ? "HEAD" : current,
					};
				}

				yield* insertWorkspace(row, setupRun).pipe(
					Effect.flatMap((inserted) =>
						inserted ? Effect.void : Effect.fail(new WorkspacePathInUseError({ path: row.path })),
					),
					Effect.onError(() =>
						row.kind === "worktree"
							? discardWorktree({ repositoryPath: owner.path, worktreePath: row.path, branch: row.branch })
							: Effect.void,
					),
				);
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

			const get = Effect.fn("WorkspaceService.get")(function* (workspaceId: string) {
				const [row] = yield* database.query((db) => db.select().from(workspace).where(eq(workspace.id, workspaceId)));
				if (row === undefined) {
					return yield* new WorkspaceNotFoundError({ workspaceId });
				}
				return new Workspace(row);
			});

			const list = (projectId: string) =>
				database
					.query((db) =>
						db.select().from(workspace).where(eq(workspace.projectId, projectId)).orderBy(asc(workspace.createdAt)),
					)
					.pipe(Effect.map((rows) => rows.map((row) => new Workspace(row))));

			const cancelScripts = Effect.fn("WorkspaceService.cancelScripts")(function* (
				workspaceId: string,
				reason: string,
				kinds: ReadonlyArray<ScriptRunKind> = ["setup", "run"],
			) {
				const unfinished = yield* database.query((db) =>
					db
						.select({ id: scriptRun.id })
						.from(scriptRun)
						.where(
							and(
								eq(scriptRun.workspaceId, workspaceId),
								inArray(scriptRun.status, UNFINISHED),
								inArray(scriptRun.kind, kinds),
							),
						),
				);
				for (const run of unfinished) {
					yield* FiberMap.remove(runningScripts, run.id);
					yield* applyScriptRunEvent(run.id, { _tag: "Cancelled", reason }).pipe(
						// The script finished on its own between the query and the interrupt.
						Effect.catchTag("IllegalJobTransitionError", (error) =>
							Effect.logDebug("Script run ended before it was cancelled", error),
						),
					);
				}
			}, Effect.provide(services));

			// Agents, terminals and scripts all run in the workspace folder, so they stop before it can be
			// removed. Only once archiving goes ahead: a refused archive leaves them running.
			const stopWorkspaceProcesses = (workspaceId: string) =>
				Effect.gen(function* () {
					yield* sessions.stopWorkspace(workspaceId);
					yield* terminals.closeWorkspace(workspaceId);
					yield* cancelScripts(workspaceId, "The workspace was archived.");
				});

			const archive = Effect.fn("WorkspaceService.archive")(
				function* (workspaceId: string, options: { readonly force: boolean }) {
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
							const unsaved = yield* findUnsavedWork(current.path, current.baseBranch);
							const hasUnsaved = unsaved.changedFiles.length > 0 || unsaved.unpushedCommits > 0;
							if (hasUnsaved && !options.force) {
								return yield* new WorkspaceHasUnsavedWorkError({
									workspaceId,
									...unsaved,
								});
							}
							yield* stopWorkspaceProcesses(workspaceId);
							yield* removeWorktree({
								repositoryPath: owner.path,
								worktreePath: current.path,
								stashMessage: unsaved.changedFiles.length > 0 ? `octopus-archive/${workspaceId}` : null,
							});
						} else {
							// Someone deleted the folder already. Forget it in git and carry on.
							yield* Effect.logWarning("Worktree folder is missing, pruning it").pipe(
								Effect.annotateLogs({ workspaceId, path: current.path }),
							);
							yield* stopWorkspaceProcesses(workspaceId);
							yield* runGit(owner.path, ["worktree", "prune"]);
						}
					} else {
						// In place: the folder is the project itself, so nothing is removed.
						yield* stopWorkspaceProcesses(workspaceId);
					}

					const archivedAt = yield* nowIso;
					yield* database.query((db) =>
						db.update(workspace).set({ status: "archived", archivedAt }).where(eq(workspace.id, workspaceId)),
					);
					yield* sessions.deleteWorkspaceAttachments(workspaceId);
					const runs = yield* listScriptRuns(workspaceId);
					for (const run of runs) {
						outputs.delete(run.id);
					}
					yield* Effect.logInfo("Archived workspace").pipe(Effect.annotateLogs({ workspaceId }));
					return yield* get(workspaceId);
				},
				(effect, workspaceId) => workspaceLock.archiving(workspaceId, effect),
				Semaphore.withPermit(archiveLock),
				Effect.provide(services),
			);

			const listScriptRuns = (workspaceId: string) =>
				database
					.query((db) =>
						db.select().from(scriptRun).where(eq(scriptRun.workspaceId, workspaceId)).orderBy(asc(scriptRun.createdAt)),
					)
					.pipe(Effect.map((rows) => rows.map((row) => new ScriptRun(row))));

			const getScriptRunOutput = (scriptRunId: string) =>
				new ScriptRunOutput({
					scriptRunId,
					output: outputs.get(scriptRunId)?.lines.toString() ?? "",
				});

			// The kept output as one chunk, then each new line, until the run ends.
			const followScriptRunOutput = (scriptRunId: string): Stream.Stream<string> =>
				Stream.unwrap(
					Effect.gen(function* () {
						const output = outputs.get(scriptRunId);
						if (output === undefined) {
							return Stream.empty;
						}
						// Subscribe before the snapshot, then skip the lines it already holds.
						const subscription = yield* PubSub.subscribe(output.live);
						const snapshotIndex = output.count;
						const snapshot = output.lines.toString();
						const kept = snapshot === "" ? Stream.empty : Stream.succeed(snapshot);
						if (output.finished) {
							return kept;
						}
						return Stream.concat(
							kept,
							Stream.fromSubscription(subscription).pipe(
								Stream.filter((item) => item.index > snapshotIndex),
								Stream.takeWhile((item) => item.line !== null),
								Stream.map((item) => item.line ?? ""),
							),
						);
					}),
				);

			const findRunningRunScript = (workspaceId: string) =>
				database
					.query((db) =>
						db
							.select()
							.from(scriptRun)
							.where(
								and(
									eq(scriptRun.workspaceId, workspaceId),
									eq(scriptRun.kind, "run"),
									inArray(scriptRun.status, UNFINISHED),
								),
							),
					)
					.pipe(Effect.map(([row]) => (row === undefined ? null : new ScriptRun(row))));

			const startRunScript = Effect.fn("WorkspaceService.startRunScript")(
				function* (workspaceId: string) {
					const current = yield* get(workspaceId);
					if (current.status === "archived") {
						return yield* new WorkspaceArchivedError({ workspaceId });
					}
					const owner = yield* projects.get(current.projectId);
					const script = owner.runScript;
					if (script === null) {
						return yield* new RunScriptMissingError({ projectId: owner.id });
					}
					const running = yield* findRunningRunScript(workspaceId);
					if (running !== null) {
						return running;
					}
					const now = yield* nowIso;
					const scriptRunId = yield* newId;
					yield* database.query((db) =>
						db.insert(scriptRun).values({
							id: scriptRunId,
							workspaceId,
							kind: "run",
							status: "pending",
							attempts: 0,
							createdAt: now,
							updatedAt: now,
						}),
					);
					yield* startScript(scriptRunId, (onLine) => runRunScript({ scriptRunId, script, cwd: current.path, onLine }));
					yield* Effect.logInfo("Started run script").pipe(Effect.annotateLogs({ workspaceId, scriptRunId }));
					return new ScriptRun({
						id: scriptRunId,
						workspaceId,
						kind: "run",
						status: "pending",
						attempts: 0,
						lastError: null,
						exitCode: null,
						createdAt: now,
						updatedAt: now,
						startedAt: null,
						finishedAt: null,
					});
				},
				Semaphore.withPermit(runScriptLock),
				// Outside the run script lock, so an archive holding one workspace never blocks the others.
				(effect, workspaceId) => workspaceLock.starting(workspaceId, effect),
				Effect.provide(services),
			);

			const watchScriptRuns = (workspaceId: string): Stream.Stream<ScriptRun> =>
				Stream.fromPubSub(scriptRunChanges).pipe(Stream.filter((run) => run.workspaceId === workspaceId));

			const stopRunScript = (workspaceId: string) => cancelScripts(workspaceId, "Stopped.", ["run"]);

			const setPullRequestUrl = Effect.fn("WorkspaceService.setPullRequestUrl")(function* (
				workspaceId: string,
				pullRequestUrl: string,
			) {
				yield* database.query((db) =>
					db.update(workspace).set({ pullRequestUrl }).where(eq(workspace.id, workspaceId)),
				);
				return yield* get(workspaceId);
			});

			// Startup recovery: runs left in processing were cut off by a restart, which is a
			// retryable failure. Then every pending run of an active workspace starts again.
			const recoverScriptRuns = Effect.gen(function* () {
				const { maxAttempts } = yield* SetupScriptSettings;
				const cutOff = yield* database.query((db) =>
					db
						.select({ id: scriptRun.id, kind: scriptRun.kind })
						.from(scriptRun)
						.where(eq(scriptRun.status, "processing")),
				);
				for (const run of cutOff) {
					yield* applyScriptRunEvent(
						run.id,
						run.kind === "setup"
							? {
									_tag: "FailedRetryably",
									error: "The daemon restarted while the setup script was running.",
									maxAttempts,
								}
							: // The user starts run scripts, so a restart stops them instead of running them again.
								{ _tag: "Cancelled", reason: "The daemon restarted, so the run script stopped." },
					);
				}
				const pending = yield* database.query((db) =>
					db
						.select({
							id: scriptRun.id,
							kind: scriptRun.kind,
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
					if (run.kind === "setup" && run.workspaceStatus === "active" && run.script !== null) {
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

			return {
				create,
				get,
				list,
				archive,
				listScriptRuns,
				getScriptRunOutput,
				followScriptRunOutput,
				startRunScript,
				stopRunScript,
				watchScriptRuns,
				setPullRequestUrl,
			};
		}),
	},
) {
	static readonly layer = Layer.effect(WorkspaceService, WorkspaceService.make);
}
