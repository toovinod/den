import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema, Stdio } from "effect";
import { sortImports } from "./sortImports.ts";
import { join } from "node:path";

// `bun run lint` checks the order and `bun run format` fixes it, like Biome does for the rest.

export class ImportOrderError extends Schema.TaggedError<ImportOrderError>()("ImportOrderError", {
	files: Schema.Array(Schema.String),
}) {
	override get message() {
		return `Imports must go from the longest to the shortest. Run \`bun run format\` to fix:\n${this.files.join("\n")}`;
	}
}

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..", "..");

// Biome's force-ignored paths ("!!path") are generated files, so they are skipped here too.
const BiomeConfig = Schema.fromJsonString(
	Schema.Struct({ files: Schema.Struct({ includes: Schema.Array(Schema.String) }) }),
);

const sourceFiles = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const biome = yield* Schema.decodeUnknownEffect(BiomeConfig)(
		yield* fs.readFileString(join(REPOSITORY_ROOT, "biome.json")),
	);
	const ignored = biome.files.includes.flatMap((pattern) => (pattern.startsWith("!!") ? [pattern.slice(2)] : []));
	const listed = yield* spawner.string(
		ChildProcess.make("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx"], {
			cwd: REPOSITORY_ROOT,
		}),
	);
	return listed
		.split("\n")
		.filter((file) => file !== "" && !ignored.some((path) => file === path || file.startsWith(`${path}/`)));
});

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const write = (yield* (yield* Stdio.Stdio).args).includes("--write");
	const unsorted: Array<string> = [];
	for (const file of yield* sourceFiles) {
		const path = join(REPOSITORY_ROOT, file);
		if (!(yield* fs.exists(path))) continue;
		const source = yield* fs.readFileString(path);
		const sorted = sortImports(source);
		if (sorted === source) continue;
		if (write) {
			yield* fs.writeFileString(path, sorted);
		} else {
			unsorted.push(file);
		}
	}
	if (unsorted.length > 0) {
		return yield* new ImportOrderError({ files: unsorted });
	}
}).pipe(Effect.provide(BunServices.layer));

if (import.meta.main) {
	BunRuntime.runMain(main);
}
