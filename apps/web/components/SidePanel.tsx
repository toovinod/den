"use client";

import { FileDiffIcon, FolderIcon, GitPullRequestIcon, PlayIcon, TerminalIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { type PanelTab, setPanel, useAppState } from "../lib/store.ts";
import { PullRequestPanel } from "./PullRequestPanel.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { FileBrowser } from "./FileBrowser.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { DiffView } from "./DiffView.tsx";

const TABS: ReadonlyArray<{ readonly value: PanelTab; readonly label: string; readonly icon: React.ReactNode }> = [
	{ value: "diff", label: "Diff", icon: <FileDiffIcon /> },
	{ value: "files", label: "Files", icon: <FolderIcon /> },
	{ value: "terminal", label: "Terminal", icon: <TerminalIcon /> },
	{ value: "run", label: "Run", icon: <PlayIcon /> },
	{ value: "pr", label: "PR", icon: <GitPullRequestIcon /> },
];

const isPanelTab = (value: string): value is PanelTab => TABS.some((tab) => tab.value === value);

// Every tab stays mounted once opened, so switching keeps terminals, scroll positions and loaded diffs.
export const SidePanel = () => {
	const tab = useAppState((current) => current.panel.tab);
	const workspaceId = useAppState((current) => current.selectedWorkspaceId);
	const workspace = useAppState((current) => (workspaceId === null ? undefined : current.workspaces[workspaceId]));
	if (workspace === undefined) return <aside className="h-full bg-background" />;
	return (
		<Tabs
			value={tab}
			onValueChange={(value) => {
				if (isPanelTab(value)) setPanel({ tab: value });
			}}
			className="h-full gap-0 bg-background"
		>
			<TabsList variant="line" className="h-10 w-full justify-start rounded-none border-b px-2">
				{TABS.map((item) => (
					<TabsTrigger key={item.value} value={item.value} className="flex-none text-xs">
						{item.icon}
						{item.label}
					</TabsTrigger>
				))}
			</TabsList>
			{TABS.map((item) => (
				<TabsContent key={item.value} value={item.value} forceMount className="min-h-0 data-[state=inactive]:hidden">
					<PanelBody tab={item.value} workspaceKey={workspace.id} />
				</TabsContent>
			))}
		</Tabs>
	);
};

const PanelBody = ({ tab, workspaceKey }: { readonly tab: PanelTab; readonly workspaceKey: string }) => {
	const workspace = useAppState((current) => current.workspaces[workspaceKey]);
	const active = useAppState((current) => current.panel.tab === tab);
	if (workspace === undefined) return null;
	switch (tab) {
		case "diff":
			return <DiffView key={workspace.id} workspace={workspace} />;
		case "files":
			return <FileBrowser key={workspace.id} workspace={workspace} />;
		case "terminal":
			return <TerminalPanel key={workspace.id} workspace={workspace} visible={active} />;
		case "run":
			return <RunPanel key={workspace.id} workspace={workspace} />;
		case "pr":
			return <PullRequestPanel key={workspace.id} workspace={workspace} />;
	}
};
