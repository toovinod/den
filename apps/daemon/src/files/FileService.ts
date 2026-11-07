import { type FileContent, type FileEntry, FileNotFoundError } from "@repo/contracts/WorkspaceFile";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { Context, Effect, FileSystem, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { isAbsolute, join, relative } from "node:path";
import { runGit } from "../git/runGit.ts";

// Bigger files are not sent to the viewer, which renders them in full.
export const READ_FILE_BYTE_LIMIT = 1024 * 1024;

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

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

export class FileService extends Context.Service<FileService>()("swarm/daemon/files/FileService", {
	make: Effect.gen(function* () {
		const workspaces = yield* WorkspaceService;
		const fs = yield* FileSystem.FileSystem;
		const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

		// The real path must stay inside the workspace, so neither ../ nor a symlink can read other files.
		const resolveInside = Effect.fn("FileService.resolveInside")(function* (root: string, path: string) {
			const realRoot = yield* fs.realPath(root).pipe(Effect.orDie);
			const real = yield* fs
				.realPath(join(realRoot, path))
				.pipe(Effect.catchTag("PlatformError", () => Effect.fail(new FileNotFoundError({ path }))));
			const inside = relative(realRoot, real);
			if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
				return yield* new FileNotFoundError({ path });
			}
			return real;
		});

		const listDirectory = Effect.fn("FileService.listDirectory")(function* (workspaceId: string, path: string) {
			const { path: root } = yield* workspaces.get(workspaceId);
			const directory = path.replace(/^\/+|\/+$/g, "");
			const scope = directory === "" ? [] : ["--", `:(literal)${directory}/`];
			const output = yield* runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...scope]);
			return childrenOf(
				directory,
				output.split("\0").filter((file) => file !== ""),
			);
		}, Effect.provide(services));

		const readFile = Effect.fn("FileService.readFile")(function* (workspaceId: string, path: string) {
			const { path: root } = yield* workspaces.get(workspaceId);
			const real = yield* resolveInside(root, path);
			const info = yield* fs.stat(real).pipe(Effect.orDie);
			if (info.type !== "File") {
				return yield* new FileNotFoundError({ path });
			}
			const size = Number(info.size);
			if (size > READ_FILE_BYTE_LIMIT) {
				return { kind: "tooLarge", path, size } satisfies FileContent;
			}
			const bytes = yield* fs.readFile(real).pipe(Effect.orDie);
			if (isBinary(bytes)) {
				return { kind: "binary", path, size } satisfies FileContent;
			}
			return { kind: "text", path, text: new TextDecoder().decode(bytes) } satisfies FileContent;
		});

		return { listDirectory, readFile };
	}),
}) {
	static readonly layer = Layer.effect(FileService, FileService.make);
}
