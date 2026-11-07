import type {
	AgentAuthMode,
	AgentCapabilities,
	AgentInfo,
	ImageMediaType,
	AgentKind,
	ApprovalNotFoundError,
	SessionBusyError,
} from "@repo/contracts/AgentSession";
import type { AgentEvent, ApprovalDecision } from "@repo/contracts/AgentEvent";
import { type Effect, Schema, type Scope, type Stream } from "effect";

export const StartSessionInput = Schema.Struct({
	cwd: Schema.String,
	model: Schema.String,
	// Effort names differ per agent. Adapters ignore one their agent does not know.
	effort: Schema.NullOr(Schema.String),
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

export const AgentAuthStatus = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("loggedIn"),
		account: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({ status: Schema.Literal("loggedOut") }),
	Schema.Struct({ status: Schema.Literal("unknown") }),
]);
export type AgentAuthStatus = typeof AgentAuthStatus.Type;

// Retryable: the agent process died or could not be reached, or the session is busy.
export class AgentProcessError extends Schema.TaggedError<AgentProcessError>()("AgentProcessError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export class AgentNotInstalledError extends Schema.TaggedError<AgentNotInstalledError>()("AgentNotInstalledError", {
	executable: Schema.String,
}) {}

export class AgentProtocolError extends Schema.TaggedError<AgentProtocolError>()("AgentProtocolError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export class CodexVersionMismatchError extends Schema.TaggedError<CodexVersionMismatchError>()(
	"CodexVersionMismatchError",
	{ expected: Schema.String, actual: Schema.String },
) {}

export class ApprovalChoiceError extends Schema.TaggedError<ApprovalChoiceError>()("ApprovalChoiceError", {
	requestId: Schema.String,
	decision: Schema.String,
}) {}

export type AgentError = AgentProcessError | AgentNotInstalledError | AgentProtocolError | CodexVersionMismatchError;

type SendMessageError = AgentError | SessionBusyError;
type ApprovalError = AgentError | ApprovalNotFoundError | ApprovalChoiceError;

export type AgentModels = Pick<AgentInfo, "models" | "defaultModel">;

export interface SessionSettings {
	readonly model: string;
	readonly effort: string | null;
}

export interface UserImage {
	readonly id: string;
	readonly mediaType: ImageMediaType;
	readonly base64: string;
	// Where the daemon stored it, for agents that read images from disk.
	readonly path: string;
}

export interface UserMessage {
	readonly id: string;
	readonly text: string;
	readonly images: ReadonlyArray<UserImage>;
}

export interface AgentSessionHandle {
	// Waits until the agent reports its id, which may only happen after the first message.
	readonly nativeSessionId: Effect.Effect<string, AgentError>;
	readonly events: Stream.Stream<AgentEvent, AgentError>;
	// Says whether the text went into the running turn or waits for its own turn.
	sendMessage(
		message: UserMessage,
		options?: { readonly steer?: boolean },
	): Effect.Effect<"steered" | "queued", SendMessageError>;
	respondToApproval(requestId: string, decision: ApprovalDecision): Effect.Effect<void, ApprovalError>;
	// Cancels pending approvals first, then stops the running turn.
	readonly interrupt: Effect.Effect<void, AgentError>;
	// Applies from the next turn.
	updateSettings(settings: SessionSettings): Effect.Effect<void, AgentError>;
}

export interface AgentAdapter {
	readonly kind: AgentKind;
	readonly capabilities: AgentCapabilities;
	// The auth modes the user may pick, the default first.
	readonly authModes: ReadonlyArray<AgentAuthMode>;
	readonly checkAuth: Effect.Effect<AgentAuthStatus, AgentError>;
	readonly listModels: Effect.Effect<AgentModels, AgentError>;
	startSession(input: StartSessionInput): Effect.Effect<AgentSessionHandle, AgentError, Scope.Scope>;
}
