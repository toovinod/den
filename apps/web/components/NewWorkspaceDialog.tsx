"use client";

import { createWorkspace, newChat, openDialog, useAppState } from "../lib/store.ts";
import { errorMessage } from "../lib/daemonRuntime.ts";
import { isWorkspaceName } from "../lib/names.ts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { useState } from "react";

export const NewWorkspaceDialog = () => {
	const dialog = useAppState((current) => current.dialog);
	const projectId = dialog?.kind === "newWorkspace" ? dialog.projectId : null;
	const project = useAppState((current) => (projectId === null ? undefined : current.projects[projectId]));
	return (
		<Dialog open={project !== undefined} onOpenChange={(next) => !next && openDialog(null)}>
			{project === undefined ? null : (
				<DialogContent>
					<DialogHeader>
						<DialogTitle>New workspace in {project.name}</DialogTitle>
						<DialogDescription>
							A worktree gets its own branch off {project.defaultBranch}, so agents never step on each other.
						</DialogDescription>
					</DialogHeader>
					<WorkspaceForm projectId={project.id} />
				</DialogContent>
			)}
		</Dialog>
	);
};

const KINDS = [
	{ value: "worktree", title: "New worktree", detail: "Its own branch and folder." },
	{ value: "inPlace", title: "Project folder", detail: "Work on the checked-out branch in the project folder." },
] as const;

const WorkspaceForm = ({ projectId }: { readonly projectId: string }) => {
	const [kind, setKind] = useState<"worktree" | "inPlace">("worktree");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const valid = kind === "inPlace" || isWorkspaceName(name);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				await createWorkspace(kind === "worktree" ? { kind, projectId, name } : { kind, projectId }).then(
					async (workspace) => {
						openDialog(null);
						await newChat(workspace.id);
					},
					(failure: unknown) => setError(errorMessage(failure)),
				);
				setBusy(false);
			}}
		>
			<Tabs
				value={kind}
				onValueChange={(value) => {
					const picked = KINDS.find((item) => item.value === value);
					if (picked !== undefined) setKind(picked.value);
				}}
			>
				<TabsList aria-label="Workspace kind" className="w-full">
					{KINDS.map((item) => (
						<TabsTrigger key={item.value} value={item.value}>
							{item.title}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<p className="text-xs text-muted-foreground">{KINDS.find((item) => item.value === kind)?.detail}</p>
			{kind === "worktree" ? (
				<div className="flex flex-col gap-2">
					<Label htmlFor="workspace-name">Name and branch</Label>
					<Input
						id="workspace-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="fix-login"
						className="font-mono"
					/>
					{name !== "" && !valid ? (
						<p className="text-xs text-attention">Use letters, digits, dots, dashes and underscores.</p>
					) : null}
				</div>
			) : null}
			{error === null ? null : <p className="text-xs text-destructive">{error}</p>}
			<Button type="submit" variant="default" className="self-end" disabled={busy || !valid}>
				{busy ? "Creating" : "Create workspace"}
			</Button>
		</form>
	);
};
