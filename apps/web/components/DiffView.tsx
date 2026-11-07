"use client";

import { type DiffRow, diffRows, type Segment, startsOpen } from "../lib/diffRows.ts";
import type { DiffFile, DiffLine, WorkspaceDiff } from "@repo/contracts/Git";
import { ChevronRightIcon, GitCommitIcon, RefreshCwIcon, UploadIcon } from "lucide-react";
import { callDaemon, errorMessage } from "../lib/daemonRuntime.ts";
import { toast, updateSettings, useAppState } from "../lib/store.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@repo/contracts/Workspace";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Hint } from "./Hint.tsx";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Input } from "@repo/ui/components/input";
import { cn } from "@repo/ui/lib/utils";

const DIFF_MODES = ["unified", "split"] as const;

const STATUS_LETTERS = {
	added: { letter: "A", tone: "text-success" },
	untracked: { letter: "U", tone: "text-success" },
	deleted: { letter: "D", tone: "text-destructive" },
	modified: { letter: "M", tone: "text-attention" },
	renamed: { letter: "R", tone: "text-running" },
} as const;

// Reloads when any chat in the workspace finishes a turn, since that is when files change.
const useTurnsFinished = (workspaceId: string) =>
	useAppState((current) =>
		Object.values(current.sessions)
			.filter((session) => session.workspaceId === workspaceId && session.status !== "running")
			.map((session) => session.updatedAt)
			.sort()
			.at(-1),
	);

