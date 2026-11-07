"use client";

import {
	CheckIcon,
	ChevronDownIcon,
	CircleDotIcon,
	ExternalLinkIcon,
	GitMergeIcon,
	LoaderIcon,
	MessageSquareIcon,
	RefreshCwIcon,
	SendIcon,
	XIcon,
} from "lucide-react";
import type {
	PullRequest,
	PullRequestConversation,
	PullRequestMergeMethod,
	PullRequestReviewInput,
} from "@repo/contracts/Git";
import { newChat, sendMessage, toast, updateWorkspace, useAppState } from "../lib/store.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Badge } from "@repo/ui/components/badge";
import { Label } from "@repo/ui/components/label";
import { callDaemon, errorMessage } from "../lib/daemonRuntime.ts";
import { useDaemonValue } from "../lib/useDaemonValue.ts";
import type { Workspace } from "@repo/contracts/Workspace";
import { formatDateTime } from "../lib/format.ts";
import { Textarea } from "@repo/ui/components/textarea";
import { Hint } from "./Hint.tsx";
import { Switch } from "@repo/ui/components/switch";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { feedbackMessage } from "../lib/feedbackMessage.ts";
import { ExternalLink } from "./ExternalLink.tsx";
import { useState } from "react";

const MERGE_METHODS = ["squash", "merge", "rebase"] as const;

const MERGE_LABELS: Record<PullRequestMergeMethod, string> = {
	squash: "Squash and merge",
	merge: "Create a merge commit",
	rebase: "Rebase and merge",
};

export const PullRequestPanel = ({ workspace }: { readonly workspace: Workspace }) => {
	const { loaded, reload } = useDaemonValue(
		() => callDaemon((daemon) => daemon.getPullRequest({ workspaceId: workspace.id })),
		workspace.id,
	);
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
				<span className="flex-1 truncate text-muted-foreground">
					{workspace.branch} into {workspace.baseBranch}
				</span>
				<Hint label="Reload">
					<Button variant="ghost" size="icon-xs" aria-label="Reload the pull request" onClick={reload}>
						<RefreshCwIcon />
					</Button>
				</Hint>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loaded.state === "loading" ? (
					<p className="p-4 text-xs text-muted-foreground">Asking GitHub</p>
				) : loaded.state === "failed" ? (
					<p className="p-4 text-xs text-destructive">{loaded.message}</p>
				) : loaded.value.status === "none" ? (
					<CreatePullRequest workspace={workspace} onCreated={reload} />
				) : (
					<PullRequestDetails workspace={workspace} pullRequest={loaded.value.pullRequest} onChanged={reload} />
				)}
			</div>
		</div>
	);
};

const CreatePullRequest = ({
	workspace,
	onCreated,
}: {
	readonly workspace: Workspace;
	readonly onCreated: () => void;
}) => {
	const [title, setTitle] = useState(workspace.name);
	const [body, setBody] = useState("");
	const [draft, setDraft] = useState(false);
	const [busy, setBusy] = useState(false);
	const create = async () => {
		setBusy(true);
		await callDaemon((daemon) => daemon.createPullRequest({ workspaceId: workspace.id, title, body, draft })).then(
			(updated) => {
				updateWorkspace(updated);
				onCreated();
			},
			(error: unknown) => toast(errorMessage(error)),
		);
		setBusy(false);
	};
	return (
		<form
			className="flex flex-col gap-2 p-3"
			onSubmit={(event) => {
				event.preventDefault();
				void create();
			}}
		>
			<p className="text-xs text-muted-foreground">
				Den pushes {workspace.branch} and opens a pull request with the GitHub CLI.
			</p>
			<Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" placeholder="Title" />
			<Textarea
				value={body}
				onChange={(event) => setBody(event.target.value)}
				aria-label="Description"
				placeholder="What changed and why"
				rows={6}
				className="font-sans text-sm"
			/>
			<div className="flex items-center gap-2">
				<Switch id="pr-draft" checked={draft} onCheckedChange={setDraft} />
				<Label htmlFor="pr-draft" className="flex-1 text-xs font-normal text-muted-foreground">
					Open as a draft
				</Label>
				<Button type="submit" variant="default" size="sm" disabled={busy || title.trim() === ""}>
					{busy ? <LoaderIcon className="animate-spin" /> : null}
					Open pull request
				</Button>
			</div>
		</form>
	);
};

const StateBadge = ({ pullRequest }: { readonly pullRequest: PullRequest }) => {
	const tone =
		pullRequest.state === "MERGED"
			? "bg-running/15 text-running"
			: pullRequest.state === "CLOSED"
				? "bg-destructive/15 text-destructive"
				: pullRequest.isDraft
					? "bg-muted text-muted-foreground"
					: "bg-success/15 text-success";
	const text =
		pullRequest.state === "MERGED"
			? "Merged"
			: pullRequest.state === "CLOSED"
				? "Closed"
				: pullRequest.isDraft
					? "Draft"
					: "Open";
	return <Badge className={tone}>{text}</Badge>;
};

