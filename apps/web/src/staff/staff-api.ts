import { staffIdentitySchema, staffListSchema } from "@studio/contracts";
import { redirect } from "@tanstack/react-router";
import { z } from "zod";

export async function loadStaff(pathname: string) {
	const response = await fetch("/api/staff/me", { cache: "no-store" });
	if (response.status === 401 || response.status === 403) {
		const path = /^\/staff\/my-interviews\/invitations\/([^/]+)\/?$/.exec(
			pathname,
		);
		const invitationId = z.uuid().safeParse(path?.[1]).data;
		throw redirect({ to: "/sign-in", search: { invitationId } });
	}
	if (!response.ok) throw new Error("Unable to load your staff account.");
	return staffIdentitySchema.parse(await response.json());
}

export async function loadStaffAccess() {
	const response = await fetch("/api/staff/access", { cache: "no-store" });
	if (response.status === 401) throw redirect({ to: "/sign-in" });
	if (response.status === 403) return null;
	if (!response.ok) throw new Error("Unable to load staff access.");
	return staffListSchema.parse(await response.json());
}
