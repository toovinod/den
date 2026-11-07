import { WorktreeRemoveError } from "@repo/contracts/Workspace";
import { Effect } from "effect";
import { runGit } from "../git/runGit.ts";

// What archiving would lose if the folder went away now.
export const findUnsavedWork = Effect.fn("findUnsavedWork")(function* (
	worktreePath: string,
	baseBranch: string,
) {
	const status = yield* runGit(worktreePath, ["status", "--porcelain"]);
	// Each line is "XY path"; renames read "XY old -> new".
	const changedFiles =
		status === "" ? [] : status.split("\n").map((line) => line.slice(3));
	// Commits made in this workspace that no remote has. Base branch history is not this workspace's work.
	const unpushed = yield* runGit(worktreePath, [
		"rev-list",
		"--count",
		"HEAD",
		`^${baseBranch}`,
		"--not",
		"--remotes",
	]);
	return { changedFiles, unpushedCommits: Number(unpushed) };
});

// Removes the worktree folder and keeps its branch, so commits stay reachable.
// With `stashChanges`, uncommitted and untracked files are stashed first; stashes live in the
// shared repository, so they survive the folder.
export const removeWorktree = Effect.fn("removeWorktree")(function* (options: {
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly stashMessage: string | null;
}) {
	const { repositoryPath, worktreePath, stashMessage } = options;
	if (stashMessage !== null) {
		yield* runGit(worktreePath, [
			"stash",
			"push",
			"--include-untracked",
			"-m",
			stashMessage,
		]);
		yield* Effect.logInfo("Stashed uncommitted changes before archiving").pipe(
			Effect.annotateLogs({ worktreePath, stashMessage }),
		);
	}
	yield* runGit(repositoryPath, ["worktree", "remove", worktreePath]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("git worktree remove failed", cause).pipe(
				Effect.andThen(
					Effect.fail(new WorktreeRemoveError({ path: worktreePath })),
				),
			),
		),
	);
});
