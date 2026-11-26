import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	test,
	vi,
} from "vite-plus/test";
import { createStaffAuth } from "./auth.ts";
import { user, verification } from "./auth-schema.ts";
import { staffDirectorBootstrap, staffGrant } from "./role-schema.ts";
import {
	bootstrapDirector,
	getStaff,
	grantStaffRole,
	listStaff,
} from "./roles.ts";
import { staffRoutes } from "./routes.ts";
import { isApprovedEmail, readStaffSettings } from "./settings.ts";

const domains = new Set(["studio.test"]);

test("compares normalized whole email domains", () => {
	expect(isApprovedEmail(" Staff@STUDIO.TEST ", domains)).toBe(true);
	expect(isApprovedEmail("staff@studio.test.example", domains)).toBe(false);
	expect(isApprovedEmail("staff@sub.studio.test", domains)).toBe(false);
});

test("only allows an insecure authentication origin in explicit loopback mode", () => {
	const env = {
		STUDIO_AUTH_ALLOW_LOOPBACK: "true",
		STUDIO_STAFF_DOMAINS: "studio.test",
		STUDIO_DIRECTOR_EMAIL: "director@studio.test",
		STUDIO_AUTH_SECRET: "synthetic-test-secret-at-least-32-characters",
	};
	expect(
		readStaffSettings({ ...env, STUDIO_AUTH_ORIGIN: "http://127.0.0.1:3000" })
			.secureCookies,
	).toBe(false);
	expect(
		readStaffSettings({
			...env,
			STUDIO_AUTH_ORIGIN: "https://staff.studio.test",
		}).secureCookies,
	).toBe(true);
	expect(() =>
		readStaffSettings({
			...env,
			STUDIO_AUTH_ORIGIN: "http://staff.studio.test",
		}),
	).toThrow();
});

const testDatabaseUrl = process.env.STUDIO_TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("staff authorization on PostgreSQL", () => {
	const pool = new pg.Pool({
		connectionString: testDatabaseUrl,
		connectionTimeoutMillis: 1_000,
	});
	const database = drizzle(pool);
	const ids = {
		director: randomUUID(),
		panelist: randomUUID(),
		pending: randomUUID(),
		outside: randomUUID(),
	};

	beforeAll(async () => {
		await migrate(database, {
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle", import.meta.url),
			),
		});
		await database.insert(user).values(
			Object.entries(ids).map(([kind, id]) => ({
				id,
				name: kind,
				phone: "+1 202 555 0111",
				email: `${id}@${kind === "outside" ? "outside.test" : "studio.test"}`,
				emailVerified: kind !== "pending",
			})),
		);
	});
	afterAll(async () => pool.end());

	test("claims bootstrap once, including concurrent sign-ins and a later change of designated account", async () => {
		await Promise.all([
			bootstrapDirector(database, ids.director),
			bootstrapDirector(database, ids.director),
		]);
		await bootstrapDirector(database, ids.panelist);
		expect(await database.select().from(staffDirectorBootstrap)).toEqual([
			{ id: 1, userId: ids.director },
		]);
		expect((await getStaff(database, ids.director, domains))?.role).toBe(
			"director",
		);
		expect((await getStaff(database, ids.panelist, domains))?.role).toBe(
			"panelist",
		);
	});

	test("excludes ineligible accounts and serializes competing promotions", async () => {
		expect((await listStaff(database, domains)).map((row) => row.id)).toEqual([
			ids.director,
			ids.panelist,
		]);
		await expect(
			grantStaffRole(database, domains, ids.director, ids.pending, "hr"),
		).resolves.toBe("not_found");
		await expect(
			grantStaffRole(database, domains, ids.director, ids.outside, "hr"),
		).resolves.toBe("not_found");
		await Promise.all([
			grantStaffRole(database, domains, ids.director, ids.panelist, "hr"),
			grantStaffRole(database, domains, ids.director, ids.panelist, "director"),
		]);
		expect((await getStaff(database, ids.panelist, domains))?.role).toBe(
			"director",
		);
		await expect(
			grantStaffRole(database, domains, ids.director, ids.panelist, "hr"),
		).resolves.toBe("invalid_transition");
		const [result] = await database
			.select()
			.from(staffGrant)
			.where(eq(staffGrant.userId, ids.panelist));
		expect(result.grantedBy).toBe(ids.director);
	});
	test("rejects a token that is present but expired", async () => {
		const token = randomUUID();
		await database.insert(verification).values({
			id: randomUUID(),
			identifier: `reset-password:${token}`,
			value: ids.panelist,
			expiresAt: new Date(0),
		});
		const origin = "http://127.0.0.1:3000";
		const config = readStaffSettings({
			STUDIO_AUTH_ORIGIN: origin,
			STUDIO_AUTH_ALLOW_LOOPBACK: "true",
			STUDIO_STAFF_DOMAINS: "studio.test",
			STUDIO_DIRECTOR_EMAIL: "director@studio.test",
			STUDIO_AUTH_SECRET: "synthetic-test-secret-at-least-32-characters",
		});
		const routes = staffRoutes(
			database,
			config,
			createStaffAuth(database, config, () => {}),
		);
		const response = await routes.request(
			new URL(
				`/api/auth/reset-password/${token}?callbackURL=/reset-password`,
				origin,
			),
		);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "", origin);
		expect(location.pathname).toBe("/reset-password");
		expect(location.searchParams.get("error")).toBe("INVALID_TOKEN");
		expect(location.searchParams.has("token")).toBe(false);
	});
	test("serializes a password reset with an in-flight sign-in", async () => {
		const origin = "http://127.0.0.1:3000";
		const config = readStaffSettings({
			STUDIO_AUTH_ORIGIN: origin,
			STUDIO_AUTH_ALLOW_LOOPBACK: "true",
			STUDIO_STAFF_DOMAINS: "studio.test",
			STUDIO_DIRECTOR_EMAIL: "director@studio.test",
			STUDIO_AUTH_SECRET: "synthetic-test-secret-at-least-32-characters",
		});
		const auth = createStaffAuth(database, config, () => {});
		const waiting = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const calls: string[] = [];
		vi.spyOn(auth, "handler").mockImplementation(async (request) => {
			if (new URL(request.url).pathname === "/api/auth/sign-in/email") {
				calls.push("check-password");
				entered.resolve();
				await waiting.promise;
				calls.push("create-session");
			} else {
				calls.push("reset-password-and-revoke");
			}
			return Response.json({ ok: true });
		});
		const routes = staffRoutes(database, config, auth);
		const post = (path: string, body: object) =>
			routes.request(new URL(path, origin), {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const signIn = post("/api/auth/sign-in/email", {
			email: "staff@studio.test",
			password: "synthetic-password",
		});
		await entered.promise;
		const reset = post("/api/auth/reset-password", {
			token: "synthetic-token",
			newPassword: "new-synthetic-password",
		});
		await setImmediate();
		waiting.resolve();
		await Promise.all([signIn, reset]);
		expect(calls).toEqual([
			"check-password",
			"create-session",
			"reset-password-and-revoke",
		]);
	});
});
