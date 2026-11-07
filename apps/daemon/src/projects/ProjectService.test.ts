import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { runServiceTest } from "../testing/runServiceTest.ts";
import { ProjectFolderName } from "@repo/contracts/Project";
import { ProjectService } from "./ProjectService.ts";
import { describe, expect, test } from "bun:test";
import { runGit } from "../git/runGit.ts";
import { Effect, Schema } from "effect";
import { join } from "node:path";

describe("ProjectService", () => {
	test("rejects a folder that is not a git repository", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.flatMap(ProjectService, (projects) => Effect.flip(projects.add(tempDir))),
		);
		expect(error._tag).toBe("NotAGitRepositoryError");
	});

	test("rejects a folder that does not exist", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.flatMap(ProjectService, (projects) => Effect.flip(projects.add(join(tempDir, "missing")))),
		);
		expect(error._tag).toBe("ProjectFolderNotFoundError");
	});

	test("adds a repository once and lists it", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				const added = yield* projects.add(path);
				const again = yield* Effect.flip(projects.add(path));
				return { added, again, listed: yield* projects.list };
			}),
		);
		expect(result.added.name).toBe("repo");
		expect(result.again._tag).toBe("ProjectAlreadyAddedError");
		expect(result.listed).toEqual([result.added]);
	});

	test("reads the default branch from origin/HEAD first", async () => {
		const project = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const origin = yield* makeTestRepository(join(tempDir, "origin"));
				yield* runGit(origin, ["branch", "-m", "trunk"]);
				const clone = join(tempDir, "clone");
				yield* runGit(tempDir, ["clone", "--quiet", origin, clone]);
				yield* runGit(clone, ["checkout", "-b", "feature"]);
				yield* runGit(clone, ["config", "init.defaultBranch", "other"]);
				return yield* Effect.flatMap(ProjectService, (projects) => projects.add(clone));
			}),
		);
		expect(project.defaultBranch).toBe("trunk");
	});

	test("falls back to init.defaultBranch without origin/HEAD", async () => {
		const project = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["checkout", "-b", "feature"]);
				yield* runGit(path, ["config", "init.defaultBranch", "develop"]);
				return yield* Effect.flatMap(ProjectService, (projects) => projects.add(path));
			}),
		);
		expect(project.defaultBranch).toBe("develop");
	});

	test("falls back to the checked-out branch last", async () => {
		const project = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["checkout", "-b", "feature"]);
				// An empty local value hides any global init.defaultBranch.
				yield* runGit(path, ["config", "init.defaultBranch", ""]);
				return yield* Effect.flatMap(ProjectService, (projects) => projects.add(path));
			}),
		);
		expect(project.defaultBranch).toBe("feature");
	});

	test("updates scripts and treats blank ones as none", async () => {
		const project = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const added = yield* projects.add(yield* makeTestRepository(join(tempDir, "repo")));
				return yield* projects.updateScripts(added.id, {
					setupScript: " bun install ",
					runScript: "  ",
				});
			}),
		);
		expect(project.setupScript).toBe("bun install");
		expect(project.runScript).toBeNull();
	});

	test("starts untrusted and saves the trust setting", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const added = yield* projects.add(yield* makeTestRepository(join(tempDir, "repo")));
				const trusted = yield* projects.setTrust(added.id, true);
				const missing = yield* Effect.flip(projects.setTrust("missing", true));
				return { added, trusted, reloaded: yield* projects.get(added.id), missing };
			}),
		);
		expect(result.added.trusted).toBe(false);
		expect(result.trusted.trusted).toBe(true);
		expect(result.reloaded.trusted).toBe(true);
		expect(result.missing._tag).toBe("ProjectNotFoundError");
	});

	test("creates a new folder with a repository and an empty first commit, then adds it", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const created = yield* projects.create(tempDir, "fresh");
				const again = yield* Effect.flip(projects.create(tempDir, "fresh"));
				const missingParent = yield* Effect.flip(projects.create(join(tempDir, "nope"), "x"));
				return {
					tempDir,
					created,
					again,
					missingParent,
					log: yield* runGit(created.path, ["log", "--format=%s"]),
				};
			}),
		);
		expect(result.created).toMatchObject({ name: "fresh", defaultBranch: "main" });
		expect(result.created.path).toEndWith("/fresh");
		expect(result.log).toBe("Initial commit");
		expect(result.again._tag).toBe("ProjectFolderExistsError");
		expect(result.missingParent._tag).toBe("ProjectFolderNotFoundError");
	});

	test("rejects folder names that would leave the parent folder", () => {
		const isValid = Schema.is(ProjectFolderName);
		expect(["app", "my app", "a.b"].map(isValid)).toEqual([true, true, true]);
		expect(["..", ".", "a/b", "", "../x"].map(isValid)).toEqual([false, false, false, false, false]);
	});
});
