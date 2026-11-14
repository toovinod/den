"use client";

import { OctopusLogo } from "./OctopusLogo.tsx";
import {
	closeTab,
	newChat,
	openDialog,
	renameSession,
	selectSession,
	sessionTitle,
	setPanel,
	useAppState,
	workspaceTabs,
} from "../lib/store.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Input } from "@repo/ui/components/input";
import { Kbd } from "@repo/ui/components/kbd";
import { PanelRightIcon, PlusIcon, XIcon } from "lucide-react";
import type { AgentSession } from "@repo/contracts/AgentSession";
import { ChatTimeline } from "./ChatTimeline.tsx";
import { Hint } from "./Hint.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Button } from "@repo/ui/components/button";
import { Composer } from "./Composer.tsx";
import { memo, useMemo, useState } from "react";
import { cn } from "@repo/ui/lib/utils";

export const ChatView = () => {
	const workspaceId = useAppState((current) => current.selectedWorkspaceId);
	const workspace = useAppState((current) => (workspaceId === null ? undefined : current.workspaces[workspaceId]));
	const project = useAppState((current) =>
		workspace === undefined ? undefined : current.projects[workspace.projectId],
	);
	// The tab list as one string, so this view re-renders when tabs open, close or reorder, not when a session's
	// status changes or the open chat streams. Each tab reads its own session.
	const tabIds = useAppState((current) =>
		workspaceId === null
			? ""
			: workspaceTabs(current.sessions, current.closedTabs, workspaceId)
					.map((tab) => tab.id)
					.join(" "),
	);
	const selectedSessionId = useAppState((current) => current.selectedSessionId);
	const session = useAppState((current) =>
		selectedSessionId === null ? undefined : current.sessions[selectedSessionId],
	);
	const chatSessionId = useAppState((current) => current.chat?.sessionId ?? null);
	const panelOpen = useAppState((current) => current.panel.open);
	const tabs = useMemo(() => (tabIds === "" ? [] : tabIds.split(" ")), [tabIds]);

	if (workspace === undefined || project === undefined) {
		return <Welcome />;
	}

	return (
		<section className="flex h-full min-w-0 flex-col bg-background">
			<header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Chats">
					{tabs.map((tabId) => (
						<ChatTab key={tabId} sessionId={tabId} selected={tabId === selectedSessionId} />
					))}
					<NewChatMenu />
				</div>
				<span className="hidden truncate px-2 text-xs text-muted-foreground/60 lg:block">
					{project.name} / {workspace.branch}
				</span>
				<Hint label={panelOpen ? "Hide the side panel" : "Show the side panel"}>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Toggle the side panel"
						aria-pressed={panelOpen}
						onClick={() => setPanel({ open: !panelOpen })}
					>
						<PanelRightIcon />
					</Button>
				</Hint>
			</header>
			{session === undefined || chatSessionId !== session.id ? (
				<EmptyWorkspace name={workspace.kind === "inPlace" ? project.name : workspace.name} />
			) : (
				<OpenChat session={session} workspacePath={workspace.path} />
			)}
		</section>
	);
};

// The only part of the view that re-renders on every streamed frame.
const OpenChat = ({ session, workspacePath }: { readonly session: AgentSession; readonly workspacePath: string }) => {
	const chat = useAppState((current) => current.chat);
	const agent = useAppState((current) => current.agents.find((info) => info.kind === session.agent));
	if (chat === null) return null;
	return (
		<>
			<ChatTimeline
				chat={chat}
				footer={
					chat.items.length === 0 ? (
						<p className="mx-auto max-w-3xl px-6 text-center text-muted-foreground">
							{session.agent === "claude" ? "Claude Code" : "Codex"} works in {workspacePath}
						</p>
					) : session.status === "running" ? (
						<p className="mx-auto max-w-3xl px-6 pb-3 text-xs text-muted-foreground">Working</p>
					) : null
				}
			/>
			<Composer key={session.id} session={session} agent={agent} usage={chat.usage} rateLimit={chat.rateLimit} />
		</>
	);
};

const ChatTab = memo(({ sessionId, selected }: { readonly sessionId: string; readonly selected: boolean }) => {
	const session = useAppState((current) => current.sessions[sessionId]);
	const attention = useAppState((current) => current.attention[sessionId]);
	const [editing, setEditing] = useState(false);
	if (session === undefined) return null;
	return (
		<div
			className={cn(
				"group flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs",
				selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
			)}
		>
			<StatusDot status={session.status} attention={attention} />
			{editing ? (
				<Input
					autoFocus
					defaultValue={session.title ?? ""}
					placeholder={sessionTitle(session)}
					aria-label="Chat name"
					className="h-5 w-28 rounded-sm border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
					onBlur={(event) => {
						setEditing(false);
						if (event.target.value !== (session.title ?? "")) void renameSession(session.id, event.target.value);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") setEditing(false);
					}}
				/>
			) : (
				<button
					type="button"
					role="tab"
					aria-selected={selected}
					className="min-w-0 truncate"
					title="Double-click to rename"
					onClick={() => selectSession(session.id)}
					onDoubleClick={() => setEditing(true)}
				>
					{sessionTitle(session)}
				</button>
			)}
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label={`Close ${sessionTitle(session)}`}
				onClick={() => closeTab(session.id)}
				className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
			>
				<XIcon />
			</Button>
		</div>
	);
});

const NewChatMenu = () => {
	const agents = useAppState((current) => current.agents);
	return (
		<DropdownMenu>
			<Hint label="New chat (⌘T)">
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label="New chat">
						<PlusIcon />
					</Button>
				</DropdownMenuTrigger>
			</Hint>
			<DropdownMenuContent align="start">
				<DropdownMenuLabel className="text-xs text-muted-foreground">New chat with</DropdownMenuLabel>
				{agents.map((agent) => (
					<DropdownMenuItem key={agent.kind} onSelect={() => void newChat(undefined, agent.kind)}>
						<span className="flex-1">{agent.kind === "claude" ? "Claude Code" : "Codex"}</span>
						{agent.availability.status === "ready" ? null : <span className="text-xs text-attention">Set up</span>}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
};

const EmptyWorkspace = ({ name }: { readonly name: string }) => (
	<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
		<p className="text-muted-foreground">No chat is open in {name}.</p>
		<Button variant="default" onClick={() => void newChat()}>
			Start a chat
			<Kbd className="bg-primary-foreground/15 text-primary-foreground">⌘T</Kbd>
		</Button>
	</div>
);

const Welcome = () => {
	const hasProjects = useAppState((current) => Object.keys(current.projects).length > 0);
	return (
		<section className="flex h-full flex-col items-center justify-center gap-3 bg-background text-center">
			<OctopusLogo className="size-12" />
			<h1 className="text-base font-semibold">{hasProjects ? "Pick a workspace" : "Welcome to Octopus"}</h1>
			<p className="max-w-sm text-muted-foreground">
				{hasProjects
					? "Choose a workspace in the sidebar, or create one to give an agent its own branch."
					: "Add a project folder. Each workspace gets its own branch, and any number of agents can work in it."}
			</p>
			{hasProjects ? null : (
				<Button variant="default" onClick={() => openDialog({ kind: "newProject" })}>
					Add a project
				</Button>
			)}
		</section>
	);
};