export const DiffView = ({ workspace }: { readonly workspace: Workspace }) => {
	const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	// Files the user opened or closed, overriding startsOpen.
	const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
	const mode = useAppState((current) => current.settings.diffMode);
	const finished = useTurnsFinished(workspace.id);

	const load = useCallback(async () => {
		setLoading(true);
		await callDaemon((daemon) => daemon.getWorkspaceDiff({ workspaceId: workspace.id })).then(
			(loaded) => {
				setDiff(loaded);
				setError(null);
			},
			(failure: unknown) => setError(errorMessage(failure)),
		);
		setLoading(false);
	}, [workspace.id]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: finished is the reload signal.
	useEffect(() => {
		void load();
	}, [load, finished]);

	const loadFullFile = async (path: string) => {
		const file = await callDaemon((daemon) => daemon.getFileDiff({ workspaceId: workspace.id, path })).catch(
			(failure: unknown) => {
				toast(errorMessage(failure));
				return null;
			},
		);
		if (file === null) return;
		setDiff((current) =>
			current === null
				? current
				: { ...current, files: current.files.map((item) => (item.path === path ? file : item)) },
		);
	};

	const isOpen = useCallback((file: DiffFile) => toggled.get(file.path) ?? startsOpen(file), [toggled]);
	const rows = useMemo(() => (diff === null ? [] : diffRows(diff.files, mode, isOpen)), [diff, mode, isOpen]);
	const totals = useMemo(
		() =>
			(diff?.files ?? []).reduce(
				(sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
				{ additions: 0, deletions: 0 },
			),
		[diff],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
				<span className="text-muted-foreground">
					{diff === null ? "Loading changes" : `${diff.files.length} files changed against ${diff.baseBranch}`}
				</span>
				{diff === null ? null : (
					<span className="font-mono">
						<span className="text-success">+{totals.additions}</span>{" "}
						<span className="text-destructive">-{totals.deletions}</span>
					</span>
				)}
				<div className="flex-1" />
				<Tabs
					value={mode}
					onValueChange={(value) => {
						const option = DIFF_MODES.find((item) => item === value);
						if (option !== undefined) updateSettings({ diffMode: option });
					}}
				>
					<TabsList aria-label="Diff layout" className="h-6! p-0.5">
						{DIFF_MODES.map((option) => (
							<TabsTrigger key={option} value={option} className="px-1.5 py-0 text-xs capitalize">
								{option}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<Hint label="Reload the diff">
					<Button variant="ghost" size="icon-xs" aria-label="Reload the diff" onClick={() => void load()}>
						<RefreshCwIcon className={cn(loading && "animate-spin")} />
					</Button>
				</Hint>
			</div>
			<CommitBar workspace={workspace} hasChanges={(diff?.files.length ?? 0) > 0} onCommitted={() => void load()} />
			{error !== null ? (
				<p className="p-4 text-xs text-destructive">{error}</p>
			) : diff !== null && diff.files.length === 0 ? (
				<p className="p-4 text-xs text-muted-foreground">No changes against {diff.baseBranch} yet.</p>
			) : (
				<DiffRows
					rows={rows}
					mode={mode}
					onToggle={(file) => setToggled((current) => new Map(current).set(file.path, !isOpen(file)))}
					onLoadFull={(path) => void loadFullFile(path)}
				/>
			)}
		</div>
	);
};

const CommitBar = ({
	workspace,
	hasChanges,
	onCommitted,
}: {
	readonly workspace: Workspace;
	readonly hasChanges: boolean;
	readonly onCommitted: () => void;
}) => {
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState<"commit" | "push" | null>(null);
	const commit = async () => {
		setBusy("commit");
		await callDaemon((daemon) => daemon.commit({ workspaceId: workspace.id, message, paths: null })).then(
			(result) => {
				setMessage("");
				toast(`Committed ${result.sha.slice(0, 7)}`, "info");
				onCommitted();
			},
			(failure: unknown) => toast(errorMessage(failure)),
		);
		setBusy(null);
	};
	const push = async () => {
		setBusy("push");
		await callDaemon((daemon) => daemon.push({ workspaceId: workspace.id })).then(
			() => toast(`Pushed ${workspace.branch}`, "info"),
			(failure: unknown) => toast(errorMessage(failure)),
		);
		setBusy(null);
	};
	return (
		<form
			className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (message.trim() !== "") void commit();
			}}
		>
			<Input
				value={message}
				onChange={(event) => setMessage(event.target.value)}
				placeholder={hasChanges ? "Commit message" : "Nothing to commit"}
				disabled={!hasChanges || busy !== null}
				aria-label="Commit message"
				className="h-8"
			/>
			<Button
				variant="secondary"
				type="submit"
				size="sm"
				disabled={!hasChanges || message.trim() === "" || busy !== null}
			>
				<GitCommitIcon />
				Commit
			</Button>
			<Hint label={`Push ${workspace.branch} to origin`}>
				<Button variant="ghost" size="icon-sm" aria-label="Push" disabled={busy !== null} onClick={() => void push()}>
					<UploadIcon />
				</Button>
			</Hint>
		</form>
	);
};

const ROW_HEIGHTS: Record<DiffRow["type"], number> = { file: 32, hunk: 24, line: 20, pair: 20, notice: 36 };

const DiffRows = ({
	rows,
	mode,
	onToggle,
	onLoadFull,
}: {
	readonly rows: ReadonlyArray<DiffRow>;
	readonly mode: "unified" | "split";
	readonly onToggle?: (file: DiffFile) => void;
	readonly onLoadFull?: (path: string) => void;
}) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => ROW_HEIGHTS[rows[index]?.type ?? "line"],
		getItemKey: (index) => {
			const row = rows[index];
			return row === undefined ? index : row.type === "file" ? `file:${row.file.path}` : row.key;
		},
		overscan: 20,
	});
	return (
		<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
			<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const row = rows[virtualRow.index];
					return row === undefined ? null : (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute inset-x-0"
							style={{ transform: `translateY(${virtualRow.start}px)` }}
						>
							<RowView row={row} mode={mode} onToggle={onToggle} onLoadFull={onLoadFull} />
						</div>
					);
				})}
			</div>
		</div>
	);
};

