import type { AgentEvent, ApprovalDecision } from "@repo/contracts/AgentEvent";
import { type Effect, Schema, type Scope, type Stream } from "effect";

export const AgentKind = Schema.Literals(["claude", "codex"]);
export type AgentKind = typeof AgentKind.Type;

export const StartSessionInput = Schema.Struct({
	cwd: Schema.String,
	model: Schema.String,
	resumeId: Schema.optionalKey(Schema.String),
	// A repo's own agent settings can add hooks that run commands and allow rules that
	// skip approvals, so they load only when the user has trusted the project.
	trustProjectSettings: Schema.Boolean,
	// Subscription mode uses the CLI's own login. An API key is passed to the child process
	// as an environment variable and nowhere else.
	auth: Schema.Union([
		Schema.Struct({ mode: Schema.Literal("subscription") }),
		Schema.Struct({
			mode: Schema.Literal("apiKey"),
			apiKey: Schema.Redacted(Schema.String),
		}),
	]),
});
export type StartSessionInput = typeof StartSessionInput.Type;

// The native CLI's login state. Swarm never reads the credentials behind it.
export const AgentAuthStatus = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("loggedIn"),
		account: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({ status: Schema.Literal("loggedOut") }),
	Schema.Struct({ status: Schema.Literal("unknown") }),
]);
export type AgentAuthStatus = typeof AgentAuthStatus.Type;

export interface AgentCapabilities {
	readonly resume: boolean;
	readonly interrupt: boolean;
	readonly fileChangeApprovals: boolean;
	readonly mcpApprovals: boolean;
	readonly steerWhileRunning: boolean;
}

// Retryable: the agent process died or could not be reached, or the session is busy.
export class AgentProcessError extends Schema.TaggedError<AgentProcessError>()(
	"AgentProcessError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

// Permanent: the agent CLI is not installed at the configured path.
export class AgentNotInstalledError extends Schema.TaggedError<AgentNotInstalledError>()(
	"AgentNotInstalledError",
	{ executable: Schema.String },
) {}

// Permanent: the agent sent something we cannot decode, or rejected a request.
export class AgentProtocolError extends Schema.TaggedError<AgentProtocolError>()(
	"AgentProtocolError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

// Permanent: the installed Codex differs from the one our protocol types were generated from.
export class CodexVersionMismatchError extends Schema.TaggedError<CodexVersionMismatchError>()(
	"CodexVersionMismatchError",
	{ expected: Schema.String, actual: Schema.String },
) {}

// Retryable: a turn is running and the message queue is full.
export class SessionBusyError extends Schema.TaggedError<SessionBusyError>()(
	"SessionBusyError",
	{ queued: Schema.Number },
) {}

// Permanent: no pending approval has this id.
export class ApprovalNotFoundError extends Schema.TaggedError<ApprovalNotFoundError>()(
	"ApprovalNotFoundError",
	{ requestId: Schema.String },
) {}

// Permanent: the decision is not one of the request's choices.
export class ApprovalChoiceError extends Schema.TaggedError<ApprovalChoiceError>()(
	"ApprovalChoiceError",
	{ requestId: Schema.String, decision: Schema.String },
) {}

export type AgentError =
	| AgentProcessError
	| AgentNotInstalledError
	| AgentProtocolError
	| CodexVersionMismatchError;

export type SendMessageError = AgentError | SessionBusyError;
export type ApprovalError =
	| AgentError
	| ApprovalNotFoundError
	| ApprovalChoiceError;

const retryableTags: ReadonlySet<string> = new Set([
	"AgentProcessError",
	"SessionBusyError",
]);

export const isRetryableAgentError = (
	error: SendMessageError | ApprovalError,
): boolean => retryableTags.has(error._tag);

export interface AgentSessionHandle {
	// Waits until the agent reports its id, which may only happen after the first message.
	readonly nativeSessionId: Effect.Effect<string, AgentError>;
	readonly events: Stream.Stream<AgentEvent, AgentError>;
	// Runs one turn at a time. Later messages queue, or steer the running turn when asked
	// and the adapter supports it.
	sendMessage(
		text: string,
		options?: { readonly steer?: boolean },
	): Effect.Effect<void, SendMessageError>;
	respondToApproval(
		requestId: string,
		decision: ApprovalDecision,
	): Effect.Effect<void, ApprovalError>;
	// Cancels pending approvals first, then stops the running turn.
	readonly interrupt: Effect.Effect<void, AgentError>;
}

export interface AgentAdapter {
	readonly kind: AgentKind;
	readonly capabilities: AgentCapabilities;
	readonly checkAuth: Effect.Effect<AgentAuthStatus, AgentError>;
	startSession(
		input: StartSessionInput,
	): Effect.Effect<AgentSessionHandle, AgentError, Scope.Scope>;
}
