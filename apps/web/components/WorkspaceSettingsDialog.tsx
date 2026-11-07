"use client";

import {
	archiveWorkspace,
	isUnsavedWorkError,
	openDialog,
	setProjectTrust,
	updateProjectScripts,
	useAppState,
} from "../lib/store.ts";
import type { Workspace } from "@repo/contracts/Workspace";
import type { Project } from "@repo/contracts/Project";
import { errorMessage } from "../lib/daemonRuntime.ts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { Textarea } from "@repo/ui/components/textarea";
import { Button } from "@repo/ui/components/button";
import { Switch } from "@repo/ui/components/switch";
import { Label } from "@repo/ui/components/label";
import { useState } from "react";

export const WorkspaceSettingsDialog = () => {
	const dialog = useAppState((current) => current.dialog);
	const workspaceId = dialog?.kind === "workspaceSettings" ? dialog.workspaceId : null;
	const workspace = useAppState((current) => (workspaceId === null ? undefined : current.workspaces[workspaceId]));
	const project = useAppState((current) =>
		workspace === undefined ? undefined : current.projects[workspace.projectId],
	);
	const open = workspace !== undefined && project !== undefined;
	return (
		<Dialog open={open} onOpenChange={(next) => !next && openDialog(null)}>
			{open ? (
				<DialogContent className="max-h-[85vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{workspace.kind === "inPlace" ? `${project.name} folder` : workspace.name}</DialogTitle>
						<DialogDescription className="font-mono text-xs break-all">{workspace.path}</DialogDescription>
					</DialogHeader>
					<Scripts key={project.id} project={project} />
					<Trust project={project} />
					{workspace.status === "active" ? <Archive workspace={workspace} /> : null}
				</DialogContent>
			) : null}
		</Dialog>
	);
};

const Scripts = ({ project }: { readonly project: Project }) => {
	const [setup, setSetup] = useState(project.setupScript ?? "");
	const [run, setRun] = useState(project.runScript ?? "");
	const [state, setState] = useState<{ readonly saving: boolean; readonly message: string | null }>({
		saving: false,
		message: null,
	});
	const changed = setup !== (project.setupScript ?? "") || run !== (project.runScript ?? "");
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={async (event) => {
				event.preventDefault();
				setState({ saving: true, message: null });
				const message = await updateProjectScripts(project.id, setup || null, run || null).then(
					() => "Saved.",
					(error: unknown) => errorMessage(error),
				);
				setState({ saving: false, message });
			}}
		>
			<p className="text-xs text-muted-foreground">
				These scripts belong to {project.name} and run in every workspace of it.
			</p>
			<Label htmlFor="setup-script">Setup script, runs once when a workspace is created</Label>
			<Textarea
				id="setup-script"
				rows={3}
				value={setup}
				onChange={(event) => setSetup(event.target.value)}
				placeholder="bun install"
			/>
			<Label htmlFor="run-script">Run script, starts from the Run tab</Label>
			<Textarea
				id="run-script"
				rows={2}
				value={run}
				onChange={(event) => setRun(event.target.value)}
				placeholder="bun run dev"
			/>
			<div className="flex items-center justify-end gap-2">
				{state.message === null ? null : <span className="text-xs text-muted-foreground">{state.message}</span>}
				<Button variant="secondary" size="sm" type="submit" disabled={!changed || state.saving}>
					Save scripts
				</Button>
			</div>
		</form>
	);
};

const Trust = ({ project }: { readonly project: Project }) => (
	<div className="flex gap-3 rounded-md border p-3">
		<div className="flex flex-1 flex-col gap-1">
			<Label htmlFor="project-trust" className="text-foreground">
				Trust this project
			</Label>
			<p className="text-xs text-muted-foreground">
				A repository can ship its own agent settings: hooks that run commands and rules that skip approvals. Den loads
				them only for projects you trust. Turn this on only for code you would run yourself.
			</p>
		</div>
		<Switch
			id="project-trust"
			checked={project.trusted}
			onCheckedChange={(trusted) => void setProjectTrust(project.id, trusted)}
		/>
	</div>
);

const Archive = ({ workspace }: { readonly workspace: Workspace }) => {
	const [state, setState] = useState<"idle" | "busy" | "unsaved">("idle");
	const [error, setError] = useState<string | null>(null);
	const archive = async (force: boolean) => {
		setState("busy");
		setError(null);
		await archiveWorkspace(workspace.id, force).then(
			() => openDialog(null),
			(failure: unknown) => {
				if (isUnsavedWorkError(failure)) {
					setState("unsaved");
					return;
				}
				setError(errorMessage(failure));
				setState("idle");
			},
		);
	};
	return (
		<div className="flex flex-col gap-2 rounded-md border p-3">
			<p className="font-medium">Archive</p>
			<p className="text-xs text-muted-foreground">
				{workspace.kind === "worktree"
					? "Stops its agents and terminals and removes the worktree folder. The branch stays in git."
					: "Stops its agents and terminals. The project folder stays as it is."}
			</p>
			{state === "unsaved" ? (
				<div className="flex flex-col gap-2 rounded-md bg-destructive/10 p-2.5">
					<p className="text-xs text-destructive">
						This worktree has changes that are not committed or not pushed. Archiving anyway deletes them.
					</p>
					<div className="flex justify-end gap-1.5">
						<Button size="sm" variant="ghost" onClick={() => setState("idle")}>
							Keep the workspace
						</Button>
						<Button size="sm" variant="destructive" onClick={() => void archive(true)}>
							Archive and delete changes
						</Button>
					</div>
				</div>
			) : (
				<Button
					variant="destructive"
					size="sm"
					className="self-start"
					disabled={state === "busy"}
					onClick={() => void archive(false)}
				>
					Archive workspace
				</Button>
			)}
			{error === null ? null : <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
};
