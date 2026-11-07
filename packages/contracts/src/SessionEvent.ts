import { AgentEvent } from "./AgentEvent.ts";
import { Schema } from "effect";

// sequence is null for live-only events such as message deltas, which are never stored.
export class SessionEvent extends Schema.Class<SessionEvent>("SessionEvent")({
	sessionId: Schema.String,
	sequence: Schema.NullOr(Schema.Int),
	event: AgentEvent,
	createdAt: Schema.String,
}) {}
