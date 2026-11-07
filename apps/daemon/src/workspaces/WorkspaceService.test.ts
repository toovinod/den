import { runInTempDir, runServiceTest, waitForScriptRun, withServices } from "../testing/runServiceTest.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { SetupScriptSettings } from "./SetupScriptSettings.ts";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { scriptRun, workspace } from "../database/schema.ts";
import { WorkspaceService } from "./WorkspaceService.ts";
import { Duration, Effect, FileSystem } from "effect";
import { describe, expect, test } from "bun:test";
import { runGit } from "../git/runGit.ts";
import { eq, sql } from "drizzle-orm";
import { join } from "node:path";

const addProject = Effect.fn("addProject")(function* (tempDir: string, setupScript: string | null = null) {
	const projects = yield* ProjectService;
	const path = yield* makeTestRepository(join(tempDir, "repo"));
	const added = yield* projects.add(path);
	return yield* projects.updateScripts(added.id, {
		setupScript,
		runScript: null,
	});
});

const fastRetries = {
	timeout: Duration.millis(100),
	maxAttempts: 3,
	retryBaseDelay: Duration.millis(1),
};

const branchExists = (repositoryPath: string, branch: string) =>
	runGit(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).pipe(
		Effect.as(true),
		Effect.catchTag("GitCommandError", () => Effect.succeed(false)),
	);

