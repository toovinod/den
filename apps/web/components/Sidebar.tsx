"use client";

import {
	Sidebar as SidebarRoot,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupAction,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "@repo/ui/components/sidebar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@repo/ui/components/context-menu";
import {
	ChevronRightIcon,
	FolderPlusIcon,
	GitPullRequestIcon,
	MoreHorizontalIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	SquarePenIcon,
} from "lucide-react";
import {
	type AppState,
	newChat,
	openDialog,
	removeProject,
	selectSession,
	selectWorkspace,
	sessionTitle,
	useAppState,
} from "../lib/store.ts";
import type { AgentSession, AgentSessionStatus } from "@repo/contracts/AgentSession";
import type { Workspace } from "@repo/contracts/Workspace";
import type { Project } from "@repo/contracts/Project";
import { Kbd } from "@repo/ui/components/kbd";
import { StatusDot } from "./StatusDot.tsx";
import { cn } from "@repo/ui/lib/utils";
import { useMemo, useState } from "react";
import { Hint } from "./Hint.tsx";

const STATUS_RANK: Record<AgentSessionStatus, number> = {
	awaitingApproval: 4,
	failed: 3,
	running: 2,
	interrupted: 1,
	idle: 0,
};

// A workspace shows the most urgent status of its chats.
const workspaceStatus = (sessions: ReadonlyArray<AgentSession>) =>
	sessions.reduce<AgentSessionStatus | null>(
		(worst, session) => (worst === null || STATUS_RANK[session.status] > STATUS_RANK[worst] ? session.status : worst),
		null,
	);

const byCreated = <A extends { readonly createdAt: string }>(a: A, b: A) => a.createdAt.localeCompare(b.createdAt);

const useTree = (projects: AppState["projects"], workspaces: AppState["workspaces"], sessions: AppState["sessions"]) =>
	useMemo(() => {
		const sessionsByWorkspace = new Map<string, Array<AgentSession>>();
		for (const session of Object.values(sessions)) {
			const list = sessionsByWorkspace.get(session.workspaceId) ?? [];
			list.push(session);
			sessionsByWorkspace.set(session.workspaceId, list);
		}
		return Object.values(projects)
			.sort(byCreated)
			.map((project) => ({
				project,
				workspaces: Object.values(workspaces)
					.filter((workspace) => workspace.projectId === project.id && workspace.status === "active")
					.sort(byCreated)
					.map((workspace) => ({
						workspace,
						sessions: (sessionsByWorkspace.get(workspace.id) ?? []).sort(byCreated),
					})),
			}));
	}, [projects, workspaces, sessions]);

export const Sidebar = () => {
	const projects = useAppState((current) => current.projects);
	const workspaces = useAppState((current) => current.workspaces);
	const sessions = useAppState((current) => current.sessions);
	const tree = useTree(projects, workspaces, sessions);

	return (
		<SidebarRoot collapsible="none" className="w-full">
			<SidebarHeader className="pt-3">
				<SidebarMenu className="gap-0.5">
					<SidebarAction icon={<SquarePenIcon />} label="New chat" shortcut="⌘T" onClick={() => void newChat()} />
					<SidebarAction
						icon={<SearchIcon />}
						label="Search"
						shortcut="⌘K"
						onClick={() => openDialog({ kind: "palette" })}
					/>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Projects</SidebarGroupLabel>
					<Hint label="Add a project">
						<SidebarGroupAction aria-label="Add a project" onClick={() => openDialog({ kind: "newProject" })}>
							<FolderPlusIcon />
						</SidebarGroupAction>
					</Hint>
					<SidebarGroupContent>
						<SidebarMenu className="gap-0.5">
							{tree.length === 0 ? (
								<p className="px-2 py-1 text-xs text-muted-foreground">Add a project folder to start.</p>
							) : (
								tree.map((node) => <ProjectNode key={node.project.id} {...node} />)
							)}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter className="border-t border-sidebar-border">
				<SidebarMenu>
					<SidebarAction
						icon={<SettingsIcon />}
						label="Settings"
						shortcut="⌘,"
						onClick={() => openDialog({ kind: "settings", tab: "accounts" })}
					/>
				</SidebarMenu>
			</SidebarFooter>
		</SidebarRoot>
	);
};

const SidebarAction = ({
	icon,
	label,
	shortcut,
	onClick,
}: {
	readonly icon: React.ReactNode;
	readonly label: string;
	readonly shortcut: string;
	readonly onClick: () => void;
}) => (
	<SidebarMenuItem>
		<SidebarMenuButton size="sm" onClick={onClick} className="text-muted-foreground">
			{icon}
			<span className="flex-1">{label}</span>
			<Kbd className="bg-transparent opacity-0 group-hover/menu-item:opacity-100">{shortcut}</Kbd>
		</SidebarMenuButton>
	</SidebarMenuItem>
);

const ProjectMenuItems = ({
	project,
	Item,
	Separator,
}: {
	readonly project: Project;
	readonly Item: typeof DropdownMenuItem | typeof ContextMenuItem;
	readonly Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
}) => (
	<>
		<Item onSelect={() => openDialog({ kind: "newWorkspace", projectId: project.id })}>New workspace</Item>
		<Separator />
		<Item variant="destructive" onSelect={() => void removeProject(project.id)}>
			Remove from Den
		</Item>
	</>
);

const ProjectNode = ({
	project,
	workspaces,
}: {
	readonly project: Project;
	readonly workspaces: ReadonlyArray<{ readonly workspace: Workspace; readonly sessions: ReadonlyArray<AgentSession> }>;
}) => {
	const [open, setOpen] = useState(true);
	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<SidebarMenuButton
						size="sm"
						onClick={() => setOpen(!open)}
						aria-expanded={open}
						className="pr-14 font-medium"
					>
						<ChevronRightIcon className={cn("text-muted-foreground transition-transform", open && "rotate-90")} />
						<span>{project.name}</span>
					</SidebarMenuButton>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ProjectMenuItems project={project} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
				</ContextMenuContent>
			</ContextMenu>
			<Hint label="New workspace">
				<SidebarMenuAction
					showOnHover
					className="right-7"
					aria-label={`New workspace in ${project.name}`}
					onClick={() => openDialog({ kind: "newWorkspace", projectId: project.id })}
				>
					<PlusIcon />
				</SidebarMenuAction>
			</Hint>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<SidebarMenuAction showOnHover aria-label={`${project.name} options`}>
						<MoreHorizontalIcon />
					</SidebarMenuAction>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<ProjectMenuItems project={project} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
				</DropdownMenuContent>
			</DropdownMenu>
			{open ? (
				<SidebarMenuSub className="mr-0 gap-0.5 pr-0">
					{workspaces.length === 0 ? (
						<SidebarMenuSubItem>
							<SidebarMenuSubButton asChild size="sm" className="w-full text-muted-foreground">
								<button type="button" onClick={() => openDialog({ kind: "newWorkspace", projectId: project.id })}>
									Create a workspace
								</button>
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					) : (
						workspaces.map((node) => <WorkspaceNode key={node.workspace.id} {...node} />)
					)}
				</SidebarMenuSub>
			) : null}
		</SidebarMenuItem>
	);
};

