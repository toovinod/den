import { type EmailMessage, type InvitationEmailInput, invitationEmail } from "./invitationEmail.ts";
import { Config, Context, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { Resend } from "resend";

export class EmailSendError extends Schema.TaggedError<EmailSendError>()("EmailSendError", {
	message: Schema.String,
	retryable: Schema.Boolean,
	cause: Schema.Defect(),
}) {}

// Resend error names that mean "try again later". Everything else is bad input or auth.
const retryableResendErrors: ReadonlySet<string> = new Set([
	"rate_limit_exceeded",
	"concurrent_idempotent_requests",
	"application_error",
	"internal_server_error",
]);

export class EmailService extends Context.Service<
	EmailService,
	{
		sendInvitation(input: InvitationEmailInput): Effect.Effect<void, EmailSendError>;
	}
>()("den/email/EmailService") {
	static readonly layer = Layer.effect(
		EmailService,
		Effect.gen(function* () {
			const apiKey = yield* Config.Redacted("RESEND_API_KEY");
			const from = yield* Config.String("EMAIL_FROM");
			const resend = new Resend(Redacted.value(apiKey));

			const sendInvitation = Effect.fn("EmailService.sendInvitation")(function* (input: InvitationEmailInput) {
				const message = invitationEmail(input);
				const response = yield* Effect.tryPromise({
					try: () => resend.emails.send({ from, ...message }, { idempotencyKey: input.idempotencyKey }),
					catch: (cause) =>
						new EmailSendError({
							message: "Could not reach Resend",
							retryable: true,
							cause,
						}),
				});
				if (response.error !== null) {
					return yield* new EmailSendError({
						message: response.error.message,
						retryable: retryableResendErrors.has(response.error.name),
						cause: response.error,
					});
				}
			});

			return EmailService.of({ sendInvitation });
		}),
	);
}

export class SentEmails extends Context.Service<SentEmails, Ref.Ref<ReadonlyArray<EmailMessage>>>()(
	"den/email/SentEmails",
) {
	static readonly layer = Layer.effect(SentEmails, Ref.make<ReadonlyArray<EmailMessage>>([]));
}

export const EmailServiceTest = Layer.effect(
	EmailService,
	Effect.gen(function* () {
		const sent = yield* SentEmails;
		return EmailService.of({
			sendInvitation: (input) => Ref.update(sent, (emails) => [...emails, invitationEmail(input)]),
		});
	}),
).pipe(Layer.provideMerge(SentEmails.layer));
