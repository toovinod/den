import type { OrganizationOptions } from "better-auth/plugins";
import type { MembershipEvent } from "./MembershipEvents.ts";

// Maps Better Auth's organization callbacks to our membership events.
export const membershipHooks = (
	publish: (event: MembershipEvent) => Promise<void>,
) =>
	({
		afterRemoveMember: ({ member }) =>
			publish({
				_tag: "memberRemoved",
				organizationId: member.organizationId,
				userId: member.userId,
			}),
		afterUpdateMemberRole: ({ member, previousRole }) =>
			publish({
				_tag: "memberRoleChanged",
				organizationId: member.organizationId,
				userId: member.userId,
				previousRole,
				role: member.role,
			}),
		afterCancelInvitation: ({ invitation }) =>
			publish({
				_tag: "invitationRevoked",
				organizationId: invitation.organizationId,
				invitationId: invitation.id,
			}),
	}) satisfies OrganizationOptions["organizationHooks"];
