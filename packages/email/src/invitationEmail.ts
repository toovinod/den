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

export const invitationEmail = (input: InvitationEmailInput): EmailMessage => ({
	to: input.to,
	subject: `Join ${input.organizationName} on Swarm`,
	text: [
		`${input.inviterName} invited you to join ${input.organizationName} on Swarm.`,
		"",
		`Accept the invitation: ${input.acceptUrl}`,
		"",
		"If you did not expect this email, you can ignore it.",
	].join("\n"),
});
