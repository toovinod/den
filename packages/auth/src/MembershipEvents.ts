import { Context, Effect, Layer, PubSub, Schema, type Scope } from "effect";

// Published when someone loses or changes access to an org, so live connections
// (the relay, later) can be revoked without waiting for a session to expire.
export const MembershipEvent = Schema.Union([
	Schema.TaggedStruct("memberRemoved", {
		organizationId: Schema.String,
		userId: Schema.String,
	}),
	Schema.TaggedStruct("memberRoleChanged", {
		organizationId: Schema.String,
		userId: Schema.String,
		previousRole: Schema.String,
		role: Schema.String,
	}),
	Schema.TaggedStruct("invitationRevoked", {
		organizationId: Schema.String,
		invitationId: Schema.String,
	}),
	Schema.TaggedStruct("organizationDeleted", {
		organizationId: Schema.String,
	}),
]);
export type MembershipEvent = typeof MembershipEvent.Type;

export class MembershipEvents extends Context.Service<
	MembershipEvents,
	{
		publish(event: MembershipEvent): Effect.Effect<void>;
		readonly subscribe: Effect.Effect<
			PubSub.Subscription<MembershipEvent>,
			never,
			Scope.Scope
		>;
	}
>()("swarm/auth/MembershipEvents") {
	static readonly layer = Layer.effect(
		MembershipEvents,
		Effect.gen(function* () {
			const pubsub = yield* Effect.acquireRelease(
				PubSub.unbounded<MembershipEvent>(),
				PubSub.shutdown,
			);
			return MembershipEvents.of({
				publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
				subscribe: PubSub.subscribe(pubsub),
			});
		}),
	);
}
