import type { FileContent, FileEntry } from "@repo/contracts/WorkspaceFile";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { Context, Effect, type FileSystem, Layer } from "effect";
import { readWorkspaceFile } from "./readWorkspaceFile.ts";
import type { ChildProcessSpawner } from "effect/process";
import { leavesRoot } from "./leavesRoot.ts";
import { runGit } from "../git/runGit.ts";
import { normalize } from "node:path";

// Bigger files are not sent to the viewer, which renders them in full.
export const READ_FILE_BYTE_LIMIT = 1024 * 1024;

// Children of `directory` from git's list of files, which already leaves out ignored ones.
const childrenOf = (directory: string, files: ReadonlyArray<string>): ReadonlyArray<FileEntry> => {
	const prefix = directory === "" ? "" : `${directory}/`;
	const entries = new Map<string, FileEntry>();
	for (const file of files) {
		const rest = file.slice(prefix.length);
		const [name = "", ...deeper] = rest.split("/");
		if (name === "" || entries.has(name)) {
			continue;
		}
		entries.set(name, { name, path: `${prefix}${name}`, kind: deeper.length > 0 ? "directory" : "file" });
	}
	return [...entries.values()].sort((a, b) =>
		a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
	);
};

export class FileService extends Context.Service<FileService>()("octopus/daemon/files/FileService", {
	make: Effect.gen(function* () {
		const workspaces = yield* WorkspaceService;
		const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem>();

		const listDirectory = Effect.fn("FileService.listDirectory")(function* (workspaceId: string, path: string) {
			const { path: root } = yield* workspaces.get(workspaceId);
			const directory = path.replace(/^\/+|\/+$/g, "");
			if (leavesRoot(normalize(directory))) {
				return [];
			}
			const scope = directory === "" ? [] : ["--", `:(literal)${directory}/`];
			const output = yield* runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...scope]);
			return childrenOf(
				directory,
				output.split("\0").filter((file) => file !== ""),
			);
		}, Effect.provide(services));

		const readFile = Effect.fn("FileService.readFile")(function* (workspaceId: string, path: string) {
			const { path: root } = yield* workspaces.get(workspaceId);
			const read = yield* readWorkspaceFile(root, path, READ_FILE_BYTE_LIMIT);
			return { ...read, path } satisfies FileContent;
		}, Effect.provide(services));

		return { listDirectory, readFile };
	}),
}) {
	static readonly layer = Layer.effect(FileService, FileService.make);
}