const REVIEW_DECISIONS: Record<string, string> = {
	APPROVED: "Approved",
	CHANGES_REQUESTED: "Changes requested",
	REVIEW_REQUIRED: "Review required",
};

const PullRequestDetails = ({
	workspace,
	pullRequest,
	onChanged,
}: {
	readonly workspace: Workspace;
	readonly pullRequest: PullRequest;
	readonly onChanged: () => void;
}) => {
	const { loaded, reload } = useDaemonValue(
		() => callDaemon((daemon) => daemon.getPullRequestConversation({ workspaceId: workspace.id })),
		`${workspace.id}:${pullRequest.number}`,
	);
	const { checks } = pullRequest;
	return (
		<div className="flex flex-col">
			<div className="flex flex-col gap-1.5 border-b p-3">
				<div className="flex items-center gap-2">
					<StateBadge pullRequest={pullRequest} />
					<span className="text-xs text-muted-foreground">#{pullRequest.number}</span>
					{pullRequest.reviewDecision === null ? null : (
						<span className="text-xs text-muted-foreground">
							{REVIEW_DECISIONS[pullRequest.reviewDecision] ?? pullRequest.reviewDecision}
						</span>
					)}
					<div className="flex-1" />
					<Button asChild variant="ghost" size="xs" className="text-muted-foreground">
						<ExternalLink href={pullRequest.url}>
							GitHub
							<ExternalLinkIcon />
						</ExternalLink>
					</Button>
				</div>
				<p className="font-medium">{pullRequest.title}</p>
				<p className="text-xs text-muted-foreground">
					{checks.passing + checks.failing + checks.pending === 0
						? "No checks"
						: [
								checks.failing > 0 ? `${checks.failing} failing` : null,
								checks.pending > 0 ? `${checks.pending} pending` : null,
								checks.passing > 0 ? `${checks.passing} passing` : null,
							]
								.filter((part) => part !== null)
								.join(", ")}
				</p>
			</div>
			{loaded.state === "failed" ? <p className="p-3 text-xs text-destructive">{loaded.message}</p> : null}
			{loaded.state === "ready" ? (
				<>
					<Checks conversation={loaded.value} />
					<Conversation workspace={workspace} conversation={loaded.value} />
				</>
			) : null}
			{pullRequest.state === "OPEN" ? (
				<>
					<ReviewForm
						workspace={workspace}
						onReviewed={() => {
							reload();
							onChanged();
						}}
					/>
					<MergeForm workspace={workspace} onMerged={onChanged} />
				</>
			) : null}
		</div>
	);
};

const Section = ({ title, children }: { readonly title: string; readonly children: React.ReactNode }) => (
	<section className="flex flex-col gap-2 border-b p-3">
		<h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
		{children}
	</section>
);

const Checks = ({ conversation }: { readonly conversation: PullRequestConversation }) =>
	conversation.checks.length === 0 ? null : (
		<Section title="Checks">
			<ul className="flex flex-col gap-1">
				{conversation.checks.map((check) => (
					<li key={`${check.name}:${check.url ?? ""}`} className="flex items-center gap-2 text-xs">
						{check.state === "passing" ? (
							<CheckIcon className="size-3.5 text-success" />
						) : check.state === "failing" ? (
							<XIcon className="size-3.5 text-destructive" />
						) : (
							<CircleDotIcon className="size-3.5 text-attention" />
						)}
						{check.url === null ? (
							<span className="truncate">{check.name}</span>
						) : (
							<ExternalLink href={check.url} className="truncate hover:underline">
								{check.name}
							</ExternalLink>
						)}
					</li>
				))}
			</ul>
		</Section>
	);

