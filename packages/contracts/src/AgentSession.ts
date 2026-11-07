import { Schema } from "effect";

export const AgentKind = Schema.Literals(["claude", "codex"]);
export type AgentKind = typeof AgentKind.Type;

export const AgentAuthMode = Schema.Literals(["subscription", "apiKey"]);
export type AgentAuthMode = typeof AgentAuthMode.Type;

// Agent sessions are not jobs, so they keep their own union.
export const AgentSessionStatus = Schema.Literals(["idle", "running", "awaitingApproval", "interrupted", "failed"]);
export type AgentSessionStatus = typeof AgentSessionStatus.Type;

export class AgentSession extends Schema.Class<AgentSession>("AgentSession")({
	id: Schema.String,
	workspaceId: Schema.String,
	agent: AgentKind,
	model: Schema.String,
	nativeSessionId: Schema.NullOr(Schema.String),
	authMode: AgentAuthMode,
	// Effort names differ per agent and model, so they come from AgentModel.efforts.
	effort: Schema.NullOr(Schema.String),
	status: AgentSessionStatus,
	title: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
}) {}

export const AgentModel = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	description: Schema.String,
	efforts: Schema.Array(Schema.String),
	defaultEffort: Schema.NullOr(Schema.String),
	contextWindow: Schema.NullOr(Schema.Int),
	supportsImages: Schema.Boolean,
});
export type AgentModel = typeof AgentModel.Type;

export const AgentCapabilities = Schema.Struct({
	resume: Schema.Boolean,
	interrupt: Schema.Boolean,
	fileChangeApprovals: Schema.Boolean,
	mcpApprovals: Schema.Boolean,
	steerWhileRunning: Schema.Boolean,
});
export type AgentCapabilities = typeof AgentCapabilities.Type;

export const AgentAvailability = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), account: Schema.NullOr(Schema.String) }),
	Schema.Struct({ status: Schema.Literal("needsApiKey") }),
	Schema.Struct({ status: Schema.Literal("loggedOut") }),
	Schema.Struct({ status: Schema.Literal("notInstalled") }),
	Schema.Struct({ status: Schema.Literal("versionMismatch"), expected: Schema.String, actual: Schema.String }),
	Schema.Struct({ status: Schema.Literal("unknown"), message: Schema.String }),
]);
export type AgentAvailability = typeof AgentAvailability.Type;

export class AgentInfo extends Schema.Class<AgentInfo>("AgentInfo")({
	kind: AgentKind,
	availability: AgentAvailability,
	capabilities: AgentCapabilities,
	// The modes the user may pick. Claude offers only apiKey until Anthropic approves subscription use (architecture 2.1).
	authModes: Schema.Array(AgentAuthMode),
	authMode: AgentAuthMode,
	models: Schema.Array(AgentModel),
	defaultModel: Schema.String,
}) {}

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()("SessionNotFoundError", {
	sessionId: Schema.String,
}) {
	override get message() {
		return "This chat no longer exists. Refresh the chat list.";
	}
}

export class SessionLimitReachedError extends Schema.TaggedError<SessionLimitReachedError>()(
	"SessionLimitReachedError",
	{ limit: Schema.Int },
) {
	override get message() {
		return `${this.limit} agents are already working. Stop one or wait for a turn to finish.`;
	}
}

// Retryable: a turn is running and the message queue is full.
export class SessionBusyError extends Schema.TaggedError<SessionBusyError>()("SessionBusyError", {
	queued: Schema.Int,
}) {
	override get message() {
		return `The agent is busy and ${this.queued} message(s) are already queued. Wait for the turn to finish.`;
	}
}

export class ApprovalNotFoundError extends Schema.TaggedError<ApprovalNotFoundError>()("ApprovalNotFoundError", {
	requestId: Schema.String,
}) {
	override get message() {
		return "This approval request was already answered or has expired.";
	}
}

export class AgentUnavailableError extends Schema.TaggedError<AgentUnavailableError>()("AgentUnavailableError", {
	agent: AgentKind,
	availability: AgentAvailability,
}) {
	override get message() {
		const name = this.agent === "claude" ? "Claude Code" : "Codex";
		switch (this.availability.status) {
			case "needsApiKey":
				return `${name} needs an API key. Add one in Settings.`;
			case "loggedOut":
				return `${name} is not signed in. Sign in with its CLI, then try again.`;
			case "notInstalled":
				return `${name} is not installed. Install it, then try again.`;
			case "versionMismatch":
				return `${name} ${this.availability.actual} is installed, but Swarm needs ${this.availability.expected}.`;
			case "unknown":
				return `${name} could not start: ${this.availability.message}`;
		}
		return `${name} could not start. Try again.`;
	}
}

// The subscriber fell too far behind the live stream. Subscribe again from lastSequence.
export class ResubscribeRequiredError extends Schema.TaggedError<ResubscribeRequiredError>()(
	"ResubscribeRequiredError",
	{ lastSequence: Schema.Int },
) {
	override get message() {
		return "The chat fell behind and is reloading.";
	}
}

export const ImageMediaType = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageMediaType = typeof ImageMediaType.Type;

// 5 MB of image data as base64.
export const MAX_IMAGE_BASE64_LENGTH = 7_000_000;
export const MAX_IMAGES_PER_MESSAGE = 10;

export const ImageData = Schema.Struct({
	mediaType: ImageMediaType,
	base64: Schema.String.check(Schema.isMaxLength(MAX_IMAGE_BASE64_LENGTH)),
});
export type ImageData = typeof ImageData.Type;

export class AttachmentNotFoundError extends Schema.TaggedError<AttachmentNotFoundError>()("AttachmentNotFoundError", {
	attachmentId: Schema.String,
}) {
	override get message() {
		return "This image is no longer available.";
	}
}

export class AuthModeNotAllowedError extends Schema.TaggedError<AuthModeNotAllowedError>()("AuthModeNotAllowedError", {
	agent: AgentKind,
	mode: AgentAuthMode,
}) {
	override get message() {
		return this.agent === "claude"
			? "Claude subscriptions cannot be used in other apps yet. Add an Anthropic API key instead."
			: `Codex cannot use ${this.mode} sign-in here.`;
	}
}
