import { CredentialStore } from "../agents/CredentialStore.ts";
import { Effect, Layer, Option, type Redacted } from "effect";
import type { AgentKind } from "@repo/contracts/AgentSession";

// Tests never touch the real keychain.
export const memoryCredentialStore = Layer.sync(CredentialStore, () => {
	const keys = new Map<AgentKind, Redacted.Redacted<string>>();
	return CredentialStore.of({
		get: (agent) => Effect.sync(() => Option.fromNullishOr(keys.get(agent))),
		set: (agent, apiKey) => Effect.sync(() => void keys.set(agent, apiKey)),
		remove: (agent) => Effect.sync(() => void keys.delete(agent)),
	});
});
