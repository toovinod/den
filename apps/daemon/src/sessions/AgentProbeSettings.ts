import { Context, Duration } from "effect";

export const AgentProbeSettings = Context.Reference<{
	// How long an agent may take to report its sign-in status or its models. A CLI that hangs
	// then shows as unavailable instead of keeping the app from loading.
	readonly timeout: Duration.Duration;
}>("den/daemon/sessions/AgentProbeSettings", {
	defaultValue: () => ({ timeout: Duration.seconds(15) }),
});
