import {
	BranchAlreadyExistsError,
	WorktreeCreateError,
} from "@repo/contracts/Workspace";
import { Effect } from "effect";
import { runGit } from "../git/runGit.ts";

export const createWorktree = Effect.fn("createWorktree")(function* (options: {
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly branch: string;
	readonly baseBranch: string;
}) {
	const { repositoryPath, worktreePath, branch, baseBranch } = options;
	// show-ref exits 1 when the branch does not exist, which is the case we want.
	const branchExists = yield* runGit(repositoryPath, [
		"show-ref",
		"--verify",
		"--quiet",
		`refs/heads/${branch}`,
	]).pipe(
		Effect.as(true),
		Effect.catchTag("GitCommandError", () => Effect.succeed(false)),
	);
	if (branchExists) {
		return yield* new BranchAlreadyExistsError({ branch });
	}
	yield* runGit(repositoryPath, [
		"worktree",
		"add",
		"-b",
		branch,
		worktreePath,
		baseBranch,
	]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("git worktree add failed", cause).pipe(
				Effect.andThen(Effect.fail(new WorktreeCreateError({ branch }))),
			),
		),
	);
});
