import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { AgentKind } from "@repo/contracts/AgentSession";

export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()("CredentialStoreError", {
	cause: Schema.Defect(),
}) {}

// One OS keychain entry per agent, named after the agent kind.
const KEYCHAIN_SERVICE = "app.swarm.agent";

const keychain = <A>(run: (secrets: typeof Bun.secrets) => Promise<A>) =>
	Effect.tryPromise({
		try: () => run(Bun.secrets),
		catch: (cause) => new CredentialStoreError({ cause }),
	});

// Agent API keys. They stay Redacted everywhere in the daemon and never reach the database or logs.
export class CredentialStore extends Context.Service<
	CredentialStore,
	{
		get(agent: AgentKind): Effect.Effect<Option.Option<Redacted.Redacted<string>>, CredentialStoreError>;
		set(agent: AgentKind, apiKey: Redacted.Redacted<string>): Effect.Effect<void, CredentialStoreError>;
		remove(agent: AgentKind): Effect.Effect<void, CredentialStoreError>;
	}
>()("swarm/daemon/agents/CredentialStore") {
	static readonly layer = Layer.succeed(
		CredentialStore,
		CredentialStore.of({
			get: (agent) =>
				keychain((secrets) => secrets.get({ service: KEYCHAIN_SERVICE, name: agent })).pipe(
					Effect.map((value) => Option.map(Option.fromNullishOr(value), Redacted.make)),
				),
			set: (agent, apiKey) =>
				keychain((secrets) => secrets.set({ service: KEYCHAIN_SERVICE, name: agent, value: Redacted.value(apiKey) })),
			remove: (agent) =>
				Effect.asVoid(keychain((secrets) => secrets.delete({ service: KEYCHAIN_SERVICE, name: agent }))),
		}),
	);
}
