import { Cause, Config, Duration, Effect, Exit, Layer, Runtime } from "effect";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { MembershipEvents } from "@repo/auth/MembershipEvents";
import { EmailService } from "@repo/email/EmailService";
import { HttpEffect, HttpServer } from "effect/http";
import { AuthConfig } from "@repo/auth/AuthConfig";
import { createApp } from "./createApp.ts";
import { Auth } from "@repo/auth/Auth";

const AppLayer = Auth.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(AuthConfig.layer, EmailService.layer, MembershipEvents.layer)),
);

// On SIGTERM or SIGINT the runtime interrupts the app: the server stops accepting connections and
// waits up to the grace period for requests in flight, then the database client closes.
// If cleanup still hangs at the deadline, or a second signal arrives, the process exits at once,
// before the platform's own SIGKILL can cut a log line or a query in half.
const exitIfShutdownHangs = (deadline: Duration.Duration) =>
	Effect.sync(() => {
		let stopping = false;
		const onSignal = (signal: NodeJS.Signals) => {
			if (stopping) {
				console.error(`Received ${signal} again, exiting now`);
				process.exit(1);
			}
			stopping = true;
			console.log(`Received ${signal}, shutting down`);
			setTimeout(() => {
				console.error(`Shutdown took longer than ${Duration.format(deadline)}, exiting`);
				process.exit(1);
			}, Duration.toMillis(deadline)).unref();
		};
		process.on("SIGTERM", onSignal);
		process.on("SIGINT", onSignal);
	});

const ApiServer = Layer.unwrap(
	Effect.gen(function* () {
		const { webOrigin } = yield* AuthConfig;
		const { handler } = yield* Auth;
		const port = yield* Config.Port("API_PORT").pipe(Config.withDefault(3001));
		// Keep it below the platform's stop timeout so requests finish before the SIGKILL.
		const grace = yield* Config.Duration("API_SHUTDOWN_GRACE").pipe(Config.withDefault(Duration.seconds(10)));
		yield* exitIfShutdownHangs(Duration.sum(grace, Duration.seconds(5)));
		yield* Effect.addFinalizer(() => Effect.logInfo("API stopped"));
		const app = createApp({ webOrigin, authHandler: handler });
		return HttpServer.serve(HttpEffect.fromWebHandler(async (request) => app.fetch(request))).pipe(
			HttpServer.withLogAddress,
			Layer.provide(BunHttpServer.layer({ port, gracefulShutdownTimeout: grace })),
		);
	}),
);

// A shutdown asked for by a signal is a clean stop, so it exits 0 instead of the default 130.
BunRuntime.runMain(Layer.launch(ApiServer.pipe(Layer.provide(AppLayer))), {
	teardown: (exit, onExit) =>
		Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit),
});
