"use client";

import { addProject, createProject, openDialog, useAppState } from "../lib/store.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { isDesktop, pickFolder } from "../lib/desktop.ts";
import { errorMessage } from "../lib/daemonRuntime.ts";
import { isProjectFolderName } from "../lib/names.ts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { useState } from "react";

export const NewProjectDialog = () => {
	const open = useAppState((current) => current.dialog?.kind === "newProject");
	return (
		<Dialog open={open} onOpenChange={(next) => !next && openDialog(null)}>
			{open ? (
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add a project</DialogTitle>
						<DialogDescription>Swarm works in git repositories on this computer.</DialogDescription>
					</DialogHeader>
					<Tabs defaultValue="existing" className="gap-3">
						<TabsList className="w-full">
							<TabsTrigger value="existing">Open a folder</TabsTrigger>
							<TabsTrigger value="new">Create a folder</TabsTrigger>
						</TabsList>
						<TabsContent value="existing">
							<ExistingFolder />
						</TabsContent>
						<TabsContent value="new">
							<NewFolder />
						</TabsContent>
					</Tabs>
				</DialogContent>
			) : null}
		</Dialog>
	);
};

const FolderField = ({
	id,
	label,
	value,
	onChange,
}: {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly onChange: (path: string) => void;
}) => (
	<div className="flex flex-col gap-2">
		<Label htmlFor={id}>{label}</Label>
		<div className="flex gap-1.5">
			<Input
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder="/Users/you/code/project"
				className="font-mono"
			/>
			{isDesktop() ? (
				<Button
					variant="secondary"
					onClick={async () => {
						const picked = await pickFolder(label);
						if (picked !== null) onChange(picked);
					}}
				>
					Browse
				</Button>
			) : null}
		</div>
	</div>
);

// After adding, the new project asks for its first workspace.
const added = (projectId: string) => openDialog({ kind: "newWorkspace", projectId });

const ExistingFolder = () => {
	const [path, setPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				await addProject(path.trim()).then(
					(project) => added(project.id),
					(failure: unknown) => setError(errorMessage(failure)),
				);
				setBusy(false);
			}}
		>
			<FolderField id="project-path" label="Repository folder" value={path} onChange={setPath} />
			{error === null ? null : <p className="text-xs text-destructive">{error}</p>}
			<Button type="submit" variant="default" className="self-end" disabled={busy || path.trim() === ""}>
				Add project
			</Button>
		</form>
	);
};

const NewFolder = () => {
	const [parent, setParent] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const validName = isProjectFolderName(name);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				await createProject(parent.trim(), name).then(
					(project) => added(project.id),
					(failure: unknown) => setError(errorMessage(failure)),
				);
				setBusy(false);
			}}
		>
			<FolderField id="project-parent" label="Create it in" value={parent} onChange={setParent} />
			<div className="flex flex-col gap-2">
				<Label htmlFor="project-name">Folder name</Label>
				<Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="my-app" />
				<p className="text-xs text-muted-foreground">
					Swarm makes the folder, runs git init and an empty first commit.
				</p>
			</div>
			{error === null ? null : <p className="text-xs text-destructive">{error}</p>}
			<Button
				type="submit"
				variant="default"
				className="self-end"
				disabled={busy || parent.trim() === "" || !validName}
			>
				Create project
			</Button>
		</form>
	);
};