describe("WorkspaceService", () => {
	test("creates a worktree on a new branch under the data dir", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* addProject(tempDir);
				const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.create({
						kind: "worktree",
						projectId: project.id,
						name: "feature",
					}),
				);
				return {
					created,
					folderExists: yield* fs.exists(join(created.path, "README.md")),
					branchExists: yield* branchExists(project.path, "feature"),
					expectedPath: join(tempDir, "data", "worktrees", "repo", "feature"),
				};
			}),
		);
		expect(result.created).toMatchObject({
			kind: "worktree",
			branch: "feature",
			baseBranch: "main",
			status: "active",
		});
		expect(result.created.path).toBe(result.expectedPath);
		expect(result.folderExists).toBe(true);
		expect(result.branchExists).toBe(true);
	});

	test("refuses a name whose branch already exists", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				yield* runGit(project.path, ["branch", "taken"]);
				return yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					Effect.flip(
						workspaces.create({
							kind: "worktree",
							projectId: project.id,
							name: "taken",
						}),
					),
				);
			}),
		);
		expect(error._tag).toBe("BranchAlreadyExistsError");
	});

	test("creates an in-place workspace on the project folder, once", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const first = yield* workspaces.create({
					kind: "inPlace",
					projectId: project.id,
				});
				const second = yield* Effect.flip(workspaces.create({ kind: "inPlace", projectId: project.id }));
				return { project, first, second };
			}),
		);
		expect(result.first).toMatchObject({
			kind: "inPlace",
			path: result.project.path,
			branch: "main",
		});
		expect(result.second._tag).toBe("WorkspacePathInUseError");
	});

	test("archives a clean worktree: removes the folder, keeps the branch", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				const archived = yield* workspaces.archive(created.id, {
					force: false,
				});
				return {
					archived,
					folderExists: yield* fs.exists(created.path),
					branchExists: yield* branchExists(project.path, "feature"),
				};
			}),
		);
		expect(result.archived.status).toBe("archived");
		expect(result.archived.archivedAt).not.toBeNull();
		expect(result.folderExists).toBe(false);
		expect(result.branchExists).toBe(true);
	});

	test("refuses to archive unsaved work, then stashes it with force", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				yield* fs.writeFileString(join(created.path, "README.md"), "edited\n");
				yield* fs.writeFileString(join(created.path, "new.txt"), "new\n");
				const refused = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				const stillThere = yield* fs.exists(created.path);
				const archived = yield* workspaces.archive(created.id, { force: true });
				return {
					created,
					refused,
					stillThere,
					archived,
					folderExists: yield* fs.exists(created.path),
					stashes: yield* runGit(project.path, ["stash", "list"]),
					stashedFiles: yield* runGit(project.path, ["show", "--name-only", "--format=", "stash@{0}^3"]),
				};
			}),
		);
		expect(result.refused._tag).toBe("WorkspaceHasUnsavedWorkError");
		expect(result.refused).toMatchObject({
			changedFiles: ["README.md", "new.txt"],
			unpushedCommits: 0,
		});
		expect(result.stillThere).toBe(true);
		expect(result.archived.status).toBe("archived");
		expect(result.folderExists).toBe(false);
		expect(result.stashes).toContain(`swarm-archive/${result.created.id}`);
		// The untracked file is in the stash's untracked-files commit.
		expect(result.stashedFiles).toBe("new.txt");
	});

	test("counts commits no remote has as unsaved work", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				yield* runGit(created.path, ["commit", "--allow-empty", "-m", "work"]);
				const refused = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				const archived = yield* workspaces.archive(created.id, { force: true });
				return {
					refused,
					archived,
					branchHead: yield* runGit(project.path, ["log", "-1", "--format=%s", "feature"]),
				};
			}),
		);
		expect(result.refused).toMatchObject({
			_tag: "WorkspaceHasUnsavedWorkError",
			changedFiles: [],
			unpushedCommits: 1,
		});
		expect(result.archived.status).toBe("archived");
		expect(result.branchHead).toBe("work");
	});

	test("archiving an in-place workspace removes nothing", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* fs.writeFileString(join(project.path, "dirty.txt"), "x\n");
				const created = yield* workspaces.create({
					kind: "inPlace",
					projectId: project.id,
				});
				const archived = yield* workspaces.archive(created.id, {
					force: false,
				});
				return {
					archived,
					dirtyFileKept: yield* fs.exists(join(project.path, "dirty.txt")),
				};
			}),
		);
		expect(result.archived.status).toBe("archived");
		expect(result.dirtyFileKept).toBe(true);
	});

	test("removing a project is refused while it has active workspaces", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const database = yield* LocalDatabase;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "inPlace",
					projectId: project.id,
				});
				const refused = yield* Effect.flip(projects.remove(project.id));
				yield* workspaces.archive(created.id, { force: false });
				yield* projects.remove(project.id);
				const leftover = yield* database.query((db) => db.select().from(workspace).where(eq(workspace.id, created.id)));
				return { refused, leftover, listed: yield* projects.list };
			}),
		);
		expect(result.refused).toMatchObject({
			_tag: "ProjectHasActiveWorkspacesError",
			activeWorkspaces: 1,
		});
		expect(result.leftover).toEqual([]);
		expect(result.listed).toEqual([]);
	});

	test("runs the setup script in the background and keeps its output", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "sleep 0.2; echo hello; echo oops >&2; pwd");
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				const [rightAfterCreate] = yield* workspaces.listScriptRuns(created.id);
				const finished = yield* waitForScriptRun(created.id);
				const output = workspaces.getScriptRunOutput(finished?.id ?? "");
				return { created, rightAfterCreate, finished, output };
			}),
		);
		expect(result.rightAfterCreate?.status).toMatch(/pending|processing/);
		expect(result.finished).toMatchObject({
			kind: "setup",
			status: "completed",
			exitCode: 0,
			attempts: 0,
		});
		expect(result.output.output).toContain("hello");
		expect(result.output.output).toContain("oops");
		expect(result.output.output).toContain(result.created.path);
	});

	test("a failing setup script fails at once, without retries", async () => {
		const run = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "exit 3");
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				return yield* waitForScriptRun(created.id);
			}),
		);
		expect(run).toMatchObject({
			status: "failed",
			exitCode: 3,
			attempts: 0,
			lastError: "The setup script exited with code 3.",
		});
	});

	test("a timed-out setup script is retried, then dead-lettered", async () => {
		const run = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "sleep 5");
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				return yield* waitForScriptRun(created.id);
			}).pipe(Effect.provideService(SetupScriptSettings, fastRetries)),
		);
		expect(run).toMatchObject({
			status: "deadLetter",
			attempts: 3,
			lastError: "The setup script did not finish within 100ms.",
		});
		expect(run?.finishedAt).not.toBeNull();
	});

	test("on startup, a run cut off in processing is retried", async () => {
		const run = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const dataDir = join(tempDir, "data");
				// First lifetime: a worktree whose setup run was mid-flight when the daemon died.
				const workspaceId = yield* withServices(dataDir)(
					Effect.gen(function* () {
						const project = yield* addProject(tempDir);
						const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
							workspaces.create({
								kind: "worktree",
								projectId: project.id,
								name: "feature",
							}),
						);
						yield* Effect.flatMap(ProjectService, (projects) =>
							projects.updateScripts(project.id, {
								setupScript: "echo recovered",
								runScript: null,
							}),
						);
						yield* Effect.flatMap(LocalDatabase, (database) =>
							database.query((db) =>
								db.insert(scriptRun).values({
									id: "cut-off-run",
									workspaceId: created.id,
									kind: "setup",
									status: "processing",
									attempts: 0,
									createdAt: "2026-11-07T00:00:00.000Z",
									updatedAt: "2026-11-07T00:00:00.000Z",
									startedAt: "2026-11-07T00:00:00.000Z",
								}),
							),
						);
						return created.id;
					}),
				);
				// Second lifetime: startup recovery picks the run up again.
				return yield* withServices(dataDir)(waitForScriptRun(workspaceId));
			}),
		);
		expect(run).toMatchObject({
			id: "cut-off-run",
			status: "completed",
			attempts: 1,
			exitCode: 0,
		});
	});

	test("removes the new worktree and branch when the workspace cannot be saved", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* addProject(tempDir);
				const database = yield* LocalDatabase;
				yield* database.query((db) =>
					db.run(sql`CREATE TRIGGER failInsert BEFORE INSERT ON workspace BEGIN SELECT RAISE(ABORT, 'disk full'); END`),
				);
				const error = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					Effect.flip(workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" })),
				);
				return {
					error,
					folderExists: yield* fs.exists(join(tempDir, "data", "worktrees", "repo", "feature")),
					branchExists: yield* branchExists(project.path, "feature"),
				};
			}),
		);
		expect(result.error._tag).toBe("LocalDatabaseError");
		expect(result.folderExists).toBe(false);
		expect(result.branchExists).toBe(false);
	});

	test("archiving the same workspace from several calls at once archives it once", async () => {
		const results = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const workspaces = yield* WorkspaceService;
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				const archive = workspaces.archive(created.id, { force: false });
				return yield* Effect.all([archive, archive, archive, archive], { concurrency: "unbounded" });
			}),
		);
		expect(results.map((archived) => archived.status)).toEqual(["archived", "archived", "archived", "archived"]);
	});
});
