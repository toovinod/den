import type { AgentEvent, ApprovalDecision, ApprovalOutcome, ToolCall } from "@repo/contracts/AgentEvent";
import type { SessionEvent } from "@repo/contracts/SessionEvent";

type ApprovalRequest = Extract<AgentEvent, { type: "approval.requested" }>;
type RateLimit = Omit<Extract<AgentEvent, { type: "rateLimit.updated" }>, "type">;

export type ChatItem =
	| {
			readonly kind: "user";
			readonly key: string;
			readonly text: string;
			readonly attachments: ReadonlyArray<{ readonly id: string; readonly mediaType: string }>;
	  }
	| { readonly kind: "assistant"; readonly key: string; readonly text: string; readonly streaming: boolean }
	| {
			readonly kind: "tool";
			readonly key: string;
			readonly tool: ToolCall;
			readonly status: "running" | "completed" | "failed" | "declined";
			readonly output: string | null;
	  }
	| {
			readonly kind: "approval";
			readonly key: string;
			readonly requestId: string;
			readonly approvalKind: ApprovalRequest["kind"];
			readonly summary: string;
			readonly reason: string | null;
			readonly choices: ReadonlyArray<ApprovalDecision>;
			readonly outcome: ApprovalOutcome | null;
	  }
	| { readonly kind: "notice"; readonly key: string; readonly tone: "error" | "warning"; readonly text: string };

export interface ChatState {
	readonly sessionId: string;
	readonly items: ReadonlyArray<ChatItem>;
	// Item key to its position in items, so a delta updates its message without a search.
	readonly positions: Readonly<Record<string, number>>;
	// The last stored event applied. Resubscribing starts after it.
	readonly lastSequence: number;
	// The oldest stored event loaded, or null before any. Sequences start at 0, so older pages exist while it is above 0.
	readonly firstSequence: number | null;
	// Answers to approvals asked before the loaded history starts. An older page shows them on its requests.
	readonly earlierOutcomes: Readonly<Record<string, ApprovalOutcome>>;
	readonly usage: { readonly contextTokens: number; readonly contextWindow: number | null } | null;
	readonly rateLimit: RateLimit | null;
}

export const emptyChat = (sessionId: string): ChatState => ({
	sessionId,
	items: [],
	positions: {},
	lastSequence: -1,
	firstSequence: null,
	earlierOutcomes: {},
	usage: null,
	rateLimit: null,
});

// Applies a batch of events with one copy of the item list, however many events arrive.
export const applyEvents = (state: ChatState, events: ReadonlyArray<SessionEvent>): ChatState => {
	const items = state.items.slice();
	// Copied only when a new item arrives. Most batches are deltas to a message that already has a position.
	let positions = state.positions;
	let ownPositions: Record<string, number> | null = null;
	let { lastSequence, firstSequence, earlierOutcomes, usage, rateLimit } = state;

	const put = (item: ChatItem) => {
		const at = positions[item.key];
		if (at === undefined) {
			ownPositions ??= { ...positions };
			ownPositions[item.key] = items.length;
			positions = ownPositions;
			items.push(item);
		} else {
			items[at] = item;
		}
	};
	const find = (key: string) => {
		const at = positions[key];
		return at === undefined ? undefined : items[at];
	};

	for (const { sequence, event } of events) {
		if (sequence !== null) {
			// A resubscribe can replay events this state already holds.
			if (sequence <= lastSequence) continue;
			lastSequence = sequence;
			firstSequence ??= sequence;
		}
		switch (event.type) {
			case "user.message":
				put({ kind: "user", key: `user:${event.itemId}`, text: event.text, attachments: event.attachments });
				break;
			case "message.delta": {
				const key = `message:${event.itemId}`;
				const current = find(key);
				const text = current?.kind === "assistant" ? current.text + event.text : event.text;
				put({ kind: "assistant", key, text, streaming: true });
				break;
			}
			case "message.completed":
				put({ kind: "assistant", key: `message:${event.itemId}`, text: event.text, streaming: false });
				break;
			case "tool.started":
				put({ kind: "tool", key: `tool:${event.itemId}`, tool: event.tool, status: "running", output: null });
				break;
			case "tool.completed":
				put({
					kind: "tool",
					key: `tool:${event.itemId}`,
					tool: event.tool,
					status: event.status,
					output: event.output,
				});
				break;
			case "approval.requested":
				put({
					kind: "approval",
					key: `approval:${event.requestId}`,
					requestId: event.requestId,
					approvalKind: event.kind,
					summary: event.summary,
					reason: event.reason,
					choices: event.choices,
					outcome: null,
				});
				break;
			case "approval.resolved": {
				const current = find(`approval:${event.requestId}`);
				if (current?.kind === "approval") put({ ...current, outcome: event.outcome });
				else earlierOutcomes = { ...earlierOutcomes, [event.requestId]: event.outcome };
				break;
			}
			case "turn.completed":
				for (const [index, item] of items.entries()) {
					if (item.kind === "assistant" && item.streaming) items[index] = { ...item, streaming: false };
				}
				if (event.result.status === "interrupted") {
					put({ kind: "notice", key: `turn:${event.turnId}`, tone: "warning", text: "Interrupted" });
				} else if (event.result.status === "failed") {
					put({ kind: "notice", key: `turn:${event.turnId}`, tone: "error", text: event.result.message });
				}
				break;
			case "error":
				put({
					kind: "notice",
					key: `error:${sequence ?? items.length}`,
					tone: event.willRetry ? "warning" : "error",
					text: event.message,
				});
				break;
			case "usage.updated":
				usage = { contextTokens: event.contextTokens, contextWindow: event.contextWindow };
				break;
			case "rateLimit.updated": {
				const { type: _, ...limit } = event;
				rateLimit = limit;
				break;
			}
			case "session.started":
				break;
		}
	}
	return {
		sessionId: state.sessionId,
		items,
		positions,
		lastSequence,
		firstSequence,
		earlierOutcomes,
		usage,
		rateLimit,
	};
};

// Puts an older page of stored events before what the chat holds. An item both parts touch, like a tool
// started before the page boundary and finished after it, keeps its older place and its newer state.
export const prependEvents = (state: ChatState, older: ReadonlyArray<SessionEvent>): ChatState => {
	const earlier = applyEvents(emptyChat(state.sessionId), older);
	const items = earlier.items.slice();
	const positions: Record<string, number> = { ...earlier.positions };
	for (const item of state.items) {
		const at = positions[item.key];
		if (at === undefined) {
			positions[item.key] = items.length;
			items.push(item);
		} else {
			items[at] = item;
		}
	}
	const unmatched: Record<string, ApprovalOutcome> = {};
	for (const [requestId, outcome] of Object.entries(state.earlierOutcomes)) {
		const at = positions[`approval:${requestId}`];
		const item = at === undefined ? undefined : items[at];
		if (at !== undefined && item?.kind === "approval") items[at] = { ...item, outcome };
		else unmatched[requestId] = outcome;
	}
	return {
		...state,
		items,
		positions,
		firstSequence: earlier.firstSequence ?? state.firstSequence,
		earlierOutcomes: { ...earlier.earlierOutcomes, ...unmatched },
		usage: state.usage ?? earlier.usage,
		rateLimit: state.rateLimit ?? earlier.rateLimit,
	};
};
