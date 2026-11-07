import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { FileService, READ_FILE_BYTE_LIMIT } from "./FileService.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { runServiceTest } from "../testing/runServiceTest.ts";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";

const createWorkspace = Effect.fn("createWorkspace")(function* (tempDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const projects = yield* ProjectService;
	const workspaces = yield* WorkspaceService;
	const project = yield* projects.add(yield* makeTestRepository(join(tempDir, "repo")));
	const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
	const write = (path: string, text: string) => fs.writeFileString(join(created.path, path), text);
	yield* fs.makeDirectory(join(created.path, "src", "deep"), { recursive: true });
	yield* fs.makeDirectory(join(created.path, "build"));
	yield* write(".gitignore", "build/\n*.log\n");
	yield* write("src/index.ts", "export {};\n");
	yield* write("src/deep/inner.ts", "inner\n");
	yield* write("build/out.js", "generated\n");
	yield* write("debug.log", "noise\n");
	yield* fs.writeFile(join(created.path, "logo.png"), new Uint8Array([137, 80, 0, 71]));
	yield* fs.writeFileString(join(tempDir, "secret.txt"), "outside\n");
	yield* fs.symlink("/etc/hosts", join(created.path, "link.txt"));
	// A folder link that leads out of the workspace.
	yield* fs.symlink(tempDir, join(created.path, "src", "outside"));
	return created;
});

describe("FileService", () => {
	test("lists one folder at a time and skips ignored files", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const files = yield* FileService;
				const created = yield* createWorkspace(tempDir);
				return {
					root: yield* files.listDirectory(created.id, ""),
					src: yield* files.listDirectory(created.id, "src"),
					parent: yield* files.listDirectory(created.id, "../"),
				};
			}),
		);
		expect(result.root.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
			"directory:src",
			"file:.gitignore",
			"file:link.txt",
			"file:logo.png",
			"file:README.md",
		]);
		expect(result.parent).toEqual([]);
		expect(result.src.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
			"directory:src/deep",
			"file:src/index.ts",
			"file:src/outside",
		]);
	});

	test("reads text, flags binary and large files, and never leaves the workspace", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const files = yield* FileService;
				const created = yield* createWorkspace(tempDir);
				yield* fs.writeFileString(join(created.path, "big.txt"), "x".repeat(READ_FILE_BYTE_LIMIT + 1));
				return {
					text: yield* files.readFile(created.id, "src/index.ts"),
					binary: yield* files.readFile(created.id, "logo.png"),
					big: yield* files.readFile(created.id, "big.txt"),
					traversal: yield* Effect.flip(files.readFile(created.id, "../secret.txt")),
					symlink: yield* files.readFile(created.id, "link.txt"),
					throughLinkedFolder: yield* Effect.flip(files.readFile(created.id, "src/outside/secret.txt")),
					absolute: yield* Effect.flip(files.readFile(created.id, "/etc/hosts")),
					missing: yield* Effect.flip(files.readFile(created.id, "nope.txt")),
				};
			}),
		);
		expect(result.text).toEqual({ kind: "text", path: "src/index.ts", text: "export {};\n" });
		expect(result.binary).toEqual({ kind: "binary", path: "logo.png", size: 4 });
		expect(result.big).toEqual({ kind: "tooLarge", path: "big.txt", size: READ_FILE_BYTE_LIMIT + 1 });
		expect(result.traversal._tag).toBe("FileNotFoundError");
		expect(result.symlink).toEqual({ kind: "symlink", path: "link.txt", target: "/etc/hosts" });
		expect(result.throughLinkedFolder._tag).toBe("FileNotFoundError");
		expect(result.absolute._tag).toBe("FileNotFoundError");
		expect(result.missing._tag).toBe("FileNotFoundError");
	});
});
