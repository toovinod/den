import {
	AgentAuthMode,
	AgentInfo,
	AgentKind,
	AttachmentNotFoundError,
	AuthModeNotAllowedError,
	ImageData,
	ImagesNotSupportedError,
	MAX_IMAGES_PER_MESSAGE,
	AgentSession,
	AgentUnavailableError,
	ApprovalNotFoundError,
	ResubscribeRequiredError,
	SessionBusyError,
	SessionLimitReachedError,
	SessionNotFoundError,
} from "./AgentSession.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { WorkspaceNotFoundError } from "./Workspace.ts";
import { ApprovalDecision } from "./AgentEvent.ts";
import { SessionEvent } from "./SessionEvent.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

export class SessionRpcs extends RpcGroup.make(
	Rpc.make("listAgents", {
		success: Schema.Array(AgentInfo),
		error: DaemonInternalError,
	}),
	// The key travels only over the local socket and is stored in the OS keychain.
	Rpc.make("setAgentApiKey", {
		payload: { agent: AgentKind, apiKey: Schema.Redacted(Schema.String) },
		error: DaemonInternalError,
	}),
	Rpc.make("removeAgentApiKey", {
		payload: { agent: AgentKind },
		error: DaemonInternalError,
	}),
	// Applies to new sessions only. Running sessions keep the credential they started with.
	Rpc.make("setAgentAuthMode", {
		payload: { agent: AgentKind, mode: AgentAuthMode },
		error: Schema.Union([AuthModeNotAllowedError, DaemonInternalError]),
	}),
	// Codex only: starts its own ChatGPT sign-in and returns the URL to open. Codex keeps the tokens.
	Rpc.make("startAgentLogin", {
		payload: { agent: AgentKind },
		success: Schema.Struct({ authUrl: Schema.String }),
		error: Schema.Union([AuthModeNotAllowedError, DaemonInternalError]),
	}),
	// The agent process starts on the first message.
	Rpc.make("createSession", {
		payload: {
			workspaceId: Schema.String,
			agent: AgentKind,
			model: Schema.String,
			effort: Schema.NullOr(Schema.String),
		},
		success: AgentSession,
		error: Schema.Union([WorkspaceNotFoundError, DaemonInternalError]),
	}),
	Rpc.make("listSessions", {
		payload: { workspaceId: Schema.String },
		success: Schema.Array(AgentSession),
		error: DaemonInternalError,
	}),
	Rpc.make("renameSession", {
		payload: { sessionId: Schema.String, title: Schema.String },
		success: AgentSession,
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// Takes effect from the next turn.
	Rpc.make("updateSessionSettings", {
		payload: { sessionId: Schema.String, model: Schema.String, effort: Schema.NullOr(Schema.String) },
		success: AgentSession,
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// steer sends the text into the running turn when the agent supports it, otherwise it queues.
	Rpc.make("sendMessage", {
		payload: {
			sessionId: Schema.String,
			text: Schema.String,
			images: Schema.Array(ImageData).check(Schema.isMaxLength(MAX_IMAGES_PER_MESSAGE)),
			steer: Schema.Boolean,
		},
		error: Schema.Union([
			SessionNotFoundError,
			SessionLimitReachedError,
			SessionBusyError,
			AgentUnavailableError,
			ImagesNotSupportedError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("getAttachment", {
		payload: { sessionId: Schema.String, attachmentId: Schema.String },
		success: ImageData,
		error: Schema.Union([SessionNotFoundError, AttachmentNotFoundError, DaemonInternalError]),
	}),
	Rpc.make("respondToApproval", {
		payload: { sessionId: Schema.String, requestId: Schema.String, decision: ApprovalDecision },
		error: Schema.Union([SessionNotFoundError, ApprovalNotFoundError, DaemonInternalError]),
	}),
	// Stops the running turn and keeps the agent process.
	Rpc.make("interruptSession", {
		payload: { sessionId: Schema.String },
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// Ends the agent process. The next message resumes through the native session id.
	Rpc.make("stopSession", {
		payload: { sessionId: Schema.String },
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// Stored events after afterSequence, then live events. -1 starts from the beginning.
	Rpc.make("subscribeSession", {
		payload: { sessionId: Schema.String, afterSequence: Schema.Int },
		success: SessionEvent,
		error: Schema.Union([SessionNotFoundError, ResubscribeRequiredError, DaemonInternalError]),
		stream: true,
	}),
	// Every session change (status, title, native id) across all workspaces.
	Rpc.make("watchSessions", {
		success: AgentSession,
		error: DaemonInternalError,
		stream: true,
	}),
) {}