const Conversation = ({
	workspace,
	conversation,
}: {
	readonly workspace: Workspace;
	readonly conversation: PullRequestConversation;
}) => {
	const sessionId = useAppState((current) =>
		current.selectedSessionId !== null && current.sessions[current.selectedSessionId]?.workspaceId === workspace.id
			? current.selectedSessionId
			: null,
	);
	const entries = [
		...conversation.reviews
			.filter((review) => review.body.trim() !== "" || review.state !== "COMMENTED")
			.map((review) => ({
				id: review.id,
				author: review.author,
				at: review.submittedAt ?? "",
				body: review.body,
				label: REVIEW_DECISIONS[review.state] ?? (review.state === "COMMENTED" ? "Reviewed" : review.state),
				location: null,
			})),
		...conversation.comments.map((comment) => ({ ...comment, at: comment.createdAt, label: null, location: null })),
		...conversation.reviewComments.map((comment) => ({
			...comment,
			at: comment.createdAt,
			label: null,
			location: `${comment.path}${comment.line === null ? "" : `:${comment.line}`}`,
		})),
	].sort((a, b) => a.at.localeCompare(b.at));
	const hasFeedback =
		conversation.reviewComments.length > 0 || conversation.reviews.some((review) => review.body !== "");

	const sendToAgent = async () => {
		const message = feedbackMessage(conversation);
		// With no chat open here, start one so the click still delivers the feedback. newChat explains a failure.
		const target = sessionId ?? (await newChat(workspace.id));
		if (target === null) return;
		await sendMessage(target, message, [], false).then(
			() => toast("Sent the review feedback to the agent.", "info"),
			(error: unknown) => toast(errorMessage(error)),
		);
	};

	return (
		<Section title="Conversation">
			{entries.length === 0 ? (
				<p className="text-xs text-muted-foreground">No comments yet.</p>
			) : (
				<ul className="flex flex-col gap-3">
					{entries.map((entry) => (
						<li key={entry.id} className="flex flex-col gap-0.5">
							<div className="flex items-center gap-1.5 text-xs">
								<span className="font-medium">{entry.author}</span>
								{entry.label === null ? null : <span className="text-muted-foreground">{entry.label}</span>}
								{entry.location === null ? null : (
									<span className="truncate font-mono text-muted-foreground">{entry.location}</span>
								)}
								<span className="ml-auto shrink-0 text-muted-foreground/60">
									{entry.at === "" ? "" : formatDateTime(entry.at)}
								</span>
							</div>
							{entry.body === "" ? null : <p className="whitespace-pre-wrap text-xs">{entry.body}</p>}
						</li>
					))}
				</ul>
			)}
			{hasFeedback ? (
				<Button variant="secondary" size="sm" className="self-start" onClick={() => void sendToAgent()}>
					<SendIcon />
					Send feedback to the agent
				</Button>
			) : null}
		</Section>
	);
};

const ReviewForm = ({ workspace, onReviewed }: { readonly workspace: Workspace; readonly onReviewed: () => void }) => {
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (review: PullRequestReviewInput) => {
		setBusy(true);
		await callDaemon((daemon) => daemon.reviewPullRequest({ workspaceId: workspace.id, review })).then(
			() => {
				setBody("");
				onReviewed();
			},
			(error: unknown) => toast(errorMessage(error)),
		);
		setBusy(false);
	};
	const hasBody = body.trim() !== "";
	return (
		<Section title="Review">
			<Textarea
				value={body}
				onChange={(event) => setBody(event.target.value)}
				placeholder="Leave a review comment"
				aria-label="Review comment"
				rows={3}
				className="font-sans text-sm"
			/>
			<div className="flex flex-wrap gap-1.5">
				<Button
					variant="secondary"
					size="sm"
					disabled={busy || !hasBody}
					onClick={() => void submit({ verdict: "comment", body })}
				>
					<MessageSquareIcon />
					Comment
				</Button>
				<Button
					variant="secondary"
					size="sm"
					disabled={busy || !hasBody}
					onClick={() => void submit({ verdict: "requestChanges", body })}
				>
					Request changes
				</Button>
				<Button size="sm" variant="default" disabled={busy} onClick={() => void submit({ verdict: "approve", body })}>
					<CheckIcon />
					Approve
				</Button>
			</div>
		</Section>
	);
};

const MergeForm = ({ workspace, onMerged }: { readonly workspace: Workspace; readonly onMerged: () => void }) => {
	const [method, setMethod] = useState<PullRequestMergeMethod>("squash");
	const [deleteBranch, setDeleteBranch] = useState(true);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const merge = async () => {
		setBusy(true);
		await callDaemon((daemon) => daemon.mergePullRequest({ workspaceId: workspace.id, method, deleteBranch })).then(
			() => {
				toast("Merged the pull request.", "info");
				onMerged();
			},
			(error: unknown) => toast(errorMessage(error)),
		);
		setBusy(false);
		setConfirming(false);
	};
	return (
		<Section title="Merge">
			<div className="flex items-center gap-2">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="secondary" size="sm">
							{MERGE_LABELS[method]}
							<ChevronDownIcon />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuRadioGroup
							value={method}
							onValueChange={(value) => {
								const option = MERGE_METHODS.find((item) => item === value);
								if (option !== undefined) setMethod(option);
							}}
						>
							{MERGE_METHODS.map((option) => (
								<DropdownMenuRadioItem key={option} value={option}>
									{MERGE_LABELS[option]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				<Switch id="delete-branch" checked={deleteBranch} onCheckedChange={setDeleteBranch} />
				<Label htmlFor="delete-branch" className="text-xs font-normal text-muted-foreground">
					Delete the branch on GitHub
				</Label>
			</div>
			{confirming ? (
				<div className="flex items-center gap-2">
					<span className="flex-1 text-xs">Merge into {workspace.baseBranch}?</span>
					<Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
						Cancel
					</Button>
					<Button size="sm" variant="default" disabled={busy} onClick={() => void merge()}>
						{busy ? <LoaderIcon className="animate-spin" /> : <GitMergeIcon />}
						Merge
					</Button>
				</div>
			) : (
				<Button size="sm" variant="default" className="self-start" onClick={() => setConfirming(true)}>
					<GitMergeIcon />
					Merge
				</Button>
			)}
		</Section>
	);
};
