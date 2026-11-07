import { Effect, FileSystem } from "effect";
import { runGit } from "../git/runGit.ts";
import { join } from "node:path";

// A real git repository on `main` with one commit, isolated from the user's git identity.
export const makeTestRepository = Effect.fn("makeTestRepository")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(path, { recursive: true });
	yield* runGit(path, ["init", "--initial-branch=main"]);
	yield* runGit(path, ["config", "user.email", "test@swarm.local"]);
	yield* runGit(path, ["config", "user.name", "Swarm Test"]);
	yield* runGit(path, ["config", "commit.gpgsign", "false"]);
	yield* fs.writeFileString(join(path, "README.md"), "hello\n");
	yield* runGit(path, ["add", "."]);
	yield* runGit(path, ["commit", "-m", "init"]);
	return path;
});
