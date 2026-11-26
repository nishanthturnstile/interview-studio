import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [
		inferAdditionalFields({
			user: { phone: { type: "string", required: true, returned: false } },
		}),
	],
});

export function authError(
	status: number,
	code: string | undefined,
	fallback: string,
) {
	if (status === 429)
		return "Too many attempts. Wait a moment, then try again.";
	if (code === "EMAIL_DOMAIN_NOT_ALLOWED")
		return "Use a work email address on an approved domain.";
	if (code === "EMAIL_NOT_VERIFIED")
		return "Verify your work email before signing in.";
	if (code === "INVALID_TOKEN")
		return "This link has expired or already been used. Request a new one.";
	return fallback;
}
