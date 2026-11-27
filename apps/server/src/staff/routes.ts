import {
	grantStaffRoleSchema,
	type StaffIdentity,
	workEmailSchema,
} from "@studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { db } from "../database.ts";
import type { driveRoutes } from "../drives/routes.ts";
import type { interviewStaffRoutes } from "../interviews/staff-routes.ts";
import type { createStaffAuth } from "./auth.ts";
import { getStaff, grantStaffRole, listStaff } from "./roles.ts";
import type { StaffSessionIdentity } from "./session-access.ts";
import type { StaffSettings } from "./settings.ts";

const emailActions = new Set([
	"/api/auth/sign-up/email",
	"/api/auth/sign-in/email",
	"/api/auth/send-verification-email",
	"/api/auth/request-password-reset",
]);
const confirmEmailSchema = z.object({ token: z.string().min(1).max(2_048) });
const authActions = new Set([
	...emailActions,
	"/api/auth/confirm-email",
	"/api/auth/reset-password",
	"/api/auth/sign-out",
]);

export function staffRoutes(
	database: typeof db,
	settings: StaffSettings,
	auth: ReturnType<typeof createStaffAuth>,
	drives?: ReturnType<typeof driveRoutes>,
	interviews?: ReturnType<typeof interviewStaffRoutes>,
) {
	const app = new Hono<{
		Variables: { staff: StaffIdentity; staffSession: StaffSessionIdentity };
	}>();
	// This stack runs a single app process. Serialize sign-in with password resets
	// so a sign-in that checked an old password cannot create a session after revocation.
	let credentialQueue = Promise.resolve();
	let pendingCredentialRequests = 0;
	function handleAuth(request: Request, path: string) {
		if (
			path !== "/api/auth/sign-in/email" &&
			path !== "/api/auth/reset-password"
		) {
			return auth.handler(request);
		}
		if (pendingCredentialRequests >= 10) {
			return Promise.resolve(
				Response.json(
					{ code: "TOO_MANY_REQUESTS" },
					{ status: 429, headers: { "Retry-After": "1" } },
				),
			);
		}
		pendingCredentialRequests += 1;
		const response = credentialQueue
			.then(() => auth.handler(request))
			.finally(() => {
				pendingCredentialRequests -= 1;
			});
		credentialQueue = response.then(
			() => {},
			() => {},
		);
		return response;
	}

	app.use("/api/auth/*", bodyLimit({ maxSize: 8_192 }));
	app.all("/api/auth/*", async (c) => {
		const { method, path } = c.req;
		const request = c.req.raw;
		if (method === "GET" && /^\/api\/auth\/reset-password\/[^/]+$/.test(path)) {
			c.header("Referrer-Policy", "no-referrer");
			c.header("Cache-Control", "no-store");
			return auth.handler(request);
		}
		if (method !== "POST" || !authActions.has(path)) {
			return c.json({ error: "not_found" }, 404);
		}
		c.header("Cache-Control", "no-store");
		if (
			!settings.trustedOrigins.includes(request.headers.get("origin") ?? "")
		) {
			return c.json({ error: "untrusted_origin" }, 403);
		}
		if (path !== "/api/auth/confirm-email" && !emailActions.has(path)) {
			return handleAuth(request, path);
		}

		if (
			!request.headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("application/json")
		) {
			return c.json({ error: "unsupported_content_type" }, 415);
		}
		const body = await request
			.clone()
			.json()
			.catch(() => null);
		if (path === "/api/auth/confirm-email") {
			const confirmation = confirmEmailSchema.safeParse(body);
			if (!confirmation.success) return c.json({ code: "INVALID_TOKEN" }, 400);
			const verifyUrl = new URL("/api/auth/verify-email", settings.origin);
			verifyUrl.searchParams.set("token", confirmation.data.token);
			return auth.handler(new Request(verifyUrl));
		}

		const email = workEmailSchema.safeParse(body?.email);
		if (!email.success) return c.json({ code: "INVALID_EMAIL" }, 400);
		if (email.data === body.email) return handleAuth(request, path);

		const headers = new Headers(request.headers);
		headers.delete("content-length");
		return handleAuth(
			new Request(request.url, {
				method,
				headers,
				body: JSON.stringify({ ...body, email: email.data }),
			}),
			path,
		);
	});

	app.use("/api/staff/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		if (
			c.req.method !== "GET" &&
			!settings.trustedOrigins.includes(c.req.header("origin") ?? "")
		) {
			return c.json({ error: "untrusted_origin" }, 403);
		}
		const session = await auth.api.getSession({
			headers: c.req.raw.headers,
			query: { disableCookieCache: true, disableRefresh: true },
		});
		if (!session) return c.json({ error: "unauthenticated" }, 401);

		const staff = await getStaff(database, session.user.id, settings.domains);
		if (!staff) return c.json({ error: "forbidden" }, 403);
		c.set("staff", staff);
		c.set("staffSession", {
			userId: session.user.id,
			sessionId: session.session.id,
		});
		await next();
	});
	app.get("/api/staff/me", (c) => c.json(c.get("staff")));
	app.get("/api/staff/access", async (c) => {
		if (c.get("staff").role !== "director")
			return c.json({ error: "forbidden" }, 403);
		return c.json(await listStaff(database, settings.domains));
	});
	app.patch(
		"/api/staff/access/:userId",
		bodyLimit({ maxSize: 1_024 }),
		async (c) => {
			const actor = c.get("staff");
			if (actor.role !== "director") return c.json({ error: "forbidden" }, 403);
			const grant = grantStaffRoleSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!grant.success) return c.json({ error: "invalid_role" }, 400);

			const result = await grantStaffRole(
				database,
				settings.domains,
				actor.id,
				c.req.param("userId"),
				grant.data.role,
			);
			if (result === "not_found") return c.json({ error: result }, 404);
			if (result === "invalid_transition")
				return c.json({ error: result }, 409);
			return c.json({ role: grant.data.role });
		},
	);
	if (drives) app.route("/api/staff/drives", drives);
	if (interviews) app.route("/api/staff", interviews);
	return app;
}
