import { createAuthMiddleware } from "better-auth/api";
import type { OrganizationOptions } from "better-auth/plugins";
import { Option, Schema } from "effect";
import type { MembershipEvent } from "./MembershipEvents.ts";

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
		afterDeleteOrganization: ({ organization }) =>
			publish({ _tag: "organizationDeleted", organizationId: organization.id }),
	}) satisfies OrganizationOptions["organizationHooks"];

const LeftMember = Schema.Struct({
	organizationId: Schema.String,
	userId: Schema.String,
});
const decodeLeftMember = Schema.decodeUnknownOption(LeftMember);

// Leaving an org deletes the member without calling afterRemoveMember, so it is
// caught here. The endpoint returns the removed member on success and an error otherwise.
export const leaveOrganizationHook = (
	publish: (event: MembershipEvent) => Promise<void>,
) =>
	createAuthMiddleware(async (ctx) => {
		if (ctx.path !== "/organization/leave") return;
		const member = decodeLeftMember(ctx.context.returned);
		if (Option.isSome(member)) {
			await publish({ _tag: "memberRemoved", ...member.value });
		}
	});
