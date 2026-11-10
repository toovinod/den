"use client";

import { callDaemon, errorMessage, followDaemon } from "../lib/daemonRuntime.ts";
import type { ScriptRun, ScriptRunKind } from "@repo/contracts/ScriptRun";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { followReattaching } from "../lib/followReattaching.ts";
import { useDaemonValue } from "../lib/useDaemonValue.ts";
import type { Workspace } from "@repo/contracts/Workspace";
import { openDialog, toast } from "../lib/store.ts";
import { PlayIcon, SquareIcon } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";

// The daemon keeps a capped tail. The view keeps no more than this many lines either.
const MAX_LINES = 5000;

const SCRIPT_KINDS = ["run", "setup"] as const;

const STATUS_TEXT: Record<ScriptRun["status"], string> = {
	pending: "Waiting to start",
	processing: "Running",
	completed: "Finished",
	failed: "Failed",
	deadLetter: "Gave up after retries",
};

const latest = (runs: ReadonlyArray<ScriptRun>, kind: ScriptRunKind) =>
	runs
		.filter((run) => run.kind === kind)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.at(-1);

export const RunPanel = ({ workspace }: { readonly workspace: Workspace }) => {
	const [kind, setKind] = useState<ScriptRunKind>("run");
	const { loaded, reload } = useDaemonValue(
		() => callDaemon((daemon) => daemon.listScriptRuns({ workspaceId: workspace.id })),
		workspace.id,
	);
	// Each status change reloads the list, so the panel never sits on "Waiting to start" once a run started.
	// After a dropped connection, a reload catches up on the changes missed meanwhile.
	useEffect(
		() =>
			followReattaching<ScriptRun>(
				(handlers) => followDaemon((daemon) => daemon.watchScriptRuns({ workspaceId: workspace.id }), handlers),
				{ onItem: reload, onReattach: reload },
			),
		[workspace.id, reload],
	);
	const runs = loaded.state === "ready" ? loaded.value : [];
	const run = latest(runs, kind);
	const running = run?.status === "processing" || run?.status === "pending";

	const start = async () => {
		await callDaemon((daemon) => daemon.startRunScript({ workspaceId: workspace.id })).then(reload, (error: unknown) =>
			toast(errorMessage(error)),
		);
	};
	const stop = async () => {
		await callDaemon((daemon) => daemon.stopRunScript({ workspaceId: workspace.id })).then(reload, (error: unknown) =>
			toast(errorMessage(error)),
		);
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
				<Tabs
					value={kind}
					onValueChange={(value) => {
						const option = SCRIPT_KINDS.find((item) => item === value);
						if (option !== undefined) setKind(option);
					}}
				>
					<TabsList className="h-6! p-0.5">
						{SCRIPT_KINDS.map((option) => (
							<TabsTrigger key={option} value={option} className="px-2 py-0 text-xs">
								{option === "run" ? "Run script" : "Setup script"}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<span className="flex-1 truncate px-2 text-xs text-muted-foreground">
					{run === undefined ? "" : (run.lastError ?? STATUS_TEXT[run.status])}
				</span>
				{kind === "run" ? (
					running ? (
						<Button variant="secondary" size="xs" onClick={() => void stop()}>
							<SquareIcon className="size-3 fill-current" />
							Stop
						</Button>
					) : (
						<Button size="xs" variant="default" onClick={() => void start()}>
							<PlayIcon />
							Run
						</Button>
					)
				) : null}
			</div>
			{run === undefined ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
					<p>{kind === "run" ? "The run script has not run in this workspace." : "No setup script ran here."}</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => openDialog({ kind: "workspaceSettings", workspaceId: workspace.id })}
					>
						Edit the scripts
					</Button>
				</div>
			) : (
				<ScriptOutput key={run.id} scriptRunId={run.id} onEnd={reload} />
			)}
		</div>
	);
};

const ScriptOutput = ({ scriptRunId, onEnd }: { readonly scriptRunId: string; readonly onEnd: () => void }) => {
	const [lines, setLines] = useState<ReadonlyArray<string>>([]);
	const scrollRef = useRef<HTMLPreElement>(null);

	useEffect(() => {
		let batch: Array<string> = [];
		let scheduled = false;
		// After a reattach the daemon replays the kept output, which replaces what is shown.
		let replace = false;
		const flush = () => {
			scheduled = false;
			const added = batch;
			batch = [];
			if (added.length === 0) return;
			const fresh = replace;
			replace = false;
			setLines((current) => (fresh ? added : [...current, ...added]).slice(-MAX_LINES));
		};
		return followReattaching<string>(
			(handlers) => followDaemon((daemon) => daemon.followScriptRunOutput({ scriptRunId }), handlers),
			{
				onItem: (line) => {
					batch.push(line);
					if (!scheduled) {
						scheduled = true;
						requestAnimationFrame(flush);
					}
				},
				onReattach: () => {
					flush();
					replace = true;
				},
				onEnd: () => {
					flush();
					onEnd();
				},
			},
		);
	}, [scriptRunId, onEnd]);

	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (element !== null && lines.length > 0) element.scrollTop = element.scrollHeight;
	}, [lines]);

	return (
		<pre
			ref={scrollRef}
			className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
		>
			{lines.length === 0 ? "No output yet." : lines.join("\n")}
		</pre>
	);
};
