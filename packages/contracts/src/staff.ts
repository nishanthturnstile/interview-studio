import { z } from "zod";

export const workEmailSchema = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.email().max(254));
export const passwordSchema = z
	.string()
	.min(12, "Use at least 12 characters.")
	.max(128);

export const staffSignupSchema = z.object({
	name: z.string().trim().min(1, "Enter your name.").max(120),
	email: workEmailSchema,
	phone: z
		.string()
		.trim()
		.min(1, "Enter your phone number.")
		.max(40)
		.refine(
			(value) =>
				/^[+().\d -]+$/.test(value) &&
				/^\d{7,15}$/.test(value.replace(/\D/g, "")),
			"Enter a phone number with 7 to 15 digits.",
		),
	password: passwordSchema,
});

export const staffRoles = ["panelist", "hr", "director"] as const;
export const staffRoleSchema = z.enum(staffRoles);
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const grantStaffRoleSchema = z
	.object({ role: z.enum(["hr", "director"]) })
	.strict();
export type GrantStaffRole = z.infer<typeof grantStaffRoleSchema>["role"];

export const staffIdentitySchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.email(),
	role: staffRoleSchema,
});
export const staffListSchema = z.array(staffIdentitySchema);
export type StaffIdentity = z.infer<typeof staffIdentitySchema>;

export function availableStaffGrants(
	role: StaffRole,
): readonly GrantStaffRole[] {
	switch (role) {
		case "panelist":
			return ["hr", "director"];
		case "hr":
			return ["director"];
		case "director":
			return [];
	}
}
