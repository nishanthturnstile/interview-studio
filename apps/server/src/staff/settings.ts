import { workEmailSchema } from "@studio/contracts";
import { z } from "zod";

export function isApprovedEmail(email: string, domains: ReadonlySet<string>) {
	const normalized = workEmailSchema.safeParse(email);
	return normalized.success && domains.has(normalized.data.split("@")[1]);
}

export function readStaffSettings(env: NodeJS.ProcessEnv) {
	const origin = new URL(z.url().parse(env.STUDIO_AUTH_ORIGIN));
	const loopback =
		env.STUDIO_AUTH_ALLOW_LOOPBACK === "true" &&
		origin.protocol === "http:" &&
		origin.hostname === "127.0.0.1";
	if (
		origin.href !== `${origin.origin}/` ||
		(origin.protocol !== "https:" && !loopback)
	) {
		throw new Error(
			"Staff authentication requires an HTTPS origin or explicit loopback HTTP",
		);
	}

	const domains = new Set(
		(env.STUDIO_STAFF_DOMAINS ?? "")
			.split(",")
			.map((domain) => domain.trim().toLowerCase()),
	);
	if (
		[...domains].some(
			(domain) => !workEmailSchema.safeParse(`staff@${domain}`).success,
		)
	) {
		throw new Error("Configure a valid staff email domain allowlist");
	}
	const directorEmail = workEmailSchema.parse(env.STUDIO_DIRECTOR_EMAIL);
	if (!isApprovedEmail(directorEmail, domains)) {
		throw new Error("The first director must use an approved email domain");
	}

	return {
		origin: origin.origin,
		secureCookies: !loopback,
		trustedOrigins: loopback
			? [origin.origin, "http://127.0.0.1:5173"]
			: [origin.origin],
		domains,
		directorEmail,
		secret: z.string().min(32).parse(env.STUDIO_AUTH_SECRET),
	};
}

export type StaffSettings = ReturnType<typeof readStaffSettings>;
