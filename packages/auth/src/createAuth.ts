import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import * as authSchema from "@repo/db-cloud/authSchema";
import type { InvitationEmailInput } from "@repo/email/invitationEmail";
import { type Auth, betterAuth } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { Redacted } from "effect";
import type { AuthConfig } from "./AuthConfig.ts";
import type { MembershipEvent } from "./MembershipEvents.ts";
import { membershipHooks } from "./membershipHooks.ts";

export const DESKTOP_CLIENT_ID = "swarm-desktop";

export interface CreateAuthInput {
	readonly config: typeof AuthConfig.Service;
	readonly database: BunSQLDatabase<typeof authSchema.authRelations>;
	readonly sendInvitation: (input: InvitationEmailInput) => Promise<void>;
	readonly publishMembershipEvent: (event: MembershipEvent) => Promise<void>;
}

// Better Auth is promise based, so it gets plain callbacks. The Auth layer bridges them to Effect.
export const createAuth = ({
	config,
	database,
	sendInvitation,
	publishMembershipEvent,
}: CreateAuthInput): Pick<Auth, "handler" | "options"> =>
	betterAuth({
		baseURL: config.baseUrl,
		secret: Redacted.value(config.secret),
		trustedOrigins: [config.webOrigin],
		database: drizzleAdapter(database, { provider: "pg", schema: authSchema }),
		// Sign-in tokens from GitHub and Google are secrets, so they are encrypted at rest.
		account: { encryptOAuthTokens: true },
		socialProviders: {
			github: {
				clientId: config.github.clientId,
				clientSecret: Redacted.value(config.github.clientSecret),
			},
			google: {
				clientId: config.google.clientId,
				clientSecret: Redacted.value(config.google.clientSecret),
			},
		},
		advanced: {
			// The web app is a static site on its own origin that calls the API with credentials.
			defaultCookieAttributes: { sameSite: "none", secure: true },
		},
		plugins: [
			organization({
				sendInvitationEmail: ({
					id,
					email,
					organization,
					inviter,
					invitation,
				}) =>
					sendInvitation({
						to: email,
						organizationName: organization.name,
						inviterName: inviter.user.name,
						acceptUrl: `${config.webOrigin}/invite?id=${encodeURIComponent(id)}`,
						// Resending an invitation moves its expiry, so a deliberate resend still gets through.
						idempotencyKey: `invitation/${id}/${invitation.expiresAt.toISOString()}`,
					}),
				organizationHooks: membershipHooks(publishMembershipEvent),
			}),
			deviceAuthorization({
				verificationUri: `${config.webOrigin}/device`,
				validateClient: (clientId) => clientId === DESKTOP_CLIENT_ID,
			}),
			// The desktop app sends the session token from the device flow as a bearer token.
			bearer(),
		],
	});
