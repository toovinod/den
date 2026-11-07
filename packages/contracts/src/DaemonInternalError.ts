import { Schema } from "effect";

// Unexpected failures (database, git plumbing) reach the UI as this error only.
// The raw cause stays in the daemon logs.
export class DaemonInternalError extends Schema.TaggedError<DaemonInternalError>()("DaemonInternalError", {
	operation: Schema.String,
}) {
	override get message() {
		return `Den could not ${this.operation}. Try again, and check the daemon logs if it keeps failing.`;
	}
}
