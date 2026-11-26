import { staffIdentitySchema, staffListSchema } from "@studio/contracts";
import { redirect } from "@tanstack/react-router";

export async function loadStaff() {
	const response = await fetch("/api/staff/me", { cache: "no-store" });
	if (response.status === 401 || response.status === 403)
		throw redirect({ to: "/sign-in" });
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
