import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type BookInterview,
	bookInterviewSchema,
	interviewListQuerySchema,
} from "@studio/contracts";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { changeCandidate } from "../drives/review.ts";
import { drive } from "../drives/schema.ts";
import { user } from "../staff/auth-schema.ts";
import { staffGrant } from "../staff/role-schema.ts";
import { grantStaffRole } from "../staff/roles.ts";
import {
	candidateRound,
	limitPublicRequests,
	requestCode,
	verifyCode,
} from "./admission.ts";
import {
	interviewClientAddress,
	readInterviewProxyAddresses,
} from "./client-address.ts";
import { fixtureCandidacy } from "./fixture.ts";
import {
	findPanelists,
	getAssignedRound,
	getHrRound,
	listAssignedRounds,
	listInterviews,
	resolveStaffInvite,
} from "./queries.ts";
import {
	bookInterview,
	changeRound,
	copyInvitation,
	withdrawCandidacy,
} from "./scheduling.ts";
import { interviewEvent, interviewRound } from "./schema.ts";
import {
	type InterviewConfig,
	lockCandidacy,
	readPreferences,
	savePreferences,
} from "./store.ts";
import { resolveSlot } from "./time.ts";

test("resolves IST, reports both repeated offsets, and rejects a skipped local time", () => {
	const ist = resolveSlot(
		{ date: "2026-11-01", time: "09:00", duration: 60 },
		"Asia/Kolkata",
	);
	expect(ist.start.toISOString()).toBe("2026-11-01T03:30:00.000Z");
	expect(ist.end.toISOString()).toBe("2026-11-01T04:30:00.000Z");
	const repeated = { date: "2026-11-01", time: "01:30", duration: 60 };
	expect(() => resolveSlot(repeated, "America/New_York")).toThrow(
		expect.objectContaining({
			body: { error: "ambiguous_time", offsets: ["-04:00", "-05:00"] },
		}),
	);
	expect(
		resolveSlot(
			{ ...repeated, offset: "-04:00" },
			"America/New_York",
		).start.toISOString(),
	).toBe("2026-11-01T05:30:00.000Z");
	expect(
		resolveSlot(
			{ ...repeated, offset: "-05:00" },
			"America/New_York",
		).start.toISOString(),
	).toBe("2026-11-01T06:30:00.000Z");
	expect(() =>
		resolveSlot(
			{ ...repeated, date: "2026-03-08", time: "02:30" },
			"America/New_York",
		),
	).toThrow("nonexistent_time");
	expect(() => resolveSlot(repeated, "+05:30")).toThrow("invalid_time_zone");
	expect(() => resolveSlot({ ...repeated, time: "25:30" }, "UTC")).toThrow(
		"invalid_slot",
	);
	expect(
		bookInterviewSchema.shape.meeting.safeParse({
			mode: "virtual",
			teamsUrl: "https://user:pass@example.test/join",
		}).success,
	).toBe(false);
	expect(
		bookInterviewSchema.shape.meeting.safeParse({
			mode: "in_person",
			room: " ",
		}).success,
	).toBe(false);
});

test("uses the reported client address only for configured ingress peers", () => {
	const proxies = readInterviewProxyAddresses("172.18.0.2, 2001:db8:0::a");
	expect(interviewClientAddress("172.18.0.3", "192.0.2.10", proxies)).toBe(
		"172.18.0.3",
	);
	expect(
		interviewClientAddress("::ffff:172.18.0.2", "192.0.2.10", proxies),
	).toBe("192.0.2.10");
	expect(
		interviewClientAddress("2001:db8::a", "2001:db8:0000::b", proxies),
	).toBe("2001:db8::b");
	expect(
		interviewClientAddress("172.18.0.2", "192.0.2.10, 192.0.2.11", proxies),
	).toBe("172.18.0.2");
	expect(interviewClientAddress(undefined, "192.0.2.10", proxies)).toBe(
		"unknown",
	);
	expect(() => readInterviewProxyAddresses("172.18.0.0/24")).toThrow();
});

const url = process.env.STUDIO_TEST_DATABASE_URL;