const WorkspaceNode = ({
	workspace,
	sessions,
}: {
	readonly workspace: Workspace;
	readonly sessions: ReadonlyArray<AgentSession>;
}) => {
	const selected = useAppState((current) => current.selectedWorkspaceId === workspace.id);
	const attention = useAppState((current) => current.attention);
	const anyAttention = sessions.find((session) => attention[session.id] !== undefined);
	const openSettings = () => openDialog({ kind: "workspaceSettings", workspaceId: workspace.id });
	return (
		<SidebarMenuSubItem>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<SidebarMenuSubButton
						asChild
						size="sm"
						isActive={selected}
						className={cn("w-full pr-7", !selected && "text-muted-foreground")}
					>
						<button type="button" onClick={() => selectWorkspace(workspace.id)}>
							<StatusDot
								status={workspaceStatus(sessions)}
								attention={anyAttention === undefined ? undefined : attention[anyAttention.id]}
							/>
							{workspace.pullRequestUrl === null ? null : <GitPullRequestIcon className="text-muted-foreground" />}
							<span>{workspace.kind === "inPlace" ? "Project folder" : workspace.name}</span>
						</button>
					</SidebarMenuSubButton>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onSelect={() => void newChat(workspace.id)}>New chat</ContextMenuItem>
					<ContextMenuItem onSelect={openSettings}>Workspace settings</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<Hint label="Workspace settings">
				<SidebarMenuAction showOnHover className="top-0.5" aria-label="Workspace settings" onClick={openSettings}>
					<MoreHorizontalIcon />
				</SidebarMenuAction>
			</Hint>
			{selected && sessions.length > 0 ? (
				<SidebarMenuSub className="mr-0 gap-0.5 pr-0">
					{sessions.map((session) => (
						<ChatNode key={session.id} session={session} attention={attention[session.id]} />
					))}
				</SidebarMenuSub>
			) : null}
		</SidebarMenuSubItem>
	);
};

const ChatNode = ({
	session,
	attention,
}: {
	readonly session: AgentSession;
	readonly attention: AppState["attention"][string] | undefined;
}) => {
	const selected = useAppState((current) => current.selectedSessionId === session.id);
	return (
		<SidebarMenuSubItem>
			<SidebarMenuSubButton
				asChild
				size="sm"
				className={cn("w-full justify-between text-left", selected ? "text-foreground" : "text-muted-foreground")}
			>
				<button type="button" onClick={() => selectSession(session.id)}>
					<span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
					<StatusDot status={session.status} attention={attention} />
				</button>
			</SidebarMenuSubButton>
		</SidebarMenuSubItem>
	);
};
