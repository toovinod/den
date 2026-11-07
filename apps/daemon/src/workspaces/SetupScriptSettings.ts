import { Context, Duration } from "effect";

export const SetupScriptSettings = Context.Reference<{
	// A run that takes longer is killed and counts as a retryable failure.
	readonly timeout: Duration.Duration;
	// Attempts before the run moves to deadLetter.
	readonly maxAttempts: number;
	// First retry delay. Later ones grow exponentially, with jitter.
	readonly retryBaseDelay: Duration.Duration;
}>("swarm/daemon/workspaces/SetupScriptSettings", {
	defaultValue: () => ({
		timeout: Duration.minutes(15),
		maxAttempts: 3,
		retryBaseDelay: Duration.seconds(2),
	}),
});
