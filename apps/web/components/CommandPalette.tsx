"use client";

import {
	newChat,
	openDialog,
	selectSession,
	selectWorkspace,
	sessionTitle,
	setPanel,
	useAppState,
} from "../lib/store.ts";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/components/command";
import { useTheme } from "next-themes";
import { useMemo } from "react";

interface PaletteCommand {
	readonly id: string;
	readonly group: string;
	readonly label: string;
	readonly detail?: string;
	readonly run: () => void;
}

const useCommands = (): ReadonlyArray<PaletteCommand> => {
	const projects = useAppState((current) => current.projects);
	const workspaces = useAppState((current) => current.workspaces);
	const sessions = useAppState((current) => current.sessions);
	const agents = useAppState((current) => current.agents);
	const panelOpen = useAppState((current) => current.panel.open);
	const { resolvedTheme, setTheme } = useTheme();
	const dark = resolvedTheme !== "light";
	return useMemo(() => {
		const active = Object.values(workspaces).filter((workspace) => workspace.status === "active");
		const workspaceName = (workspaceId: string) => {
			const workspace = workspaces[workspaceId];
			const project = workspace === undefined ? undefined : projects[workspace.projectId];
			return workspace === undefined
				? ""
				: `${project?.name ?? ""} / ${workspace.kind === "inPlace" ? "project folder" : workspace.name}`;
		};
		return [
			...agents.map((agent) => ({
				id: `chat:${agent.kind}`,
				group: "Actions",
				label: `New ${agent.kind === "claude" ? "Claude Code" : "Codex"} chat`,
				run: () => void newChat(undefined, agent.kind),
			})),
			...Object.values(projects).map((project) => ({
				id: `workspace:${project.id}`,
				group: "Actions",
				label: `New workspace in ${project.name}`,
				run: () => openDialog({ kind: "newWorkspace", projectId: project.id }),
			})),
			{ id: "project", group: "Actions", label: "Add a project", run: () => openDialog({ kind: "newProject" }) },
			{
				id: "panel",
				group: "Actions",
				label: panelOpen ? "Hide the side panel" : "Show the side panel",
				run: () => setPanel({ open: !panelOpen }),
			},
			{
				id: "theme",
				group: "Actions",
				label: dark ? "Switch to the light theme" : "Switch to the dark theme",
				run: () => setTheme(dark ? "light" : "dark"),
			},
			{
				id: "settings",
				group: "Actions",
				label: "Settings",
				run: () => openDialog({ kind: "settings", tab: "accounts" }),
			},
			...active.map((workspace) => ({
				id: `go:${workspace.id}`,
				group: "Workspaces",
				label: workspaceName(workspace.id),
				detail: workspace.branch,
				run: () => selectWorkspace(workspace.id),
			})),
			...Object.values(sessions)
				.filter((session) => workspaces[session.workspaceId]?.status === "active")
				.map((session) => ({
					id: `session:${session.id}`,
					group: "Chats",
					label: sessionTitle(session),
					detail: workspaceName(session.workspaceId),
					run: () => selectSession(session.id),
				})),
		];
	}, [projects, workspaces, sessions, agents, panelOpen, dark, setTheme]);
};

const GROUPS = ["Actions", "Workspaces", "Chats"] as const;

export const CommandPalette = () => {
	const open = useAppState((current) => current.dialog?.kind === "palette");
	return (
		<CommandDialog
			open={open}
			onOpenChange={(next) => !next && openDialog(null)}
			title="Search Octopus"
			description="Search chats, workspaces and actions"
			showCloseButton={false}
			className="top-[14%] translate-y-0"
		>
			{open ? <PaletteBody /> : null}
		</CommandDialog>
	);
};

const PaletteBody = () => {
	const commands = useCommands();
	const run = (command: PaletteCommand) => {
		openDialog(null);
		command.run();
	};
	return (
		<>
			<CommandInput placeholder="Search chats, workspaces and actions" />
			<CommandList>
				<CommandEmpty>Nothing matches.</CommandEmpty>
				{GROUPS.map((group) => (
					<CommandGroup key={group} heading={group}>
						{commands
							.filter((command) => command.group === group)
							.map((command) => (
								<CommandItem
									key={command.id}
									value={command.id}
									keywords={[command.label, command.detail ?? ""]}
									onSelect={() => run(command)}
									className="py-1.5"
								>
									<span className="truncate">{command.label}</span>
									{command.detail === undefined ? null : (
										<span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{command.detail}</span>
									)}
								</CommandItem>
							))}
					</CommandGroup>
				))}
			</CommandList>
		</>
	);
};
