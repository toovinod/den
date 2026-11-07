import { DefaultBranchNotFoundError } from "@repo/contracts/Project";
import { Effect } from "effect";
import { runGit } from "../git/runGit.ts";

// A git command that fails or prints nothing means "not set" here, so the next source is tried.
const readGit = (cwd: string, args: ReadonlyArray<string>) =>
	runGit(cwd, args).pipe(
		Effect.catchTag("GitCommandError", () => Effect.succeed("")),
	);

export const detectDefaultBranch = Effect.fn("detectDefaultBranch")(
	function* (repositoryPath: string) {
		const originHead = yield* readGit(repositoryPath, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"refs/remotes/origin/HEAD",
		]);
		if (originHead !== "") {
			return originHead.replace(/^origin\//, "");
		}

		yield* Effect.logWarning(
			"origin/HEAD is not set, using init.defaultBranch as the default branch",
		);
		const configured = yield* readGit(repositoryPath, [
			"config",
			"--get",
			"init.defaultBranch",
		]);
		if (configured !== "") {
			return configured;
		}

		yield* Effect.logWarning(
			"init.defaultBranch is not set, using the checked-out branch as the default branch",
		);
		const current = yield* readGit(repositoryPath, [
			"branch",
			"--show-current",
		]);
		if (current !== "") {
			return current;
		}
		return yield* new DefaultBranchNotFoundError({ path: repositoryPath });
	},
	(effect, repositoryPath) =>
		effect.pipe(Effect.annotateLogs({ repositoryPath })),
);
