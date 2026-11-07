import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { runGit } from "../git/runGit.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { runServiceTest } from "../testing/runServiceTest.ts";
import { ProjectService } from "./ProjectService.ts";

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
});
