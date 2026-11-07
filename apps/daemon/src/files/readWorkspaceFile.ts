import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FileNotFoundError, FileReadError } from "@repo/contracts/WorkspaceFile";
import { Effect, FileSystem } from "effect";

export type WorkspaceFileRead =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "symlink"; readonly target: string }
	| { readonly kind: "binary"; readonly size: number }
	| { readonly kind: "tooLarge"; readonly size: number };

const isInside = (root: string, path: string) => {
	const rest = relative(root, path);
	return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
};

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

// Reads a file of a workspace without ever leaving it: `..` and absolute paths are refused, the folders on the
// way must resolve inside the workspace, and a symlink is reported with its target instead of being followed.
export const readWorkspaceFile = Effect.fn("readWorkspaceFile")(function* (
	root: string,
	path: string,
	byteLimit: number,
) {
	const fs = yield* FileSystem.FileSystem;
	const notFound = new FileNotFoundError({ path });
	const readError = (cause: unknown) =>
		Effect.logWarning("Could not read a workspace file", cause).pipe(
			Effect.annotateLogs({ root, path }),
			Effect.andThen(Effect.fail(new FileReadError({ path }))),
		);
	const realRoot = yield* fs.realPath(root).pipe(Effect.catchTag("PlatformError", readError));
	const requested = resolve(realRoot, path);
	if (!isInside(realRoot, requested)) {
		return yield* notFound;
	}
	const realFolder = yield* fs
		.realPath(dirname(requested))
		.pipe(Effect.catchTag("PlatformError", () => Effect.fail(notFound)));
	if (realFolder !== realRoot && !isInside(realRoot, realFolder)) {
		return yield* notFound;
	}
	const file = join(realFolder, basename(requested));
	const info = yield* fs
		.lstat(file)
		.pipe(
			Effect.catchTag(
				"PlatformError",
				(error): Effect.Effect<never, FileNotFoundError | FileReadError> =>
					error.reason._tag === "NotFound" ? Effect.fail(notFound) : readError(error),
			),
		);
	if (info.type === "SymbolicLink") {
		const target = yield* fs.readLink(file).pipe(Effect.catchTag("PlatformError", readError));
		return { kind: "symlink", target } satisfies WorkspaceFileRead;
	}
	if (info.type !== "File") {
		return yield* notFound;
	}
	const size = Number(info.size);
	if (size > byteLimit) {
		return { kind: "tooLarge", size } satisfies WorkspaceFileRead;
	}
	const bytes = yield* fs.readFile(file).pipe(Effect.catchTag("PlatformError", readError));
	if (isBinary(bytes)) {
		return { kind: "binary", size } satisfies WorkspaceFileRead;
	}
	return { kind: "text", text: new TextDecoder().decode(bytes) } satisfies WorkspaceFileRead;
});
