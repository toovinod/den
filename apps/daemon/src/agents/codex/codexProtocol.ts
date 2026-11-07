import { AgentProtocolError } from "../AgentAdapter.ts";
import { Effect, Schema } from "effect";

// The fields Den reads from Codex app-server messages. The full shapes are the generated
// types in ./generated. Extra fields are ignored, so Codex can add fields without breaking us.

export const ThreadResponse = Schema.Struct({
	thread: Schema.Struct({ id: Schema.String }),
});

export const TurnResponse = Schema.Struct({
	turn: Schema.Struct({ id: Schema.String }),
});

export const AccountResponse = Schema.Struct({
	account: Schema.NullOr(
		Schema.Union([
			Schema.Struct({
				type: Schema.Literal("chatgpt"),
				email: Schema.NullOr(Schema.String),
			}),
			Schema.Struct({ type: Schema.String }),
		]),
	),
	requiresOpenaiAuth: Schema.Boolean,
});

export const ModelListResponse = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			displayName: Schema.String,
			description: Schema.String,
			supportedReasoningEfforts: Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
			defaultReasoningEffort: Schema.String,
			inputModalities: Schema.Array(Schema.String),
			isDefault: Schema.Boolean,
		}),
	),
	nextCursor: Schema.NullOr(Schema.String),
});

export const LoginResponse = Schema.Struct({ authUrl: Schema.String });

export const AgentMessageDelta = Schema.Struct({
	itemId: Schema.String,
	delta: Schema.String,
});

const Status = Schema.Literals(["inProgress", "completed", "failed", "declined"]);

export const ThreadItem = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("agentMessage"),
		id: Schema.String,
		text: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("commandExecution"),
		id: Schema.String,
		command: Schema.String,
		cwd: Schema.String,
		status: Status,
		aggregatedOutput: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("fileChange"),
		id: Schema.String,
		changes: Schema.Array(
			Schema.Struct({
				path: Schema.String,
				kind: Schema.Struct({
					type: Schema.Literals(["add", "delete", "update"]),
				}),
				diff: Schema.String,
			}),
		),
		status: Status,
	}),
	Schema.Struct({
		type: Schema.Literal("mcpToolCall"),
		id: Schema.String,
		server: Schema.String,
		tool: Schema.String,
		status: Status,
		error: Schema.NullOr(Schema.Struct({ message: Schema.String })),
	}),
	Schema.Struct({ type: Schema.String, id: Schema.String }),
]);
export type ThreadItem = typeof ThreadItem.Type;

export const ItemNotification = Schema.Struct({ item: ThreadItem });

export const TurnCompleted = Schema.Struct({
	turn: Schema.Struct({
		id: Schema.String,
		status: Schema.Literals(["completed", "interrupted", "failed", "inProgress"]),
		error: Schema.NullOr(Schema.Struct({ message: Schema.String })),
	}),
});

export const TokenUsageUpdated = Schema.Struct({
	tokenUsage: Schema.Struct({
		last: Schema.Struct({ totalTokens: Schema.Int }),
		modelContextWindow: Schema.NullOr(Schema.Int),
	}),
});

const RateLimitWindow = Schema.NullOr(
	Schema.Struct({
		usedPercent: Schema.Number,
		windowDurationMins: Schema.NullOr(Schema.Number),
		resetsAt: Schema.NullOr(Schema.Number),
	}),
);

export const RateLimitsUpdated = Schema.Struct({
	rateLimits: Schema.Struct({
		primary: RateLimitWindow,
		secondary: RateLimitWindow,
		rateLimitReachedType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	}),
});

export const ErrorNotification = Schema.Struct({
	error: Schema.Struct({ message: Schema.String }),
	willRetry: Schema.Boolean,
});

const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

export const CommandApprovalParams = Schema.Struct({
	itemId: Schema.String,
	command: optionalText,
	reason: optionalText,
});

export const FileChangeApprovalParams = Schema.Struct({
	itemId: Schema.String,
	reason: optionalText,
	grantRoot: optionalText,
});

export const decodeCodex =
	<S extends Schema.Codec<unknown, unknown>>(schema: S) =>
	(value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				(cause) =>
					new AgentProtocolError({
						message: "Codex sent a message Den could not read.",
						cause,
					}),
			),
		);
