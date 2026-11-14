import { describe, expect, test } from "bun:test";
import { createApp } from "./createApp.ts";

const WEB_ORIGIN = "https://app.octopus.test";

const app = createApp({
	webOrigin: WEB_ORIGIN,
	authHandler: (request) => Promise.resolve(Response.json({ path: new URL(request.url).pathname })),
});

describe("api", () => {
	test("GET /health answers ok", async () => {
		const response = await app.request("/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("forwards /api/auth/* to Better Auth", async () => {
		const response = await app.request("/api/auth/get-session");
		expect(await response.json()).toEqual({ path: "/api/auth/get-session" });
	});

	test("allows credentialed requests from the web origin only", async () => {
		const preflight = (origin: string) =>
			app.request("/api/auth/sign-in/social", {
				method: "OPTIONS",
				headers: {
					Origin: origin,
					"Access-Control-Request-Method": "POST",
				},
			});

		const allowed = await preflight(WEB_ORIGIN);
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(WEB_ORIGIN);
		expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe("true");

		const other = await preflight("https://evil.test");
		expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});
