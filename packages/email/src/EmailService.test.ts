import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { EmailService, EmailServiceTest, SentEmails } from "./EmailService.ts";

describe("EmailService", () => {
	test("the test layer records invitation emails instead of sending them", async () => {
		const sent = await Effect.gen(function* () {
			const email = yield* EmailService;
			yield* email.sendInvitation({
				to: "ada@example.com",
				organizationName: "Acme",
				inviterName: "Grace",
				acceptUrl: "https://swarm.test/invite/abc",
			});
			return yield* Ref.get(yield* SentEmails);
		}).pipe(Effect.provide(EmailServiceTest), Effect.runPromise);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe("ada@example.com");
		expect(sent[0]?.subject).toBe("Join Acme on Swarm");
		expect(sent[0]?.text).toContain("Grace invited you to join Acme");
		expect(sent[0]?.text).toContain("https://swarm.test/invite/abc");
	});
});
