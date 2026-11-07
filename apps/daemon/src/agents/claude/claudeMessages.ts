import { Schema } from "effect";

// The fields Swarm reads from Agent SDK messages. Extra fields are ignored, and the last
// member of each union catches kinds Swarm does not use yet.

const Other = Schema.Struct({ type: Schema.String });

const StreamEvent = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("message_start"),
		message: Schema.Struct({ id: Schema.String }),
	}),
	Schema.Struct({
		type: Schema.Literal("content_block_delta"),
		index: Schema.Number,
		delta: Schema.Union([
			Schema.Struct({
				type: Schema.Literal("text_delta"),
				text: Schema.String,
			}),
			Other,
		]),
	}),
	Other,
]);

const AssistantBlock = Schema.Union([
	Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("tool_use"),
		id: Schema.String,
		name: Schema.String,
		input: Schema.Unknown,
	}),
	Other,
]);

const ToolResultContent = Schema.Union([
	Schema.String,
	Schema.Array(
		Schema.Union([
			Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
			Other,
		]),
	),
]);

const UserBlock = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("tool_result"),
		tool_use_id: Schema.String,
		content: Schema.optionalKey(ToolResultContent),
		is_error: Schema.optionalKey(Schema.Boolean),
	}),
	Other,
]);

const parentToolUseId = Schema.NullOr(Schema.String);

export const ClaudeMessage = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("system"),
		subtype: Schema.Literal("init"),
		session_id: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("stream_event"),
		parent_tool_use_id: parentToolUseId,
		event: StreamEvent,
	}),
	Schema.Struct({
		type: Schema.Literal("assistant"),
		parent_tool_use_id: parentToolUseId,
		message: Schema.Struct({
			id: Schema.String,
			content: Schema.Array(AssistantBlock),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("user"),
		parent_tool_use_id: parentToolUseId,
		message: Schema.Struct({
			content: Schema.Union([Schema.String, Schema.Array(UserBlock)]),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("result"),
		subtype: Schema.String,
		uuid: Schema.String,
		errors: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	Other,
]);
export type ClaudeMessage = typeof ClaudeMessage.Type;

export const BashInput = Schema.Struct({ command: Schema.String });
export const FileInput = Schema.Union([
	Schema.Struct({ file_path: Schema.String }),
	Schema.Struct({ notebook_path: Schema.String }),
]);

export const ClaudeAuthStatus = Schema.Struct({
	loggedIn: Schema.Boolean,
	authMethod: Schema.optionalKey(Schema.String),
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
