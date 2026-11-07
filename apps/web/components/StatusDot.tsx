import type { AgentSessionStatus } from "@repo/contracts/AgentSession";
import type { Attention } from "../lib/store.ts";
import { cn } from "@repo/ui/lib/utils";

// Running pulses, approval and failure get their colors, and finished work the user has not seen yet
// shows a filled dot. Idle chats show nothing, so the sidebar stays quiet.
export const StatusDot = ({
	status,
	attention,
	className,
}: {
	readonly status: AgentSessionStatus | null;
	readonly attention?: Attention | undefined;
	readonly className?: string;
}) => {
	const tone =
		status === "awaitingApproval" || attention === "approval"
			? "bg-attention"
			: status === "failed" || attention === "failed"
				? "bg-destructive"
				: status === "running"
					? "bg-running animate-pulse"
					: attention === "done"
						? "bg-success"
						: null;
	return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone ?? "bg-transparent", className)} />;
};
