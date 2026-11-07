import { Hono } from "hono";
import { cors } from "hono/cors";

export interface CreateAppInput {
	readonly webOrigin: string;
	readonly authHandler: (request: Request) => Promise<Response>;
}

export const createApp = ({ webOrigin, authHandler }: CreateAppInput) =>
	new Hono()
		.use(
			"*",
			cors({
				origin: (origin) => (origin === webOrigin ? origin : null),
				credentials: true,
				allowHeaders: ["Content-Type", "Authorization"],
				allowMethods: ["GET", "POST", "OPTIONS"],
			}),
		)
		.get("/health", (context) => context.json({ status: "ok" }))
		.on(["GET", "POST"], "/api/auth/*", (context) => authHandler(context.req.raw));
