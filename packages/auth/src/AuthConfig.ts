import { Config, Context, Effect, Layer, type Redacted } from "effect";

interface OAuthClient {
	readonly clientId: string;
	readonly clientSecret: Redacted.Redacted<string>;
}

const oauthClient = (prefix: string) =>
	Config.all({
		clientId: Config.String(`${prefix}_CLIENT_ID`),
		clientSecret: Config.Redacted(`${prefix}_CLIENT_SECRET`),
	});

export class AuthConfig extends Context.Service<
	AuthConfig,
	{
		// Public URL of the API that serves Better Auth, for example https://api.swarm.dev.
		readonly baseUrl: string;
		// Origin of the static web app that hosts sign-in, device approval and invite pages.
		readonly webOrigin: string;
		readonly secret: Redacted.Redacted<string>;
		readonly databaseUrl: Redacted.Redacted<string>;
		readonly github: OAuthClient;
		readonly google: OAuthClient;
	}
>()("swarm/auth/AuthConfig") {
	static readonly layer = Layer.effect(
		AuthConfig,
		Effect.gen(function* () {
			const config = yield* Config.all({
				baseUrl: Config.String("BETTER_AUTH_URL"),
				webOrigin: Config.String("WEB_ORIGIN"),
				secret: Config.Redacted("BETTER_AUTH_SECRET"),
				databaseUrl: Config.Redacted("DATABASE_URL"),
				github: oauthClient("GITHUB"),
				google: oauthClient("GOOGLE"),
			});
			return AuthConfig.of(config);
		}),
	);
}
