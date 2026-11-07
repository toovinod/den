"use client";

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
import { useMemo, useState } from "react";
import { cn } from "@repo/ui/lib/utils";

export const ChatView = () => {
	const workspaceId = useAppState((current) => current.selectedWorkspaceId);
	const workspace = useAppState((current) => (workspaceId === null ? undefined : current.workspaces[workspaceId]));
	const project = useAppState((current) =>
		workspace === undefined ? undefined : current.projects[workspace.projectId],
	);
	const sessions = useAppState((current) => current.sessions);
	const closedTabs = useAppState((current) => current.closedTabs);
	const selectedSessionId = useAppState((current) => current.selectedSessionId);
	const chat = useAppState((current) => current.chat);
	const agents = useAppState((current) => current.agents);
	const panelOpen = useAppState((current) => current.panel.open);
	const tabs = useMemo(
		() => (workspaceId === null ? [] : workspaceTabs(sessions, closedTabs, workspaceId)),
		[sessions, closedTabs, workspaceId],
	);
	const session = selectedSessionId === null ? undefined : sessions[selectedSessionId];

	if (workspace === undefined || project === undefined) {
		return <Welcome />;
	}

	return (
		<section className="flex h-full min-w-0 flex-col bg-background">
			<header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Chats">
					{tabs.map((tab) => (
						<ChatTab key={tab.id} session={tab} selected={tab.id === selectedSessionId} />
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
			{session === undefined || chat === null || chat.sessionId !== session.id ? (
				<EmptyWorkspace name={workspace.kind === "inPlace" ? project.name : workspace.name} />
			) : (
				<>
					<ChatTimeline
						chat={chat}
						footer={
							chat.items.length === 0 ? (
								<p className="mx-auto max-w-3xl px-6 text-center text-muted-foreground">
									{session.agent === "claude" ? "Claude Code" : "Codex"} works in {workspace.path}
								</p>
							) : session.status === "running" ? (
								<p className="mx-auto max-w-3xl px-6 pb-3 text-xs text-muted-foreground">Working</p>
							) : null
						}
					/>
					<Composer
						key={session.id}
						session={session}
						agent={agents.find((agent) => agent.kind === session.agent)}
						chat={chat}
					/>
				</>
			)}
		</section>
	);
};

const ChatTab = ({ session, selected }: { readonly session: AgentSession; readonly selected: boolean }) => {
	const attention = useAppState((current) => current.attention[session.id]);
	const [editing, setEditing] = useState(false);
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
};

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
			<h1 className="text-base font-semibold">{hasProjects ? "Pick a workspace" : "Welcome to Swarm"}</h1>
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
