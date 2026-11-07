"use client";

import { ChevronLeftIcon, FileIcon, FolderIcon, RefreshCwIcon } from "lucide-react";
import type { FileContent, FileEntry } from "@repo/contracts/WorkspaceFile";
import { useDaemonValue } from "../lib/useDaemonValue.ts";
import { callDaemon } from "../lib/daemonRuntime.ts";
import type { Workspace } from "@repo/contracts/Workspace";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@repo/ui/components/button";
import { useMemo, useRef, useState } from "react";
import { Hint } from "./Hint.tsx";

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

// Folder by folder, the way git sees the workspace: ignored files are left out.
export const FileBrowser = ({ workspace }: { readonly workspace: Workspace }) => {
	const [folder, setFolder] = useState("");
	const [file, setFile] = useState<string | null>(null);
	if (file !== null) {
		return <FileViewer workspace={workspace} path={file} onBack={() => setFile(null)} />;
	}
	return (
		<FolderList
			workspace={workspace}
			folder={folder}
			onOpen={(entry) => (entry.kind === "directory" ? setFolder(entry.path) : setFile(entry.path))}
			onUp={() => setFolder(parentOf(folder))}
		/>
	);
};

const FolderList = ({
	workspace,
	folder,
	onOpen,
	onUp,
}: {
	readonly workspace: Workspace;
	readonly folder: string;
	readonly onOpen: (entry: FileEntry) => void;
	readonly onUp: () => void;
}) => {
	const { loaded: entries, reload } = useDaemonValue(
		() => callDaemon((daemon) => daemon.listDirectory({ workspaceId: workspace.id, path: folder })),
		`${workspace.id}:${folder}`,
	);
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
				{folder === "" ? null : (
					<Button variant="ghost" size="icon-xs" onClick={onUp} aria-label="Up one folder">
						<ChevronLeftIcon />
					</Button>
				)}
				<span className="flex-1 truncate font-mono text-muted-foreground">
					{folder === "" ? workspace.name : folder}
				</span>
				<Hint label="Reload the folder">
					<Button variant="ghost" size="icon-xs" aria-label="Reload the folder" onClick={reload}>
						<RefreshCwIcon />
					</Button>
				</Hint>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-1">
				{entries.state === "loading" ? null : entries.state === "failed" ? (
					<p className="p-3 text-xs text-destructive">{entries.message}</p>
				) : entries.value.length === 0 ? (
					<p className="p-3 text-xs text-muted-foreground">This folder is empty.</p>
				) : (
					entries.value.map((entry) => (
						<button
							key={entry.path}
							type="button"
							onClick={() => onOpen(entry)}
							className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
						>
							{entry.kind === "directory" ? (
								<FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
							) : (
								<FileIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
							)}
							<span className="truncate">{entry.name}</span>
						</button>
					))
				)}
			</div>
		</div>
	);
};

const describe = (content: FileContent) => {
	switch (content.kind) {
		case "symlink":
			return `A link to ${content.target}. Den does not follow links.`;
		case "binary":
			return `A binary file of ${content.size} bytes.`;
		case "tooLarge":
			return `${Math.round(content.size / 1024)} KB is too large to show here. Open it in your editor.`;
		case "text":
			return null;
	}
};

const FileViewer = ({
	workspace,
	path,
	onBack,
}: {
	readonly workspace: Workspace;
	readonly path: string;
	readonly onBack: () => void;
}) => {
	const { loaded: content } = useDaemonValue(
		() => callDaemon((daemon) => daemon.readFile({ workspaceId: workspace.id, path })),
		`${workspace.id}:${path}`,
	);
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
				<Button variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to the folder">
					<ChevronLeftIcon />
				</Button>
				<span className="truncate font-mono">{path}</span>
			</div>
			{content.state === "loading" ? null : content.state === "failed" ? (
				<p className="p-3 text-xs text-destructive">{content.message}</p>
			) : content.value.kind === "text" ? (
				<TextLines text={content.value.text} />
			) : (
				<p className="p-3 text-xs text-muted-foreground">{describe(content.value)}</p>
			)}
		</div>
	);
};

const TextLines = ({ text }: { readonly text: string }) => {
	const lines = useMemo(() => text.split("\n"), [text]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: lines.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 18,
		overscan: 30,
	});
	return (
		<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto font-mono text-xs">
			<div className="relative min-w-full" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((row) => (
					<div
						key={row.key}
						data-index={row.index}
						ref={virtualizer.measureElement}
						className="absolute inset-x-0 flex"
						style={{ transform: `translateY(${row.start}px)` }}
					>
						<span className="w-12 shrink-0 pr-3 text-right text-muted-foreground/60 select-none">{row.index + 1}</span>
						<span className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">{lines[row.index]}</span>
					</div>
				))}
			</div>
		</div>
	);
};
