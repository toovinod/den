import {
	AgentInfo,
	AgentKind,
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
	// The agent process starts on the first message.
	Rpc.make("createSession", {
		payload: { workspaceId: Schema.String, agent: AgentKind, model: Schema.String },
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
	// steer sends the text into the running turn when the agent supports it, otherwise it queues.
	Rpc.make("sendMessage", {
		payload: { sessionId: Schema.String, text: Schema.String, steer: Schema.Boolean },
		error: Schema.Union([
			SessionNotFoundError,
			SessionLimitReachedError,
			SessionBusyError,
			AgentUnavailableError,
			DaemonInternalError,
		]),
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
