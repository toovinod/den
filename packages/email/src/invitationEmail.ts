export interface InvitationEmailInput {
	readonly to: string;
	readonly organizationName: string;
	readonly inviterName: string;
	readonly acceptUrl: string;
}

export interface EmailMessage {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
}

const MAX_NAME_LENGTH = 80;

// Org and inviter names are typed by users. Strip anything that could add lines,
// fake a link or flood the email before putting them in the subject or body.
export const plainName = (name: string): string =>
	name
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[a-z][a-z0-9+.-]*:\/\//gi, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_LENGTH);

export const invitationEmail = (input: InvitationEmailInput): EmailMessage => {
	const organizationName = plainName(input.organizationName);
	const inviterName = plainName(input.inviterName);
	return {
		to: input.to,
		subject: `Join ${organizationName} on Swarm`,
		text: [
			`${inviterName} invited you to join ${organizationName} on Swarm.`,
			"",
			`Accept the invitation: ${input.acceptUrl}`,
			"",
			"If you did not expect this email, you can ignore it.",
		].join("\n"),
	};
};