const RowView = ({
	row,
	mode,
	onToggle,
	onLoadFull,
}: {
	readonly row: DiffRow;
	readonly mode: "unified" | "split";
	readonly onToggle: ((file: DiffFile) => void) | undefined;
	readonly onLoadFull: ((path: string) => void) | undefined;
}) => {
	switch (row.type) {
		case "file": {
			const status = STATUS_LETTERS[row.file.status];
			return (
				<button
					type="button"
					disabled={onToggle === undefined}
					onClick={() => onToggle?.(row.file)}
					aria-expanded={row.open}
					className="flex h-8 w-full items-center gap-2 border-y border-border bg-card px-3 text-left font-sans"
				>
					<ChevronRightIcon
						className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", row.open && "rotate-90")}
					/>
					<span className={cn("w-3 font-mono font-semibold", status.tone)}>{status.letter}</span>
					<span className="min-w-0 flex-1 truncate">
						{row.file.oldPath === null ? row.file.path : `${row.file.oldPath} to ${row.file.path}`}
					</span>
					<span className="font-mono">
						<span className="text-success">+{row.file.additions}</span>{" "}
						<span className="text-destructive">-{row.file.deletions}</span>
					</span>
				</button>
			);
		}
		case "hunk":
			return <div className="truncate bg-diff-hunk px-3 py-1 text-running">{row.header}</div>;
		case "notice":
			return (
				<div className="flex items-center gap-2 px-3 py-2 font-sans text-muted-foreground">
					{row.reason === "binary" ? (
						"Binary file, not shown."
					) : (
						<>
							This diff is too large to show at once.
							{onLoadFull === undefined ? null : (
								<Button size="xs" variant="secondary" onClick={() => onLoadFull(row.path)}>
									Load it
								</Button>
							)}
						</>
					)}
				</div>
			);
		case "line":
			return (
				<div className={cn("flex min-h-5", lineTone(row.line))}>
					<LineNumber value={row.line.oldLine} />
					<LineNumber value={row.line.newLine} />
					<span className="w-4 shrink-0 text-center text-muted-foreground/60 select-none">
						{MARKERS[row.line.kind]}
					</span>
					<LineText line={row.line} segments={row.segments} />
				</div>
			);
		case "pair":
			return mode === "split" ? (
				<div className="grid min-h-5 grid-cols-2">
					<Half line={row.left} number={row.left?.oldLine ?? null} segments={row.leftSegments} />
					<Half line={row.right} number={row.right?.newLine ?? null} segments={row.rightSegments} />
				</div>
			) : null;
	}
};

const MARKERS = { add: "+", delete: "-", context: " " } as const;

const lineTone = (line: DiffLine) =>
	line.kind === "add" ? "bg-diff-add" : line.kind === "delete" ? "bg-diff-delete" : "";

const LineNumber = ({ value }: { readonly value: number | null }) => (
	<span className="w-10 shrink-0 pr-2 text-right text-muted-foreground/60 select-none">{value ?? ""}</span>
);

const LineText = ({
	line,
	segments,
}: {
	readonly line: DiffLine;
	readonly segments: ReadonlyArray<Segment> | null;
}) => (
	<span className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">
		{segments === null
			? line.text
			: segments.map((segment, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder.
						key={index}
						className={cn(
							segment.changed &&
								(line.kind === "add" ? "rounded-sm bg-diff-add-word" : "rounded-sm bg-diff-delete-word"),
						)}
					>
						{segment.text}
					</span>
				))}
	</span>
);

const Half = ({
	line,
	number,
	segments,
}: {
	readonly line: DiffLine | null;
	readonly number: number | null;
	readonly segments: ReadonlyArray<Segment> | null;
}) =>
	line === null ? (
		<div className="bg-muted/40" />
	) : (
		<div className={cn("flex min-w-0 border-r border-border last:border-r-0", lineTone(line))}>
			<LineNumber value={number} />
			<LineText line={line} segments={segments} />
		</div>
	);
