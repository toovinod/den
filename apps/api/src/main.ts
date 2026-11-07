import { Config, Effect, Layer, ManagedRuntime } from "effect";
import { MembershipEvents } from "@repo/auth/MembershipEvents";
import { EmailService } from "@repo/email/EmailService";
import { AuthConfig } from "@repo/auth/AuthConfig";
import { createApp } from "./createApp.ts";
import { Auth } from "@repo/auth/Auth";

const AppLayer = Auth.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(AuthConfig.layer, EmailService.layer, MembershipEvents.layer)),
);

const runtime = ManagedRuntime.make(AppLayer);

const { app, port } = await runtime.runPromise(
	Effect.gen(function* () {
		const { webOrigin } = yield* AuthConfig;
		const { handler } = yield* Auth;
		const port = yield* Config.Port("API_PORT").pipe(Config.withDefault(3001));
		return { app: createApp({ webOrigin, authHandler: handler }), port };
	}),
);

const server = Bun.serve({ port, fetch: app.fetch });
await runtime.runPromise(Effect.log(`API listening on ${server.url}`));

const shutdown = () => {
	void server.stop().then(() => runtime.dispose());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
