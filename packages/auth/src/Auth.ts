import { authRelations } from "@repo/db-cloud/authSchema";
import { EmailService } from "@repo/email/EmailService";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Context, Effect, Layer, Redacted } from "effect";
import { AuthConfig } from "./AuthConfig.ts";
import { createAuth } from "./createAuth.ts";
import { MembershipEvents } from "./MembershipEvents.ts";

export class Auth extends Context.Service<
	Auth,
	{
		readonly handler: (request: Request) => Promise<Response>;
	}
>()("swarm/auth/Auth") {
	static readonly layer = Layer.effect(
		Auth,
		Effect.gen(function* () {
			const config = yield* AuthConfig;
			const email = yield* EmailService;
			const membershipEvents = yield* MembershipEvents;
			// Better Auth's callbacks are promise based, so they run here with this layer's services.
			const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

			// Better Auth needs a promise-based Drizzle client. Our own queries use CloudDatabase.
			const client = yield* Effect.acquireRelease(
				Effect.sync(() => new SQL(Redacted.value(config.databaseUrl))),
				(client) => Effect.promise(() => client.close()),
			);

			const auth = createAuth({
				config,
				database: drizzle({ client, relations: authRelations }),
				sendInvitation: (input) => runPromise(email.sendInvitation(input)),
				publishMembershipEvent: (event) =>
					runPromise(membershipEvents.publish(event)),
			});
			return Auth.of({ handler: auth.handler });
		}),
	);
}
