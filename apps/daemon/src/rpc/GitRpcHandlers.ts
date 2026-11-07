import { orInternalError } from "./orInternalError.ts";
import { GitRpcs } from "@repo/contracts/GitRpcs";
import { GitService } from "../git/GitService.ts";
import { Effect } from "effect";

export const GitRpcHandlers = GitRpcs.toLayer(
	Effect.gen(function* () {
		const git = yield* GitService;
		return GitRpcs.of({
			getWorkspaceDiff: ({ workspaceId }) => git.getWorkspaceDiff(workspaceId).pipe(orInternalError("read the diff")),
			getFileDiff: ({ workspaceId, path }) =>
				git.getFileDiff(workspaceId, path).pipe(orInternalError("read the diff of the file")),
			getGitStatus: ({ workspaceId }) => git.getStatus(workspaceId).pipe(orInternalError("read the git status")),
			commit: ({ workspaceId, message, paths }) =>
				git.commit(workspaceId, message, paths).pipe(orInternalError("commit the changes")),
			push: ({ workspaceId }) => git.push(workspaceId).pipe(orInternalError("push the branch")),
			createPullRequest: ({ workspaceId, title, body, draft }) =>
				git.createPullRequest(workspaceId, { title, body, draft }).pipe(orInternalError("open the pull request")),
			getPullRequest: ({ workspaceId }) =>
				git.getPullRequest(workspaceId).pipe(orInternalError("read the pull request")),
			getPullRequestConversation: ({ workspaceId }) =>
				git.getPullRequestConversation(workspaceId).pipe(orInternalError("read the pull request conversation")),
			reviewPullRequest: ({ workspaceId, review }) =>
				git.reviewPullRequest(workspaceId, review).pipe(orInternalError("review the pull request")),
			mergePullRequest: ({ workspaceId, method, deleteBranch }) =>
				git.mergePullRequest(workspaceId, method, deleteBranch).pipe(orInternalError("merge the pull request")),
		});
	}),
);