describe.skipIf(!url)("interview workflows on PostgreSQL", () => {
	const name = `slice4_${randomUUID().replaceAll("-", "")}`;
	const admin = new pg.Pool({ connectionString: url });
	const target = new URL(url ?? "postgresql://127.0.0.1/studio");
	target.pathname = `/${name}`;
	const pool = new pg.Pool({ connectionString: target.href });
	const database = drizzle(pool);
	const staff = {
		hr: randomUUID(),
		panelist: randomUUID(),
		other: randomUUID(),
		pending: randomUUID(),
		director: randomUUID(),
	};
	const first = randomUUID();
	const second = randomUUID();
	const legacy = randomUUID();
	const domains = new Set(["studio.test"]);
	let now = new Date("2026-11-01T03:20:00Z");
	const config: InterviewConfig = {
		key: "synthetic-interview-key-for-slice4-tests",
		origin: "http://127.0.0.1:3000",
		domains,
		clock: () => now,
	};
	const migrationPath = fileURLToPath(
		new URL("../../drizzle", import.meta.url),
	);

	const interrupted = (error: string, extra = {}) => ({
		body: expect.objectContaining({ error, ...extra }),
	});
	async function candidacy(
		driveId = first,
		email = `${randomUUID()}@example.test`,
		name = "Synthetic Applicant",
	) {
		const item = { id: randomUUID(), driveId, name, email };
		await database.transaction((tx) => fixtureCandidacy(tx, staff.hr, item));
		return item;
	}
	function booking(
		item: { id: string; driveId: string },
		slot: Partial<BookInterview["slot"]> = {},
		panelistId = staff.panelist,
	): BookInterview {
		return {
			commandId: randomUUID(),
			driveId: item.driveId,
			candidateId: item.id,
			candidateRevision: 0,
			panelistId,
			level: "l1",
			preferenceRevision: 0,
			slot: { date: "2026-11-01", time: "09:00", duration: 60, ...slot },
			meeting: { mode: "virtual", teamsUrl: null },
		};
	}
	async function invite(id: string, email: string) {
		const value = new URL((await copyInvitation(database, config, id)).link);
		return {
			id: value.pathname.split("/").at(-1) as string,
			input: { secret: value.hash.slice(1), email },
		};
	}
	function captureMail() {
		let code = "";
		return {
			mail: async (_to: string, _subject: string, text: string) => {
				code = text.match(/\b\d{6}\b/)?.[0] ?? "";
			},
			code: () => code,
		};
	}

	beforeAll(async () => {
		await drizzle(admin).execute(sql`create database ${sql.identifier(name)}`);
		const previous = await mkdtemp(join(tmpdir(), "studio-slice4-upgrade-"));
		try {
			await cp(migrationPath, previous, { recursive: true });
			const journalPath = join(previous, "meta", "_journal.json");
			const journal = JSON.parse(await readFile(journalPath, "utf8"));
			journal.entries = journal.entries.filter(
				(entry: { idx: number }) => entry.idx < 5,
			);
			await writeFile(journalPath, JSON.stringify(journal));
			await migrate(database, {
				migrationsFolder: previous,
			});
			await database.insert(user).values(
				Object.entries(staff).map(([kind, id]) => ({
					id,
					name: kind,
					email: `${id}@studio.test`,
					phone: "+1 202 555 0100",
					emailVerified: kind !== "pending",
				})),
			);
			await database.insert(staffGrant).values([
				{ role: "hr", userId: staff.hr },
				{ role: "director", userId: staff.director },
			]);
			await database.insert(drive).values([
				{
					id: first,
					clientKey: first,
					createdBy: staff.hr,
					name: "First Drive",
				},
				{
					id: second,
					clientKey: second,
					createdBy: staff.hr,
					name: "Second Drive",
				},
			]);
			await database.transaction((tx) =>
				fixtureCandidacy(tx, staff.hr, {
					id: legacy,
					driveId: first,
					name: "Legacy Candidate",
					email: "legacy@example.test",
				}),
			);
			await migrate(database, {
				migrationsFolder: migrationPath,
			});
			await migrate(database, {
				migrationsFolder: migrationPath,
			});
		} finally {
			await rm(previous, { recursive: true, force: true });
		}
	});

	afterAll(async () => {
		await pool.end();
		try {
			await drizzle(admin).execute(
				sql`drop database if exists ${sql.identifier(name)}`,
			);
		} finally {
			await admin.end();
		}
	});

	test("upgrades legacy candidacies and returns a stable, filtered cross-drive queue", async () => {
		const candidates = await Promise.all(
			Array.from({ length: 22 }, (_, i) =>
				candidacy(
					i % 2 ? first : second,
					undefined,
					`Queue Candidate ${String(i).padStart(2, "0")}`,
				),
			),
		);
		const query = (filter: object) =>
			listInterviews(database, interviewListQuerySchema.parse(filter), now);
		const legacyPage = await query({ search: "LEGACY" });
		expect(legacyPage.items).toMatchObject([{ id: legacy, years: null }]);
		expect((await query({ search: "legacy", minYears: 0 })).items).toHaveLength(
			0,
		);
		const pageOne = await query({ search: "Queue Candidate" });
		const pageTwo = await query({ search: "Queue Candidate", page: 2 });
		expect(pageOne.total).toBe(22);
		expect([...pageOne.items, ...pageTwo.items].map(({ id }) => id)).toEqual(
			candidates.map(({ id }) => id),
		);
		expect(
			(await query({ search: "Queue Candidate", driveId: first })).total,
		).toBe(11);
	});

	test("serializes cross-drive resources, detects each type, and rejects changed overrides", async () => {
		const [one, two, three, four] = await Promise.all([
			candidacy(),
			candidacy(second),
			candidacy(),
			candidacy(second),
		]);
		const slot = { time: "12:00" };
		const [firstWrite, secondWrite] = await Promise.allSettled([
			bookInterview(database, config, staff.hr, booking(one, slot)),
			bookInterview(database, config, staff.hr, booking(two, slot)),
		]);
		expect([firstWrite.status, secondWrite.status].sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		const blocked = firstWrite.status === "rejected" ? firstWrite : secondWrite;
		expect(blocked).toMatchObject({
			reason: interrupted("slot_conflict", {
				conflicts: [expect.objectContaining({ resources: ["panelist"] })],
			}),
		});
		const winningCandidate = firstWrite.status === "fulfilled" ? one : two;
		const crossDrive = await candidacy(
			winningCandidate.driveId === first ? second : first,
			winningCandidate.email,
		);
		const request = booking(crossDrive, slot, staff.other);
		const warning = await bookInterview(
			database,
			config,
			staff.hr,
			request,
		).catch((error) => error.body);
		expect(warning).toMatchObject({
			error: "slot_conflict",
			conflicts: [expect.objectContaining({ resources: ["candidate"] })],
		});
		const added = await bookInterview(
			database,
			config,
			staff.hr,
			booking(three, slot, staff.other),
		);
		const changed = await bookInterview(database, config, staff.hr, {
			...request,
			acknowledge: warning.acknowledge,
		}).catch((error) => error.body);
		expect(changed).toMatchObject({
			error: "slot_conflict",
			conflicts: expect.arrayContaining([
				expect.objectContaining({ id: added.id, resources: ["panelist"] }),
			]),
		});
		const accepted = { ...request, acknowledge: changed.acknowledge };
		const result = await bookInterview(database, config, staff.hr, accepted);
		await expect(
			bookInterview(database, config, staff.hr, accepted),
		).resolves.toEqual(result);
		await expect(
			bookInterview(database, config, staff.hr, {
				...accepted,
				slot: { ...accepted.slot, duration: 30 },
			}),
		).rejects.toMatchObject(interrupted("idempotency_conflict"));
		await expect(
			bookInterview(
				database,
				config,
				staff.hr,
				booking(four, { time: "13:00" }, staff.other),
			),
		).resolves.toHaveProperty("id");
	});

	test("enforces candidacy uniqueness, current panelist role, preferences, and invited email snapshots", async () => {
		const item = await candidacy();
		const request = booking(item, { time: "15:00" });
		const writes = await Promise.allSettled([
			bookInterview(database, config, staff.hr, request),
			bookInterview(database, config, staff.hr, {
				...request,
				commandId: randomUUID(),
			}),
		]);
		expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(
			1,
		);
		expect(writes.find(({ status }) => status === "rejected")).toMatchObject({
			reason: interrupted("round_not_eligible"),
		});
		await expect(
			changeCandidate(database, first, item.id, {
				type: "save",
				input: { revision: 0, email: "new-address@example.test" },
			}),
		).rejects.toMatchObject(interrupted("interview_email_in_use"));
		const unbooked = await candidacy();
		await expect(
			bookInterview(database, config, staff.hr, {
				...booking(unbooked),
				level: "l2",
			}),
		).rejects.toMatchObject(interrupted("round_not_eligible"));
		const promoted = randomUUID();
		await database.insert(user).values({
			id: promoted,
			name: "Promoted",
			email: `${promoted}@studio.test`,
			phone: "+1 202 555 0100",
			emailVerified: true,
		});
		const verified = await findPanelists(database, domains, "");
		expect(verified.map(({ id }) => id)).toContain(promoted);
		expect(verified.map(({ id }) => id)).not.toContain(staff.pending);
		await grantStaffRole(database, domains, staff.director, promoted, "hr");
		await expect(
			bookInterview(
				database,
				config,
				staff.hr,
				booking(unbooked, {}, promoted),
			),
		).rejects.toMatchObject(interrupted("panelist_ineligible"));
		const defaults = await readPreferences(database, promoted);
		expect(defaults).toEqual({
			timeZone: "Asia/Kolkata",
			duration: 60,
			revision: 0,
		});
		await savePreferences(database, promoted, {
			...defaults,
			timeZone: "America/New_York",
			duration: 45,
		});
		await expect(
			bookInterview(database, config, promoted, booking(unbooked)),
		).rejects.toMatchObject(interrupted("preferences_changed"));
		await expect(readPreferences(database, staff.hr)).resolves.toEqual(
			defaults,
		);
	});

	test("requires HR to review the current candidacy before booking", async () => {
		const item = await candidacy();
		const request = booking(item, { time: "17:30" });
		const email = "corrected-before-booking@example.test";
		await changeCandidate(database, item.driveId, item.id, {
			type: "save",
			input: { revision: 0, email, name: "Updated Candidate", years: 6 },
		});
		await expect(
			bookInterview(database, config, staff.hr, request),
		).rejects.toMatchObject(
			interrupted("revision_conflict", {
				candidacy: {
					id: item.id,
					name: "Updated Candidate",
					email,
					years: 6,
					revision: 1,
				},
			}),
		);
		expect(
			await database
				.select({ id: interviewRound.id })
				.from(interviewRound)
				.where(eq(interviewRound.candidateId, item.id)),
		).toEqual([]);
		const reviewed = {
			...request,
			commandId: randomUUID(),
			candidateRevision: 1,
		};
		const booked = await bookInterview(database, config, staff.hr, reviewed);
		await expect(getHrRound(database, booked.id, now)).resolves.toMatchObject({
			candidate: { email, name: "Updated Candidate", years: 6 },
		});
		await changeCandidate(database, item.driveId, item.id, {
			type: "save",
			input: { revision: 1, years: 7 },
		});
		await expect(
			bookInterview(database, config, staff.hr, reviewed),
		).resolves.toEqual(booked);
		await changeRound(database, config, staff.hr, "hr", booked.id, {
			action: "cancel",
			commandId: randomUUID(),
			revision: 0,
		});
	});

	test("checks admission deadlines, cooldown, failed SMTP delivery, expiration, code replay, and source budget", async () => {
		const item = await candidacy();
		const { id } = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item),
		);
		const invitation = await invite(id, item.email);
		const mailbox = captureMail();
		now = new Date("2026-11-01T03:19:59.999Z");
		await expect(
			requestCode(database, config, mailbox.mail, invitation.id, {
				...invitation.input,
				email: "wrong@example.test",
			}),
		).rejects.toMatchObject(interrupted("invite_unavailable"));
		await expect(
			requestCode(
				database,
				config,
				mailbox.mail,
				invitation.id,
				invitation.input,
			),
		).rejects.toMatchObject(interrupted("too_early"));
		now = new Date("2026-11-01T03:20:00.000Z");
		await expect(
			requestCode(
				database,
				config,
				async () => {
					throw new Error("Synthetic SMTP failure");
				},
				invitation.id,
				invitation.input,
			),
		).rejects.toMatchObject(interrupted("delivery_failed"));
		const codeOne = await requestCode(
			database,
			config,
			mailbox.mail,
			invitation.id,
			invitation.input,
		);
		const validCode = mailbox.code();
		for (let attempt = 0; attempt < 5; attempt++) {
			const wrong = validCode === "000000" ? "000001" : "000000";
			await expect(
				verifyCode(database, config, invitation.id, {
					...invitation.input,
					challengeId: codeOne.challengeId,
					code: wrong,
				}),
			).rejects.toMatchObject(interrupted("invalid_code"));
		}
		await expect(
			verifyCode(database, config, invitation.id, {
				...invitation.input,
				challengeId: codeOne.challengeId,
				code: validCode,
			}),
		).rejects.toMatchObject(interrupted("invalid_code"));
		await expect(
			requestCode(
				database,
				config,
				mailbox.mail,
				invitation.id,
				invitation.input,
			),
		).rejects.toMatchObject(interrupted("rate_limited", { retryAfter: 60 }));
		now = new Date("2026-11-01T03:21:00Z");
		const codeTwo = await requestCode(
			database,
			config,
			mailbox.mail,
			invitation.id,
			invitation.input,
		);
		const expired = {
			...invitation.input,
			challengeId: codeTwo.challengeId,
			code: mailbox.code(),
		};
		now = new Date(codeTwo.expiresAt);
		await expect(
			verifyCode(database, config, invitation.id, expired),
		).rejects.toMatchObject(interrupted("invalid_code"));
		const codeThree = await requestCode(
			database,
			config,
			mailbox.mail,
			invitation.id,
			invitation.input,
		);
		const exchange = {
			...invitation.input,
			challengeId: codeThree.challengeId,
			code: mailbox.code(),
		};
		const verified = await verifyCode(
			database,
			config,
			invitation.id,
			exchange,
		);
		await expect(
			verifyCode(database, config, invitation.id, exchange),
		).rejects.toMatchObject(interrupted("invalid_code"));
		await expect(
			candidateRound(database, config, randomUUID(), verified.token, {
				action: "read",
			}),
		).rejects.toMatchObject(interrupted("unavailable"));
		now = new Date("2026-11-01T03:32:00Z");
		await expect(
			requestCode(
				database,
				config,
				mailbox.mail,
				invitation.id,
				invitation.input,
			),
		).rejects.toMatchObject(interrupted("rate_limited"));
		now = new Date("2026-11-01T04:30:00Z");
		await expect(
			requestCode(
				database,
				config,
				mailbox.mail,
				invitation.id,
				invitation.input,
			),
		).rejects.toMatchObject(interrupted("entry_closed"));
		await expect(
			candidateRound(database, config, id, verified.token, { action: "read" }),
		).rejects.toMatchObject(interrupted("unavailable"));
		for (let step = 0; step < 60; step++)
			await limitPublicRequests(database, config, "synthetic-peer", "verify");
		await expect(
			limitPublicRequests(database, config, "synthetic-peer", "verify"),
		).rejects.toMatchObject(interrupted("rate_limited"));
	});

	test("reassigns safely, preserves corrections, allows overtime reconnect, and revokes on closure", async () => {
		now = new Date("2026-11-01T04:21:00Z");
		const item = await candidacy();
		const { id } = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, { time: "10:00" }),
		);
		const original = await invite(id, item.email);
		const mailbox = captureMail();
		const code = await requestCode(
			database,
			config,
			mailbox.mail,
			original.id,
			original.input,
		);
		const { token } = await verifyCode(database, config, original.id, {
			...original.input,
			challengeId: code.challengeId,
			code: mailbox.code(),
		});
		await expect(
			getAssignedRound(database, id, staff.other, now),
		).rejects.toMatchObject(interrupted("not_found"));
		await expect(
			changeRound(database, config, staff.panelist, "panelist", id, {
				action: "start",
				commandId: randomUUID(),
				revision: 0,
			}),
		).rejects.toMatchObject(interrupted("candidate_not_present"));
		await candidateRound(database, config, id, token, {
			action: "confirm",
			name: "Corrected Candidate",
			years: 4.5,
		});
		expect((await getHrRound(database, id, now)).confirmedProfile).toEqual({
			name: "Corrected Candidate",
			years: 4.5,
		});
		expect((await getHrRound(database, id, now)).candidate.name).toBe(
			item.name,
		);
		await changeRound(database, config, staff.hr, "hr", id, {
			action: "reassign",
			panelistId: staff.other,
			commandId: randomUUID(),
			revision: 0,
		});
		await expect(
			getAssignedRound(database, id, staff.panelist, now),
		).rejects.toMatchObject(interrupted("not_found"));
		await expect(
			resolveStaffInvite(database, original.id, staff.panelist),
		).rejects.toMatchObject(interrupted("not_found"));
		await expect(
			resolveStaffInvite(database, original.id, staff.other),
		).resolves.toEqual({ id });
		await expect(invite(id, item.email)).resolves.toEqual(original);
		const start = {
			action: "start",
			commandId: randomUUID(),
			revision: 1,
		} as const;
		now = new Date("2026-11-01T04:21:31Z");
		await expect(
			changeRound(database, config, staff.other, "panelist", id, start),
		).rejects.toMatchObject(interrupted("candidate_not_present"));
		await candidateRound(database, config, id, token, { action: "presence" });
		await expect(
			changeRound(database, config, staff.other, "panelist", id, start),
		).resolves.toEqual({ id });
		await expect(
			changeRound(database, config, staff.other, "panelist", id, start),
		).resolves.toEqual({ id });
		const early = await candidacy(second);
		await expect(
			bookInterview(
				database,
				config,
				staff.hr,
				booking(early, { time: "09:51", duration: 5 }, staff.other),
			),
		).rejects.toMatchObject(
			interrupted("slot_conflict", {
				conflicts: [expect.objectContaining({ start: now.toISOString() })],
			}),
		);

		now = new Date("2026-11-01T05:30:00Z");
		await expect(
			candidateRound(database, config, id, token, { action: "read" }),
		).resolves.toMatchObject({ state: "active" });
		await expect(
			requestCode(database, config, mailbox.mail, original.id, original.input),
		).rejects.toMatchObject(interrupted("entry_closed"));
		const overtime = await candidacy(second);
		await expect(
			bookInterview(
				database,
				config,
				staff.hr,
				booking(overtime, { time: "11:30" }, staff.other),
			),
		).rejects.toMatchObject(
			interrupted("slot_conflict", {
				conflicts: expect.arrayContaining([
					expect.objectContaining({ id, end: null }),
				]),
			}),
		);
		const end = {
			action: "end",
			commandId: randomUUID(),
			revision: 2,
		} as const;
		await expect(
			candidateRound(database, config, id, token, end),
		).resolves.toEqual({ completed: true });
		await expect(
			candidateRound(database, config, id, token, end),
		).resolves.toEqual({ completed: true });
		await expect(
			candidateRound(database, config, id, token, {
				...end,
				commandId: randomUUID(),
			}),
		).rejects.toMatchObject(interrupted("unavailable"));
		await expect(
			candidateRound(database, config, id, token, { action: "read" }),
		).rejects.toMatchObject(interrupted("unavailable"));
		await expect(
			getAssignedRound(database, id, staff.other, now),
		).resolves.toMatchObject({ state: "awaiting_feedback" });
		expect(
			(
				await database
					.select()
					.from(interviewEvent)
					.where(eq(interviewEvent.roundId, id))
			).filter((event) => event.action === "end"),
		).toHaveLength(1);
	});

	test("replaces links and sessions, retains attempt history, and permits authorized closure", async () => {
		const item = await candidacy();
		const slot = { time: "16:00" };
		const { id } = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, slot),
		);
		const apply = (input: Parameters<typeof changeRound>[5]) =>
			changeRound(database, config, staff.hr, "hr", id, input);
		now = new Date("2026-11-01T10:25:00Z");
		const firstLink = await invite(id, item.email);
		const mailbox = captureMail();
		const entry = await requestCode(
			database,
			config,
			mailbox.mail,
			firstLink.id,
			firstLink.input,
		);
		const exchange = {
			...firstLink.input,
			challengeId: entry.challengeId,
			code: mailbox.code(),
		};
		const old = await verifyCode(database, config, firstLink.id, exchange);
		await candidateRound(database, config, id, old.token, {
			action: "confirm",
			name: "Verified Name",
			years: null,
		});
		now = new Date("2026-11-01T10:26:00Z");
		const nextEntry = await requestCode(
			database,
			config,
			mailbox.mail,
			firstLink.id,
			firstLink.input,
		);
		const next = await verifyCode(database, config, firstLink.id, {
			...firstLink.input,
			challengeId: nextEntry.challengeId,
			code: mailbox.code(),
		});
		await expect(
			candidateRound(database, config, id, old.token, { action: "read" }),
		).rejects.toMatchObject(interrupted("unavailable"));
		await expect(
			candidateRound(database, config, id, next.token, { action: "read" }),
		).resolves.toMatchObject({
			candidate: { name: "Verified Name", years: null },
			confirmed: false,
		});
		await apply({
			action: "meeting",
			revision: 0,
			commandId: randomUUID(),
			meeting: { mode: "virtual", teamsUrl: "https://example.test/meeting" },
		});
		expect((await copyInvitation(database, config, id)).text).toContain(
			"https://example.test/meeting",
		);
		expect(await invite(id, item.email)).toEqual(firstLink);
		const reschedule = {
			action: "reschedule",
			revision: 1,
			commandId: randomUUID(),
			slot: { time: "16:05", date: "2026-11-01", duration: 60 },
		} as const;
		await apply(reschedule);
		const replacement = await invite(id, item.email);
		expect(replacement.id).not.toBe(firstLink.id);
		await apply(reschedule);
		expect(await invite(id, item.email)).toEqual(replacement);
		await expect(
			candidateRound(database, config, id, next.token, { action: "read" }),
		).rejects.toMatchObject(interrupted("unavailable"));
		await expect(
			verifyCode(database, config, firstLink.id, exchange),
		).rejects.toMatchObject(interrupted("invite_unavailable"));
		await apply({
			action: "replace_link",
			revision: 2,
			commandId: randomUUID(),
		});
		await expect(
			requestCode(
				database,
				config,
				mailbox.mail,
				replacement.id,
				replacement.input,
			),
		).rejects.toMatchObject(interrupted("invite_unavailable"));
		const latest = await invite(id, item.email);
		await apply({ action: "cancel", revision: 3, commandId: randomUUID() });
		await expect(
			requestCode(database, config, mailbox.mail, latest.id, latest.input),
		).rejects.toMatchObject(interrupted("invite_unavailable"));
		const attempt = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, slot),
		);
		await expect(getHrRound(database, attempt.id, now)).resolves.toMatchObject({
			attempt: 2,
		});
		const noShow = {
			action: "no_show",
			revision: 0,
			commandId: randomUUID(),
			absent: "candidate",
			reason: "Candidate did not attend.",
		} as const;
		await expect(
			changeRound(database, config, staff.hr, "hr", attempt.id, noShow),
		).rejects.toMatchObject(interrupted("invalid_transition"));
		now = new Date("2026-11-01T11:30:00Z");
		await changeRound(database, config, staff.hr, "hr", attempt.id, noShow);
		await expect(getHrRound(database, attempt.id, now)).resolves.toMatchObject({
			state: "no_show",
			absent: "candidate",
		});
		const third = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, { time: "17:30" }),
		);
		await changeRound(database, config, staff.hr, "hr", third.id, {
			action: "withdraw",
			revision: 0,
			commandId: randomUUID(),
			reason: "Candidate withdrew.",
		});
		await expect(
			bookInterview(database, config, staff.hr, booking(item, slot)),
		).rejects.toMatchObject(interrupted("round_not_eligible"));
		const unbooked = await candidacy();
		await withdrawCandidacy(
			database,
			config,
			staff.hr,
			{ driveId: unbooked.driveId, candidateId: unbooked.id },
			{ revision: 0, commandId: randomUUID(), reason: "Candidate withdrew." },
		);
		await expect(
			bookInterview(database, config, staff.hr, booking(unbooked, slot)),
		).rejects.toMatchObject(interrupted("round_not_eligible"));

		for (const [index, actor] of ["hr", "panelist", "withdraw"].entries()) {
			const person = await candidacy();
			now = new Date(`2026-11-01T1${index}:30:00Z`);
			const slotTime = `${16 + index}:00`;
			const { id: active } = await bookInterview(
				database,
				config,
				staff.hr,
				booking(person, { time: slotTime }),
			);
			const activeLink = await invite(active, person.email);
			const challenge = await requestCode(
				database,
				config,
				mailbox.mail,
				activeLink.id,
				activeLink.input,
			);
			const { token } = await verifyCode(database, config, activeLink.id, {
				...activeLink.input,
				challengeId: challenge.challengeId,
				code: mailbox.code(),
			});
			await candidateRound(database, config, active, token, {
				action: "confirm",
				name: person.name,
				years: null,
			});
			await changeRound(database, config, staff.panelist, "panelist", active, {
				action: "start",
				revision: 0,
				commandId: randomUUID(),
			});
			if (actor === "withdraw") {
				await changeRound(database, config, staff.hr, "hr", active, {
					action: "withdraw",
					revision: 1,
					commandId: randomUUID(),
					reason: "Withdrew during the interview.",
				});
			} else {
				await changeRound(
					database,
					config,
					staff[actor === "hr" ? "hr" : "panelist"],
					actor === "hr" ? "hr" : "panelist",
					active,
					{ action: "end", revision: 1, commandId: randomUUID() },
				);
			}
			await expect(
				candidateRound(database, config, active, token, { action: "read" }),
			).rejects.toMatchObject(interrupted("unavailable"));
			await expect(getHrRound(database, active, now)).resolves.toMatchObject({
				state: actor === "withdraw" ? "withdrawn" : "awaiting_feedback",
			});
		}
		expect(
			(
				await database
					.select()
					.from(interviewRound)
					.where(eq(interviewRound.candidateId, item.id))
			)
				.map(({ attempt }) => attempt)
				.sort(),
		).toEqual([1, 2, 3]);
	});

	test("records candidate confirmation while a staff mutation holds the candidacy lock", async () => {
		const item = await candidacy();
		now = new Date("2026-11-02T03:30:00Z");
		const { id } = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, { date: "2026-11-02" }),
		);
		const invitation = await invite(id, item.email);
		const mailbox = captureMail();
		const { challengeId } = await requestCode(
			database,
			config,
			mailbox.mail,
			invitation.id,
			invitation.input,
		);
		const { token } = await verifyCode(database, config, invitation.id, {
			...invitation.input,
			challengeId,
			code: mailbox.code(),
		});

		const timer = new AbortController();
		try {
			await database.transaction(async (tx) => {
				await lockCandidacy(tx, item.driveId, item.id);
				// Candidate confirmation inserts an event while holding the round lock.
				const confirmation = candidateRound(database, config, id, token, {
					action: "confirm",
					name: item.name,
					years: null,
				});
				await expect(
					Promise.race([
						confirmation,
						delay(2_000, "blocked by candidacy lock", { signal: timer.signal }),
					]),
				).resolves.toMatchObject({ confirmed: true });
			});
		} finally {
			timer.abort();
		}
	});

	test("returns the latest authorized candidate details for a stale withdrawal", async () => {
		const item = await candidacy();
		const scope = { driveId: item.driveId, candidateId: item.id };
		const request = {
			commandId: randomUUID(),
			revision: 0,
			reason: "Candidate withdrew",
		};
		await changeCandidate(database, item.driveId, item.id, {
			type: "save",
			input: { revision: 0, name: "Current Candidate", years: 7 },
		});
		await expect(
			withdrawCandidacy(database, config, staff.hr, scope, request),
		).rejects.toMatchObject(
			interrupted("revision_conflict", {
				candidacy: {
					id: item.id,
					name: "Current Candidate",
					email: item.email,
					years: 7,
					revision: 1,
				},
			}),
		);
		await expect(
			withdrawCandidacy(database, config, staff.hr, scope, {
				...request,
				revision: 1,
			}),
		).resolves.toEqual({ id: item.id });
	});

	test("lists active and upcoming rounds before overdue ones for panelists and HR", async () => {
		const date = new Date("2026-11-04T05:00:00Z");
		const applicants = await Promise.all(
			Array.from({ length: 26 }, () =>
				candidacy(first, undefined, "Calendar Applicant"),
			),
		);
		const panelistId = await database
			.insert(user)
			.values({
				id: randomUUID(),
				name: "Calendar Panelist",
				email: `${randomUUID()}@studio.test`,
				phone: "+1 202 555 0100",
				emailVerified: true,
			})
			.returning({ id: user.id });
		const rounds = applicants.map((applicant, index) => {
			const start = new Date(date.getTime() + (index - 24) * 3_600_000);
			return {
				id: randomUUID(),
				driveId: applicant.driveId,
				candidateId: applicant.id,
				candidateName: applicant.name,
				invitedEmail: applicant.email,
				panelistId: panelistId[0].id,
				level: "l1" as const,
				attempt: 1,
				start,
				end: new Date(start.getTime() + 3_600_000),
				duration: 60,
				timeZone: "Asia/Kolkata",
				meeting: { mode: "in_person" as const, room: "Room A" },
				createdBy: staff.hr,
			};
		});
		await database.insert(interviewRound).values(rounds);
		await database
			.update(interviewRound)
			.set({
				state: "active",
				startedAt: rounds[1].start,
				startedBy: panelistId[0].id,
			})
			.where(eq(interviewRound.id, rounds[1].id));
		const currentIds = [rounds[1].id, rounds[24].id, rounds[25].id];
		const firstPage = await listAssignedRounds(
			database,
			panelistId[0].id,
			date,
			1,
		);
		const secondPage = await listAssignedRounds(
			database,
			panelistId[0].id,
			date,
			2,
		);
		expect(firstPage.hasNext).toBe(true);
		expect(firstPage.items.slice(0, 3).map(({ id }) => id)).toEqual(currentIds);
		expect(secondPage).toMatchObject({
			page: 2,
			hasNext: false,
			items: [{ id: rounds[0].id }],
		});

		const filters = { tab: "scheduled" as const, search: "Calendar Applicant" };
		const hrFirst = await listInterviews(
			database,
			{ ...filters, page: 1 },
			date,
		);
		const hrSecond = await listInterviews(
			database,
			{ ...filters, page: 2 },
			date,
		);
		expect(hrFirst.total).toBe(26);
		expect(hrFirst.items.slice(0, 3).map(({ id }) => id)).toEqual(currentIds);
		expect(hrSecond.items.map(({ id }) => id)).toEqual(
			[6, 5, 4, 3, 2, 0].map((index) => rounds[index].id),
		);
	});
});
