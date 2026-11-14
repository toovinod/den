import { invitationEmail, plainName } from "./invitationEmail.ts";
import { describe, expect, test } from "bun:test";

describe("plainName", () => {
	test("removes line breaks and control characters", () => {
		expect(plainName("Acme\r\nBcc: evil@example.com")).toBe("Acme Bcc: evil@example.com");
		expect(plainName("Ac\u0000me‮")).toBe("Ac me");
	});

	test("removes URL schemes so names cannot pose as links", () => {
		expect(plainName("Visit https://evil.example now")).toBe("Visit evil.example now");
	});

	test("caps the length", () => {
		expect(plainName("a".repeat(500))).toHaveLength(80);
	});
});

describe("invitationEmail", () => {
	test("keeps the subject on one line whatever the org name is", () => {
		const email = invitationEmail({
			to: "ada@example.com",
			organizationName: "Acme\nClick here",
			inviterName: "Grace",
			acceptUrl: "https://octopus.test/invite?id=abc",
			idempotencyKey: "invitation/abc",
		});
		expect(email.subject).toBe("Join Acme Click here on Octopus");
		expect(email.text).toContain("https://octopus.test/invite?id=abc");
	});
});
