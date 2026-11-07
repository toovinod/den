import { Schema } from "effect";

// Normalized agent events. The shape follows the Codex app-server protocol, the richer of the two,
// and the Claude adapter maps its SDK messages onto it.

export const ApprovalDecision = Schema.Literals([
	"allowOnce",
	"allowForSession",
	"deny",
]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

// How an approval ended: a user decision, or cancelled because the turn was interrupted.
export const ApprovalOutcome = Schema.Union([
	ApprovalDecision,
	Schema.Literal("cancelled"),
]);
export type ApprovalOutcome = typeof ApprovalOutcome.Type;

export const FileChange = Schema.Struct({
	path: Schema.String,
	kind: Schema.Literals(["add", "delete", "update"]),
	diff: Schema.String,
});
export type FileChange = typeof FileChange.Type;

export const ToolCall = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("command"),
		command: Schema.String,
		cwd: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("fileChange"),
		changes: Schema.Array(FileChange),
	}),
	Schema.Struct({
		kind: Schema.Literal("mcpCall"),
		server: Schema.String,
		tool: Schema.String,
	}),
	// Tools with no richer shape, such as Claude's Read or WebSearch.
	Schema.Struct({
		kind: Schema.Literal("other"),
		name: Schema.String,
	}),
]);
export type ToolCall = typeof ToolCall.Type;
export type ToolKind = ToolCall["kind"];

export const TurnResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed") }),
	Schema.Struct({ status: Schema.Literal("interrupted") }),
	Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
]);
export type TurnResult = typeof TurnResult.Type;

export const AgentEvent = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("session.started"),
		nativeSessionId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("message.delta"),
		itemId: Schema.String,
		text: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("message.completed"),
		itemId: Schema.String,
		text: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("tool.started"),
		itemId: Schema.String,
		tool: ToolCall,
	}),
	Schema.Struct({
		type: Schema.Literal("tool.completed"),
		itemId: Schema.String,
		tool: ToolCall,
		status: Schema.Literals(["completed", "failed", "declined"]),
		// Trimmed to the tail the adapter keeps, never the whole output.
		output: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("approval.requested"),
		requestId: Schema.String,
		itemId: Schema.String,
		kind: Schema.Literals(["command", "fileChange", "mcpCall", "other"]),
		summary: Schema.String,
		reason: Schema.NullOr(Schema.String),
		choices: Schema.Array(ApprovalDecision),
	}),
	Schema.Struct({
		type: Schema.Literal("approval.resolved"),
		requestId: Schema.String,
		outcome: ApprovalOutcome,
	}),
	Schema.Struct({
		type: Schema.Literal("turn.completed"),
		turnId: Schema.String,
		result: TurnResult,
	}),
	// Non-fatal problems. A fatal one fails the event stream instead.
	Schema.Struct({
		type: Schema.Literal("error"),
		message: Schema.String,
		willRetry: Schema.Boolean,
	}),
]).pipe(Schema.toTaggedUnion("type"));
export type AgentEvent = typeof AgentEvent.Type;
