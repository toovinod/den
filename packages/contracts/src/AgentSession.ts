import { Schema } from "effect";

export const AgentKind = Schema.Literals(["claude", "codex"]);
export type AgentKind = typeof AgentKind.Type;

export const AgentAuthMode = Schema.Literals(["subscription", "apiKey"]);
export type AgentAuthMode = typeof AgentAuthMode.Type;

// Agent sessions are not jobs, so they keep their own union.
export const AgentSessionStatus = Schema.Literals([
	"idle",
	"running",
	"awaitingApproval",
	"interrupted",
	"failed",
]);
export type AgentSessionStatus = typeof AgentSessionStatus.Type;
