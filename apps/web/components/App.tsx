"use client";

import { OctopusLogo } from "./OctopusLogo.tsx";
import { boot, closeTab, newChat, onWindowFocus, openDialog, setPanel, useAppState } from "../lib/store.ts";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@repo/ui/components/resizable";
import { onDaemonStopped, restartDaemon } from "../lib/daemonRuntime.ts";
import { SidebarProvider } from "@repo/ui/components/sidebar";
import { TooltipProvider } from "@repo/ui/components/tooltip";
import { Toaster } from "@repo/ui/components/sonner";
import { Button } from "@repo/ui/components/button";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog.tsx";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { getState } from "../lib/store.ts";
import { SidePanel } from "./SidePanel.tsx";
import { ChatView } from "./ChatView.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useEffect, useState } from "react";

const useShortcuts = () =>
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const key = event.key.toLowerCase();
			const { selectedSessionId, panel } = getState();
			const action =
				key === "k"
					? () => openDialog({ kind: "palette" })
					: key === "t"
						? () => void newChat()
						: key === ","
							? () => openDialog({ kind: "settings", tab: "accounts" })
							: key === "w" && selectedSessionId !== null
								? () => closeTab(selectedSessionId)
								: key === "\\"
									? () => setPanel({ open: !panel.open })
									: null;
			if (action === null) return;
			event.preventDefault();
			action();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("focus", onWindowFocus);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("focus", onWindowFocus);
		};
	}, []);

const useDaemonStopped = () => {
	const [stopped, setStopped] = useState(false);
	useEffect(() => onDaemonStopped(() => setStopped(true)), []);
	return stopped;
};

// The user restarts the daemon, never a timer, so a daemon that crashes on start does not restart in a loop.
const DaemonStopped = () => {
	const [restart, setRestart] = useState<"idle" | "restarting" | "failed">("idle");
	const onRestart = () => {
		setRestart("restarting");
		restartDaemon().catch(() => setRestart("failed"));
	};
	return (
		<main className="flex h-full flex-col items-center justify-center gap-2 text-center">
			<OctopusLogo className="size-10" />
			<p className="font-medium">Octopus lost its daemon.</p>
			<p className="max-w-sm text-sm text-muted-foreground">
				{restart === "failed"
					? "Octopus could not start its daemon again. Quit Octopus and open it again."
					: "Agents and terminals that were running have stopped. Restart the daemon to reconnect."}
			</p>
			<Button size="sm" className="mt-2" disabled={restart === "restarting"} onClick={onRestart}>
				{restart === "restarting" ? "Restarting" : "Restart"}
			</Button>
		</main>
	);
};

export const App = () => {
	const connection = useAppState((current) => current.connection);
	const panelOpen = useAppState((current) => current.panel.open);
	const hasWorkspace = useAppState((current) => current.selectedWorkspaceId !== null);
	const daemonStopped = useDaemonStopped();
	useShortcuts();
	useEffect(() => {
		void boot();
	}, []);

	if (daemonStopped) return <DaemonStopped />;

	if (connection.status !== "ready") {
		return (
			<main className="flex h-full flex-col items-center justify-center gap-2 text-center">
				<OctopusLogo className="size-10" />
				<p className="font-medium">Octopus</p>
				<p className="text-sm text-muted-foreground">
					{connection.status === "failed" ? connection.message : "Connecting to the daemon"}
				</p>
			</main>
		);
	}

	return (
		<SidebarProvider className="h-full min-h-0">
			<TooltipProvider delayDuration={400}>
				<ResizablePanelGroup>
					<ResizablePanel id="sidebar" defaultSize="18" minSize={200} maxSize="30">
						<Sidebar />
					</ResizablePanel>
					<ResizableHandle />
					<ResizablePanel id="chat" minSize={360}>
						<ChatView />
					</ResizablePanel>
					{panelOpen && hasWorkspace ? (
						<>
							<ResizableHandle />
							<ResizablePanel id="panel" defaultSize="36" minSize={320}>
								<SidePanel />
							</ResizablePanel>
						</>
					) : null}
				</ResizablePanelGroup>
				<CommandPalette />
				<NewProjectDialog />
				<NewWorkspaceDialog />
				<WorkspaceSettingsDialog />
				<SettingsDialog />
				<Toaster position="bottom-right" />
			</TooltipProvider>
		</SidebarProvider>
	);
};
