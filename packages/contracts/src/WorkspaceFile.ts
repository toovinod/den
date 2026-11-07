import { Schema } from "effect";

export const FileEntry = Schema.Struct({
	name: Schema.String,
	// Relative to the workspace folder, with forward slashes.
	path: Schema.String,
	kind: Schema.Literals(["file", "directory"]),
});
export type FileEntry = typeof FileEntry.Type;

export const FileContent = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("text"), path: Schema.String, text: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("binary"), path: Schema.String, size: Schema.Int }),
	Schema.Struct({ kind: Schema.Literal("tooLarge"), path: Schema.String, size: Schema.Int }),
]);
export type FileContent = typeof FileContent.Type;

export class FileNotFoundError extends Schema.TaggedError<FileNotFoundError>()("FileNotFoundError", {
	path: Schema.String,
}) {
	override get message() {
		return `${this.path} is not in this workspace. Refresh the file list.`;
	}
}
