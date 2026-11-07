"use client";

import {
	CheckIcon,
	ChevronRightIcon,
	FileDiffIcon,
	LoaderIcon,
	PlugIcon,
	TerminalIcon,
	TriangleAlertIcon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import type { ApprovalDecision, ApprovalOutcome, ToolCall } from "@repo/contracts/AgentEvent";
import { respondToApproval } from "../lib/store.ts";
import type { ChatItem } from "../lib/chatReducer.ts";
import { callDaemon } from "../lib/daemonRuntime.ts";
import { memo, useEffect, useState } from "react";
import { Button } from "@repo/ui/components/button";
import Markdown from "react-markdown";
import { cn } from "@repo/ui/lib/utils";

const DECISION_LABELS: Record<ApprovalDecision, string> = {
	allowOnce: "Allow",
	allowForSession: "Allow for this chat",
	deny: "Deny",
};

const OUTCOME_LABELS: Record<ApprovalOutcome, string> = {
	allowOnce: "Allowed",
	allowForSession: "Allowed for this chat",
	deny: "Denied",
	cancelled: "Cancelled",
};

// One entry of the chat timeline. Memoized: during streaming only the growing message re-renders.
export const ChatItemView = memo(({ item, sessionId }: { readonly item: ChatItem; readonly sessionId: string }) => {
	switch (item.kind) {
		case "user":
			return (
				<div className="flex flex-col items-end gap-1.5">
					{item.attachments.length === 0 ? null : (
						<div className="flex flex-wrap justify-end gap-1.5">
							{item.attachments.map((attachment) => (
								<Attachment key={attachment.id} sessionId={sessionId} attachmentId={attachment.id} />
							))}
						</div>
					)}
					{item.text === "" ? null : (
						<div className="max-w-[85%] rounded-xl bg-muted px-3 py-2 whitespace-pre-wrap">{item.text}</div>
					)}
				</div>
			);
		case "assistant":
			return (
				<div className="prose prose-sm max-w-none text-foreground dark:prose-invert prose-p:my-2 prose-headings:my-2 prose-headings:text-sm prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-a:text-running prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:my-2 prose-pre:border prose-pre:bg-sidebar prose-pre:text-foreground [&_pre_code]:bg-transparent [&_pre_code]:p-0 [overflow-wrap:anywhere]">
					<Markdown>{item.text}</Markdown>
				</div>
			);
		case "tool":
			return <ToolCard item={item} />;
		case "approval":
			return <ApprovalCard item={item} sessionId={sessionId} />;
		case "notice":
			return (
				<div
					className={cn(
						"flex items-center gap-2 text-xs",
						item.tone === "error" ? "text-destructive" : "text-attention",
					)}
				>
					<TriangleAlertIcon className="size-3.5 shrink-0" />
					<span>{item.text}</span>
				</div>
			);
	}
});

const Attachment = ({ sessionId, attachmentId }: { readonly sessionId: string; readonly attachmentId: string }) => {
	const [src, setSrc] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		callDaemon((daemon) => daemon.getAttachment({ sessionId, attachmentId })).then(
			(image) => live && setSrc(`data:${image.mediaType};base64,${image.base64}`),
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [sessionId, attachmentId]);
	return src === null ? (
		<div className="size-16 rounded-lg bg-muted" />
	) : (
		<img src={src} alt="" className="size-16 rounded-lg object-cover" />
	);
};

const toolTitle = (tool: ToolCall) => {
	switch (tool.kind) {
		case "command":
			return tool.command;
		case "fileChange":
			return tool.changes.map((change) => change.path).join(", ");
		case "mcpCall":
			return `${tool.server}.${tool.tool}`;
		case "other":
			return tool.name;
	}
};

const TOOL_ICONS = {
	command: TerminalIcon,
	fileChange: FileDiffIcon,
	mcpCall: PlugIcon,
	other: WrenchIcon,
} as const;

const ToolCard = ({ item }: { readonly item: Extract<ChatItem, { kind: "tool" }> }) => {
	const [open, setOpen] = useState(item.status === "failed");
	const Icon = TOOL_ICONS[item.tool.kind];
	const detail =
		item.tool.kind === "fileChange" ? item.tool.changes.map((change) => change.diff).join("\n") : item.output;
	return (
		<div className="rounded-lg border border-border bg-card">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				disabled={detail === null || detail === ""}
				className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
				aria-expanded={open}
			>
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate font-mono">{toolTitle(item.tool)}</span>
				{item.status === "running" ? (
					<LoaderIcon className="size-3.5 shrink-0 animate-spin text-running" />
				) : item.status === "completed" ? (
					<CheckIcon className="size-3.5 shrink-0 text-success" />
				) : (
					<span className="flex shrink-0 items-center gap-1 text-destructive">
						<XIcon className="size-3.5" />
						{item.status === "declined" ? "Declined" : "Failed"}
					</span>
				)}
				{detail === null || detail === "" ? null : (
					<ChevronRightIcon
						className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")}
					/>
				)}
			</button>
			{open && detail !== null ? (
				<pre className="max-h-64 overflow-auto border-t border-border px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
					{detail}
				</pre>
			) : null}
		</div>
	);
};

const ApprovalCard = ({
	item,
	sessionId,
}: {
	readonly item: Extract<ChatItem, { kind: "approval" }>;
	readonly sessionId: string;
}) => {
	const [sending, setSending] = useState<ApprovalDecision | null>(null);
	const answer = async (decision: ApprovalDecision) => {
		setSending(decision);
		await respondToApproval(sessionId, item.requestId, decision);
		setSending(null);
	};
	return (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-lg border px-3 py-2.5",
				item.outcome === null ? "border-attention/50 bg-attention/5" : "border-border bg-card",
			)}
		>
			<div className="flex items-center gap-2 text-xs">
				<span className={item.outcome === null ? "font-medium text-attention" : "text-muted-foreground"}>
					{item.outcome === null ? "Approval needed" : OUTCOME_LABELS[item.outcome]}
				</span>
			</div>
			<code className="font-mono text-xs break-all">{item.summary}</code>
			{item.reason === null ? null : <p className="text-xs text-muted-foreground">{item.reason}</p>}
			{item.outcome === null ? (
				<div className="flex flex-wrap gap-1.5">
					{item.choices.map((decision) => (
						<Button
							key={decision}
							size="sm"
							variant={decision === "deny" ? "ghost" : decision === "allowOnce" ? "default" : "secondary"}
							disabled={sending !== null}
							onClick={() => void answer(decision)}
						>
							{DECISION_LABELS[decision]}
						</Button>
					))}
				</div>
			) : null}
		</div>
	);
};
