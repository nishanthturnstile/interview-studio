import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
	type AssessmentDraft,
	type AssessmentScorecard,
	artifactRequestLimits,
	assessmentScorecardSchema,
	type BookInterview,
	bookInterviewSchema,
	interviewListQuerySchema,
	type StaffIdentity,
	workspaceBindingHeader,
	workspaceCodeSchema,
	workspaceDescriptorSchema,
} from "@studio/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import WebSocket from "ws";
import { createApp } from "../app.ts";
import { changeCandidate, changeSkills } from "../drives/review.ts";
import { drive, driveSkills } from "../drives/schema.ts";
import { logger } from "../logger.ts";
import { session as staffSession, user } from "../staff/auth-schema.ts";
import { staffGrant } from "../staff/role-schema.ts";
import { grantStaffRole } from "../staff/roles.ts";
import {
	candidateRound,
	limitPublicRequests,
	requestCode,
	verifyCode,
} from "./admission.ts";
import {
	changeAssessment,
	correctAssessment,
	getAssessmentVersion,
	getAssignedAssessment,
	getHrAssessment,
	listAssessmentVersions,
} from "./assessments.ts";
import { interviewCandidateRoutes } from "./candidate-routes.ts";
import {
	interviewClientAddress,
	readInterviewProxyAddresses,
} from "./client-address.ts";
import { codeRunQueue, processCodeRun } from "./code-runs.ts";
import { readConcerns, saveConcern } from "./concerns.ts";
import {
	listDirectorScorecards,
	readDirectorReport,
} from "./director-report.ts";
import {
	changeFeedbackReview,
	getFeedbackReview,
	listFeedbackReviews,
} from "./feedback-reviews.ts";
import { fixtureCandidacy, fixtureReviewedSkills } from "./fixture.ts";
import {
	findPanelists,
	getAssignedRound,
	getHrRound,
	getPanelistDashboard,
	listAssignedRounds,
	listInterviews,
	listInterviewTimeline,
	listInterviewWorkspace,
	readHrInterviewDashboard,
	resolveStaffInvite,
} from "./queries.ts";
import {
	bookInterview,
	changeRound,
	copyInvitation,
	withdrawCandidacy,
} from "./scheduling.ts";
import {
	interviewArtifactRevision,
	interviewCodeRun,
	interviewEvent,
	interviewProgress,
	interviewRound,
	interviewSession,
} from "./schema.ts";
import { interviewStaffRoutes } from "./staff-routes.ts";
import {
	createInvitation,
	type InterviewConfig,
	lock,
	lockCandidacy,
	readPreferences,
	savePreferences,
} from "./store.ts";
import { resolveSlot } from "./time.ts";
import {
	readCandidateWorkspace,
	readStaffWorkspace,
	saveCandidateArtifact,
	submitCandidateCodeRun,
} from "./workspace.ts";
import { WorkspaceLive } from "./workspace-live.ts";

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

test("validates code source by UTF-8 bytes and rejects malformed text", () => {
	const source = "😀".repeat(16_384);
	for (const language of ["javascript", "python", "java"]) {
		expect(workspaceCodeSchema.safeParse({ language, source }).success).toBe(
			true,
		);
		expect(
			workspaceCodeSchema.safeParse({ language, source: `${source}x` }).success,
		).toBe(false);
	}
	expect(
		workspaceCodeSchema.safeParse({ language: "java", source: "\ud800" })
			.success,
	).toBe(false);
	expect(
		workspaceCodeSchema.safeParse({ language: "java", source: "\0" }).success,
	).toBe(false);
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
		backupHr: randomUUID(),
		panelist: randomUUID(),
		other: randomUUID(),
		pending: randomUUID(),
		director: randomUUID(),
	};
	const first = randomUUID();
	const second = randomUUID();
	const legacy = randomUUID();
	const upgradeDrive = randomUUID();
	const upgradeCases = (
		["scheduled", "active", "awaiting_feedback", "cancelled"] as const
	).map((state, index) => ({
		state,
		index,
		id: randomUUID(),
		candidateId: randomUUID(),
		email: `upgrade-${state}@example.test`,
	}));
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
	async function waitForLockedQuery(pattern: string) {
		await expect
			.poll(async () => {
				const result = await pool.query<{ blocked: boolean }>(
					"select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like $1) as blocked",
					[pattern],
				);
				return result.rows[0].blocked;
			})
			.toBe(true);
	}
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
			workflowRevision: 0,
			skillRevision: 1,
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

	function completeDraft(
		skillIds: string[],
		decision: NonNullable<AssessmentDraft["decision"]>,
	): AssessmentDraft {
		return {
			decision,
			rationale: "Evidence from the interview supports this decision.",
			notes: "Private observations",
			questions: [
				{ id: randomUUID(), text: "How did you validate the result?" },
			],
			ratings: skillIds.map((skillId) => ({
				skillId,
				rating: "not_assessed",
				feedback: "No signal in this round",
			})),
		};
	}

	beforeAll(async () => {
		await drizzle(admin).execute(sql`create database ${sql.identifier(name)}`);
		const previous = await mkdtemp(join(tmpdir(), "studio-slice4-upgrade-"));
		try {
			await cp(migrationPath, previous, { recursive: true });
			const journalPath = join(previous, "meta", "_journal.json");
			const journal = JSON.parse(await readFile(journalPath, "utf8"));
			const entries = journal.entries;
			journal.entries = entries.filter(
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
				{ role: "hr", userId: staff.backupHr },
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
				{
					id: upgradeDrive,
					clientKey: upgradeDrive,
					createdBy: staff.hr,
					name: "Upgrade Drive",
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
			journal.entries = entries.filter(
				(entry: { idx: number }) => entry.idx < 6,
			);
			await writeFile(journalPath, JSON.stringify(journal));
			await migrate(database, { migrationsFolder: previous });
			await database.transaction(async (tx) => {
				for (const { id, candidateId, email, state, index } of upgradeCases) {
					await fixtureCandidacy(tx, staff.hr, {
						id: candidateId,
						driveId: upgradeDrive,
						name: "Upgrade Applicant",
						email,
					});
					const start = new Date(Date.UTC(2032, 0, 1, 5 + index)).toISOString();
					await tx.execute(sql`
						insert into interview_round (id, drive_id, candidate_id, level, attempt, panelist_id, invited_email,
							candidate_name, starts_at, ends_at, time_zone, duration, meeting, state, created_by, started_at, closed_at)
						values (${id}, ${upgradeDrive}, ${candidateId}, 'l1', 1, ${staff.other}, ${email}, 'Upgrade Applicant',
							${start}::timestamptz, ${start}::timestamptz + interval '60 minutes', 'Asia/Kolkata', 60,
							'{"mode":"virtual","teamsUrl":null}'::jsonb, ${state}, ${staff.hr},
							case when ${state} in ('active', 'awaiting_feedback') then ${start}::timestamptz end,
							case when ${state} in ('awaiting_feedback', 'cancelled') then ${start}::timestamptz end)
					`);
					if (state === "scheduled") await createInvitation(tx, config, id);
				}
			});
			await migrate(database, {
				migrationsFolder: migrationPath,
			});
			await migrate(database, {
				migrationsFolder: migrationPath,
			});
			await database.transaction(async (tx) => {
				await fixtureReviewedSkills(tx, first, staff.hr);
				await fixtureReviewedSkills(tx, second, staff.hr);
				await fixtureReviewedSkills(tx, first, staff.hr, "l2");
				await fixtureReviewedSkills(tx, second, staff.hr, "l2");
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

	test("starts upgraded attempts with empty workspace heads and denies waiting staff reads", async () => {
		const viewer = { userId: staff.other, sessionId: randomUUID() };
		await database.insert(staffSession).values({
			id: viewer.sessionId,
			userId: viewer.userId,
			token: randomUUID(),
			expiresAt: new Date(Date.now() + 60_000),
		});
		for (const { id, state } of upgradeCases) {
			const workspace = readStaffWorkspace(database, config, id, viewer);
			if (state === "active" || state === "awaiting_feedback") {
				await expect(workspace).resolves.toMatchObject({
					active: state === "active",
					heads: {
						code: { sequence: 0, revisionId: null },
						board: { sequence: 0, revisionId: null },
					},
				});
			} else {
				await expect(workspace).rejects.toMatchObject(interrupted("not_found"));
			}
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
			listInterviews(
				database,
				interviewListQuerySchema.parse(filter),
				now,
				domains,
			);
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
		await savePreferences(database, config, promoted, {
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

	test.each([true, false])(
		"serializes the first preferences save with booking (booking first: %s)",
		async (bookingFirst) => {
			const hr = randomUUID();
			await database.insert(user).values({
				id: hr,
				name: "New HR",
				email: `${hr}@studio.test`,
				phone: "+1 202 555 0100",
				emailVerified: true,
			});
			await database.insert(staffGrant).values({ role: "hr", userId: hr });
			const item = await candidacy();
			const input = booking(item, {
				date: bookingFirst ? "2036-01-01" : "2036-01-02",
			});
			const save = () =>
				savePreferences(database, config, hr, {
					timeZone: "Asia/Kolkata",
					duration: 45,
					revision: 0,
				});
			const book = () => bookInterview(database, config, hr, input);
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holder = database.transaction(async (tx) => {
				await lock(tx, `interview:preferences:${hr}`);
				held.resolve();
				await release.promise;
			});
			await held.promise;
			const winner = bookingFirst ? book() : save();
			void winner.catch(() => {});
			let follower:
				| ReturnType<typeof save>
				| ReturnType<typeof book>
				| undefined;
			try {
				await waitForLockedQuery("%pg_advisory_xact_lock%");
				follower = bookingFirst ? save() : book();
				void follower.catch(() => {});
				await waitForLockedQuery('%from "user" where%for update');
			} finally {
				release.resolve();
				await holder;
			}
			if (bookingFirst) {
				await expect(winner).resolves.toMatchObject({ id: expect.any(String) });
				await expect(follower).resolves.toMatchObject({ revision: 1 });
			} else {
				await expect(winner).resolves.toMatchObject({ revision: 1 });
				await expect(follower).rejects.toMatchObject(
					interrupted("preferences_changed", {
						preferences: expect.objectContaining({ revision: 1 }),
					}),
				);
			}
		},
	);

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
		await expect(
			getHrRound(database, booked.id, now, domains),
		).resolves.toMatchObject({
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
		expect(
			(await getHrRound(database, id, now, domains)).confirmedProfile,
		).toEqual({
			name: "Corrected Candidate",
			years: 4.5,
		});
		expect((await getHrRound(database, id, now, domains)).candidate.name).toBe(
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
		const activeAssessment = await getAssignedAssessment(
			database,
			config,
			staff.other,
			id,
		);
		expect(activeAssessment.canEdit).toBe(true);
		await expect(
			getAssignedAssessment(database, config, staff.panelist, id),
		).rejects.toMatchObject(interrupted("not_found"));
		await expect(
			changeAssessment(database, config, staff.panelist, id, {
				action: "draft",
				commandId: randomUUID(),
				draftRevision: 0,
				content: completeDraft(
					activeAssessment.criteria?.skills.map(({ id }) => id) ?? [],
					"pass",
				),
			}),
		).rejects.toMatchObject(interrupted("not_found"));
		await expect(
			getAssignedAssessment(database, config, staff.other, id),
		).resolves.toMatchObject({ draft: { revision: 0 } });
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
		const empty = await readCandidateWorkspace(database, config, id, token);
		const { binding } = empty;
		expect(empty).toMatchObject({
			active: true,
			heads: {
				code: { sequence: 0, revisionId: null },
				board: { sequence: 0, revisionId: null },
			},
		});
		const oldEnd = {
			action: "end",
			commandId: randomUUID(),
			revision: 2,
		} as const;
		await expect(
			candidateRound(database, config, id, token, oldEnd),
		).rejects.toMatchObject(interrupted("workspace_refresh_required"));
		const firstSave = {
			commandId: randomUUID(),
			baseSequence: 0,
			payload: { language: "python", source: "  # 😀\n" },
		};
		const firstHead = await saveCandidateArtifact(
			database,
			config,
			id,
			token,
			"code",
			binding,
			firstSave,
		);
		const secondSave = {
			...firstSave,
			commandId: randomUUID(),
			baseSequence: 1,
		};
		const secondHead = await saveCandidateArtifact(
			database,
			config,
			id,
			token,
			"code",
			binding,
			secondSave,
		);
		await expect(
			saveCandidateArtifact(
				database,
				config,
				id,
				token,
				"code",
				binding,
				firstSave,
			),
		).resolves.toEqual(firstHead);
		await expect(
			saveCandidateArtifact(database, config, id, token, "board", binding, {
				...firstSave,
				payload: { elements: [] },
			}),
		).rejects.toMatchObject(interrupted("idempotency_conflict"));
		await expect(
			saveCandidateArtifact(database, config, id, token, "code", binding, {
				...secondSave,
				commandId: randomUUID(),
			}),
		).rejects.toMatchObject(
			interrupted("workspace_conflict", { kind: "code", head: secondHead }),
		);
		const board = {
			elements: [
				{
					id: "mark",
					type: "rectangle" as const,
					x: 12,
					y: 24,
					width: 80,
					height: 45,
					strokeColor: "#123456",
					backgroundColor: "transparent",
					angle: 0,
					fillStyle: "solid" as const,
					strokeWidth: 1,
					strokeStyle: "solid" as const,
					seed: 8,
					roughness: 0,
					opacity: 100,
					roundness: null,
					groupIds: [],
					boundElements: null,
					locked: false,
				},
			],
		};
		const boardHead = await saveCandidateArtifact(
			database,
			config,
			id,
			token,
			"board",
			binding,
			{
				commandId: randomUUID(),
				baseSequence: 0,
				payload: board,
			},
		);
		await expect(
			saveCandidateArtifact(database, config, id, token, "board", binding, {
				commandId: randomUUID(),
				baseSequence: 1,
				payload: {
					elements: [
						{ ...board.elements[0], link: "https://unsupported.invalid" },
					],
				},
			}),
		).rejects.toMatchObject(interrupted("workspace_invalid"));

		const end = {
			action: "end",
			commandId: randomUUID(),
			revision: 2,
			binding,
			expectedHeads: {
				code: secondHead.revisionId,
				board: boardHead.revisionId,
			},
		} as const;
		await expect(
			candidateRound(database, config, id, token, {
				...end,
				expectedHeads: {
					code: firstHead.revisionId,
					board: boardHead.revisionId,
				},
			}),
		).rejects.toMatchObject(interrupted("workspace_conflict"));
		await expect(
			readCandidateWorkspace(
				database,
				config,
				id,
				token,
				"code",
				"A".repeat(43),
			),
		).rejects.toMatchObject(interrupted("workspace_binding_changed"));
		const viewer = { userId: staff.other, sessionId: randomUUID() };
		await database.insert(staffSession).values({
			id: viewer.sessionId,
			userId: viewer.userId,
			token: randomUUID(),
			expiresAt: new Date(Date.now() + 60_000),
		});
		const observation = {
			commandId: randomUUID(),
			context: "While diagramming an example",
			observation: "Asked to clarify the prior answer",
		};
		const concern = await saveConcern(
			database,
			config,
			id,
			viewer,
			observation,
		);
		await expect(readConcerns(database, config, id, viewer)).resolves.toEqual({
			canAdd: true,
			entries: [concern],
		});

		const assigned = await readStaffWorkspace(database, config, id, viewer);
		expect(assigned).toMatchObject({
			active: true,
			heads: { code: secondHead },
		});
		await expect(
			readStaffWorkspace(database, config, id, {
				...viewer,
				userId: staff.panelist,
			}),
		).rejects.toMatchObject(interrupted("not_found"));
		const queue = new PgBoss({
			connectionString: target.href,
			schedule: false,
			supervise: false,
		});
		try {
			await queue.start();
			await queue.createQueue(codeRunQueue, { policy: "singleton" });
			const command = {
				commandId: randomUUID(),
				language: "python",
				source: "print(input())\n",
				input: "Hello\n",
			};
			const enabled = { ...config, codeExecutionEnabled: true };
			const submit = (
				data: typeof command,
				boss: Pick<PgBoss, "send"> = queue,
			) =>
				submitCandidateCodeRun(
					database,
					enabled,
					boss,
					id,
					token,
					binding,
					data,
				);
			await expect(submit(command)).rejects.toMatchObject(
				interrupted("code_run_disabled"),
			);
			await database
				.update(interviewRound)
				.set({ codeExecutionEnabled: true })
				.where(eq(interviewRound.id, id));
			await expect(
				submit(command, { send: async () => null }),
			).rejects.toMatchObject(interrupted("code_run_unavailable"));
			const [queued, repeated] = await Promise.all([
				submit(command),
				submit(command),
			]);
			expect(queued).toEqual(repeated);
			expect(queued.state).toBe("queued");
			expect(await queue.getJobById(codeRunQueue, queued.id)).toMatchObject({
				data: { roundId: id, runId: queued.id },
			});
			await expect(
				submit({ ...command, input: "different" }),
			).rejects.toMatchObject(interrupted("idempotency_conflict"));
			await expect(
				submit({ ...command, commandId: randomUUID() }),
			).rejects.toMatchObject(interrupted("code_run_pending"));
			let dispatches = 0;
			const execute = async (
				program: Pick<typeof command, "language" | "source" | "input">,
			) => {
				dispatches++;
				expect(program).toMatchObject({
					language: command.language,
					source: command.source,
					input: command.input,
				});
				return {
					state: "succeeded",
					stdout: program.input,
					stderr: "",
				} as const;
			};
			await processCodeRun(database, id, queued.id, execute);
			await processCodeRun(database, id, queued.id, execute);
			await expect(
				readStaffWorkspace(
					database,
					config,
					id,
					viewer,
					undefined,
					assigned.binding,
					{ runId: queued.id },
				),
			).resolves.toMatchObject({ state: "succeeded", stdout: "Hello\n" });
			const recovering = await submit({ ...command, commandId: randomUUID() });
			await database
				.update(interviewCodeRun)
				.set({ state: "running" })
				.where(eq(interviewCodeRun.id, recovering.id));
			await processCodeRun(database, id, recovering.id, execute);
			await expect(
				readCandidateWorkspace(
					database,
					config,
					id,
					token,
					undefined,
					binding,
					{ runId: recovering.id },
				),
			).resolves.toMatchObject({ state: "interrupted" });
			const disabled = await submit({ ...command, commandId: randomUUID() });
			await database
				.update(interviewRound)
				.set({ codeExecutionEnabled: false })
				.where(eq(interviewRound.id, id));
			await processCodeRun(database, id, disabled.id, execute);
			await expect(
				readCandidateWorkspace(
					database,
					config,
					id,
					token,
					undefined,
					binding,
					{},
				),
			).resolves.toMatchObject({
				executionEnabled: false,
				latestRun: { id: disabled.id, state: "interrupted" },
			});
			expect(dispatches).toBe(1);
		} finally {
			await queue.stop();
		}
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
		await expect(
			readCandidateWorkspace(database, config, id, token, "code", binding),
		).rejects.toMatchObject(interrupted("unavailable"));
		await expect(
			readStaffWorkspace(
				database,
				config,
				id,
				viewer,
				"code",
				assigned.binding,
			),
		).resolves.toMatchObject({ ...secondHead, payload: secondSave.payload });
		await expect(
			readStaffWorkspace(
				database,
				config,
				id,
				viewer,
				"board",
				assigned.binding,
			),
		).resolves.toMatchObject({ ...boardHead, payload: board });
		await expect(
			saveConcern(database, config, id, viewer, observation),
		).resolves.toEqual(concern);
		await expect(
			saveConcern(database, config, id, viewer, {
				...observation,
				commandId: randomUUID(),
			}),
		).rejects.toMatchObject(interrupted("invalid_transition"));
		await expect(readConcerns(database, config, id, viewer)).resolves.toEqual({
			canAdd: false,
			entries: [concern],
		});

		const [retained] = await database
			.select()
			.from(interviewArtifactRevision)
			.where(eq(interviewArtifactRevision.id, firstHead.revisionId));
		expect(retained.payload).toEqual(firstSave.payload);
		await database
			.delete(staffSession)
			.where(eq(staffSession.id, viewer.sessionId));
		await expect(
			readStaffWorkspace(
				database,
				config,
				id,
				viewer,
				"code",
				assigned.binding,
			),
		).rejects.toMatchObject(interrupted("not_found"));
		expect(
			(
				await database
					.select()
					.from(interviewEvent)
					.where(eq(interviewEvent.roundId, id))
			).filter((event) => event.action === "end"),
		).toHaveLength(1);
	});

	test("upgrades a bound candidate session and delivers only committed head metadata", async () => {
		now = new Date("2031-12-12T06:21:00Z");
		const item = await candidacy();
		const { id } = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, { date: "2031-12-12", time: "12:00" }),
		);
		const entry = await invite(id, item.email);
		const mailbox = captureMail();
		const challenge = await requestCode(
			database,
			config,
			mailbox.mail,
			entry.id,
			entry.input,
		);
		const { token } = await verifyCode(database, config, entry.id, {
			...entry.input,
			challengeId: challenge.challengeId,
			code: mailbox.code(),
		});
		await candidateRound(database, config, id, token, {
			action: "confirm",
			name: "Live Test",
			years: 1,
		});
		const live = new WorkspaceLive(target.href);
		const routes = interviewCandidateRoutes(
			database,
			config,
			{ trustedOrigins: [config.origin], secureCookies: false },
			mailbox.mail,
			live,
		);
		const app = createApp(
			async () => ({ database: true, worker: true, storage: true }),
			logger.child({}, { level: "silent" }),
			undefined,
			routes,
		);
		const { promise: bound, resolve } = Promise.withResolvers<number>();
		const server = serve(
			{
				fetch: app.fetch,
				port: 0,
				hostname: "127.0.0.1",
				websocket: { server: live.server },
			},
			({ port }) => resolve(port),
		);
		const port = await bound;
		const path = `/api/interviews/rounds/${id}`;
		const origin = `http://127.0.0.1:${port}`;
		const cookie = `studio-candidate=${token}`;
		let socket: WebSocket | undefined;
		function connect(browserOrigin: string, candidateCookie?: string) {
			return new Promise<{ status: number; socket?: WebSocket }>(
				(resolve, reject) => {
					const client = new WebSocket(`ws://127.0.0.1:${port}${path}/live`, {
						origin: browserOrigin,
						headers: {
							...(candidateCookie ? { Cookie: candidateCookie } : {}),
						},
						handshakeTimeout: 2_000,
					});
					client.once("open", () => resolve({ status: 101, socket: client }));
					client.once("unexpected-response", (_, response) => {
						resolve({ status: response.statusCode ?? 0 });
						response.resume();
						client.terminate();
					});
					client.on("error", reject);
				},
			);
		}
		try {
			expect((await connect("https://other.invalid", cookie)).status).toBe(403);
			await expect
				.poll(async () => (await connect(config.origin)).status)
				.toBe(401);
			expect((await connect(config.origin, cookie)).status).toBe(404);
			await changeRound(database, config, staff.panelist, "panelist", id, {
				action: "start",
				commandId: randomUUID(),
				revision: 0,
			});
			const response = await fetch(`${origin}${path}/workspace`, {
				headers: { Cookie: cookie },
			});
			const { binding } = workspaceDescriptorSchema.parse(
				await response.json(),
			);
			const opened = await connect(config.origin, cookie);
			socket = opened.socket;
			if (!socket) throw new Error(`Socket upgrade returned ${opened.status}`);
			const nextMessage = async () => {
				const [frame] = await once(socket as WebSocket, "message", {
					signal: AbortSignal.timeout(2_000),
				});
				return JSON.parse(frame.toString());
			};
			const ready = nextMessage();
			socket.send(JSON.stringify({ type: "bind", binding }));
			expect(await ready).toEqual({ type: "ready" });
			const changed = nextMessage();
			const payload = JSON.stringify({
				commandId: randomUUID(),
				baseSequence: 0,
				payload: { language: "java", source: "  // observable 😀" },
			});
			const bytes = new TextEncoder().encode(payload);
			const exact =
				payload + " ".repeat(artifactRequestLimits.code - bytes.byteLength);
			const headers = {
				Origin: config.origin,
				Cookie: cookie,
				[workspaceBindingHeader]: binding,
				"Content-Type": "application/json",
			};
			const endpoint = `${origin}${path}/workspace/code`;
			expect(
				(await fetch(endpoint, { method: "POST", headers, body: `${exact} ` }))
					.status,
			).toBe(413);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.enqueue(
						new TextEncoder().encode(
							" ".repeat(artifactRequestLimits.code - bytes.byteLength + 1),
						),
					);
					controller.close();
				},
			});
			expect(
				(
					await fetch(endpoint, {
						method: "POST",
						headers,
						body: stream,
						duplex: "half",
					} as RequestInit)
				).status,
			).toBe(413);
			const save = await fetch(endpoint, {
				method: "POST",
				headers,
				body: exact,
			});
			expect(save.status).toBe(200);
			expect(await changed).toEqual({
				type: "head-changed",
				kind: "code",
				sequence: 1,
			});
			const replaced = nextMessage();
			now = new Date(now.getTime() + 61_000);
			const newChallenge = await requestCode(
				database,
				config,
				mailbox.mail,
				entry.id,
				entry.input,
			);
			const replacement = await verifyCode(database, config, entry.id, {
				...entry.input,
				challengeId: newChallenge.challengeId,
				code: mailbox.code(),
			});
			const newCookie = `studio-candidate=${replacement.token}`;
			expect(await replaced).toEqual({ type: "access-ended" });
			expect(
				(
					await fetch(`${origin}${path}/workspace`, {
						headers: { Cookie: newCookie },
					})
				).status,
			).toBe(404);
			await candidateRound(database, config, id, replacement.token, {
				action: "confirm",
				name: "Replacement Session",
				years: 2,
			});
			const bound = await fetch(`${origin}${path}/workspace`, {
				headers: { Cookie: newCookie },
			});
			const rebound = workspaceDescriptorSchema.parse(await bound.json());
			expect(rebound.heads.code.sequence).toBe(1);
			expect(rebound.binding).not.toBe(binding);
			expect(
				(
					await fetch(`${origin}${path}/workspace/code`, {
						headers: { Cookie: newCookie, [workspaceBindingHeader]: binding },
					})
				).status,
			).toBe(403);
			expect(
				(
					await fetch(`${origin}${path}/end`, {
						method: "POST",
						headers: {
							Origin: config.origin,
							Cookie: newCookie,
							[workspaceBindingHeader]: binding,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							commandId: randomUUID(),
							revision: 0,
							expectedHeads: {
								code: rebound.heads.code.revisionId,
								board: null,
							},
						}),
					})
				).status,
			).toBe(403);
			const replacementSocket = await connect(config.origin, newCookie);
			if (!replacementSocket.socket)
				throw new Error(
					`Replacement socket returned ${replacementSocket.status}`,
				);
			socket = replacementSocket.socket;
			const reboundReady = nextMessage();
			socket.send(JSON.stringify({ type: "bind", binding: rebound.binding }));
			expect(await reboundReady).toEqual({ type: "ready" });
			const closed = nextMessage();
			await changeRound(database, config, staff.panelist, "panelist", id, {
				action: "end",
				commandId: randomUUID(),
				revision: 1,
			});
			expect(await closed).toEqual({ type: "access-ended" });
			expect(
				(
					await fetch(`${origin}${path}/workspace/code`, {
						headers: {
							Cookie: newCookie,
							[workspaceBindingHeader]: rebound.binding,
						},
					})
				).status,
			).toBe(404);
		} finally {
			socket?.terminate();
			await live.stop();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
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
		const attempt = await bookInterview(database, config, staff.hr, {
			...booking(item, slot),
			workflowRevision: 2,
		});
		await expect(
			getHrRound(database, attempt.id, now, domains),
		).resolves.toMatchObject({
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
		await expect(
			listInterviewWorkspace(
				database,
				{ tab: "queue", search: item.email, page: 1 },
				now,
				domains,
			),
		).resolves.toMatchObject({
			items: [
				{ id: item.id, action: "review_attendance", round: { id: attempt.id } },
			],
		});
		await changeRound(database, config, staff.hr, "hr", attempt.id, noShow);
		await expect(
			getHrRound(database, attempt.id, now, domains),
		).resolves.toMatchObject({
			state: "no_show",
			absent: "candidate",
		});
		await expect(
			listInterviewWorkspace(
				database,
				{ tab: "history", search: item.email, page: 1 },
				now,
				domains,
			),
		).resolves.toMatchObject({ items: [] });
		await expect(
			listInterviewTimeline(
				database,
				{ driveId: item.driveId, candidateId: item.id },
				1,
				now,
				domains,
			),
		).resolves.toMatchObject({
			items: [{ state: "cancelled" }, { state: "no_show" }],
		});
		const third = await bookInterview(database, config, staff.hr, {
			...booking(item, { time: "17:30" }),
			workflowRevision: 4,
		});
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
			{
				revision: 0,
				workflowRevision: 0,
				commandId: randomUUID(),
				reason: "Candidate withdrew.",
			},
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
			await expect(
				getHrRound(database, active, now, domains),
			).resolves.toMatchObject({
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
			workflowRevision: 0,
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
			domains,
		);
		const hrSecond = await listInterviews(
			database,
			{ ...filters, page: 2 },
			date,
			domains,
		);
		expect(hrFirst.total).toBe(26);
		expect(hrFirst.items.slice(0, 3).map(({ id }) => id)).toEqual(currentIds);
		expect(hrSecond.items.map(({ id }) => id)).toEqual(
			[6, 5, 4, 3, 2, 0].map((index) => rounds[index].id),
		);

		const feedbackRounds = [0, 2, 3, 4].map((index) => rounds[index].id);
		await database
			.update(interviewRound)
			.set({ state: "awaiting_feedback", closedAt: sql`${interviewRound.end}` })
			.where(inArray(interviewRound.id, feedbackRounds));
		const arriving = rounds[24];
		await database.transaction((tx) =>
			createInvitation(tx, config, arriving.id),
		);
		const entry = await invite(arriving.id, arriving.invitedEmail);
		await database.insert(interviewSession).values({
			roundId: arriving.id,
			invitationId: entry.id,
			tokenHash: randomUUID(),
			admittedAt: date,
			confirmedAt: date,
			lastSeenAt: date,
		});
		const assignee = panelistId[0].id;
		const dashboard = await getPanelistDashboard(database, assignee, date);
		expect(dashboard.attention).toMatchObject({
			total: 6,
			items: [
				{ id: rounds[1].id, state: "active" },
				{ id: arriving.id, state: "scheduled", connected: true },
				{ id: feedbackRounds[0], state: "awaiting_feedback" },
			],
		});
		expect(dashboard.upcoming).toMatchObject({
			total: 1,
			items: [{ id: rounds[25].id }],
		});
		const attention = await listAssignedRounds(
			database,
			assignee,
			date,
			1,
			"attention",
		);
		expect(attention.items.map(({ id }) => id)).toEqual([
			rounds[1].id,
			arriving.id,
			...feedbackRounds,
		]);
		const disconnected = await getPanelistDashboard(
			database,
			assignee,
			new Date(date.getTime() + 31_000),
		);
		expect(disconnected.upcoming.items.map(({ id }) => id)).toEqual([
			arriving.id,
			rounds[25].id,
		]);
		expect(disconnected.attention.total).toBe(5);
	});

	test.each(["pass", "do_not_proceed", "incomplete"] as const)(
		"preserves and submits L1 %s with the correct scheduling outcome",
		async (decision) => {
			const slots = {
				pass: "10:00",
				do_not_proceed: "11:00",
				incomplete: "12:00",
			};
			const item = await candidacy();
			const request = booking(item, {
				date: "2033-01-01",
				time: slots[decision],
			});
			const { id } = await bookInterview(database, config, staff.hr, request);
			const read = () =>
				getAssignedAssessment(database, config, staff.panelist, id);
			const send = (input: Parameters<typeof changeAssessment>[4]) =>
				changeAssessment(database, config, staff.panelist, id, input);
			const command = {
				commandId: randomUUID(),
				action: "submit",
				draftRevision: 0,
				attemptRevision: 0,
			} as const;
			const booked = await read();
			expect(booked).toMatchObject({
				criteria: { skillRevision: 1, source: "booking" },
				canSubmit: false,
				canEdit: false,
			});
			await expect(
				getAssignedAssessment(database, config, staff.other, id),
			).rejects.toMatchObject(interrupted("not_found"));
			await expect(
				getHrAssessment(database, config, staff.hr, id),
			).rejects.toMatchObject(interrupted("not_found"));
			await expect(send(command)).rejects.toMatchObject(
				interrupted("invalid_transition"),
			);
			await database
				.update(interviewRound)
				.set({ state: "active" })
				.where(eq(interviewRound.id, id));
			const content = completeDraft(
				booked.criteria?.skills.map(({ id }) => id) ?? [],
				decision,
			);
			const save = {
				action: "draft",
				commandId: randomUUID(),
				draftRevision: 0,
				content,
			} as const;
			await expect(
				changeAssessment(database, config, staff.other, id, save),
			).rejects.toMatchObject(interrupted("not_found"));
			await expect(
				changeAssessment(database, config, staff.hr, id, save),
			).rejects.toMatchObject(interrupted("not_found"));
			await expect(
				send({
					...save,
					content: {
						...content,
						ratings: [
							{ skillId: randomUUID(), rating: "not_assessed", feedback: "" },
						],
					},
				}),
			).rejects.toMatchObject(interrupted("invalid_input"));
			await send(save);
			await send(save);
			await expect(read()).resolves.toMatchObject({
				draft: { revision: 1, content },
			});
			await expect(
				send({ ...save, commandId: randomUUID() }),
			).rejects.toMatchObject(
				interrupted("draft_changed", {
					assessment: expect.objectContaining({
						draft: expect.objectContaining({ revision: 1, content }),
					}),
				}),
			);
			await expect(
				send({ ...command, draftRevision: 1 }),
			).rejects.toMatchObject(interrupted("invalid_transition"));
			await changeRound(database, config, staff.panelist, "panelist", id, {
				action: "end",
				commandId: randomUUID(),
				revision: 0,
			});
			await expect(
				send({ ...command, attemptRevision: 1 }),
			).rejects.toMatchObject(interrupted("draft_changed"));
			await expect(
				send({ ...command, draftRevision: 1 }),
			).rejects.toMatchObject(
				interrupted("revision_conflict", {
					assessment: expect.objectContaining({
						attemptRevision: 1,
						canSubmit: true,
					}),
				}),
			);
			const submit = { ...command, draftRevision: 1, attemptRevision: 1 };
			const [version, retry] = await Promise.all([send(submit), send(submit)]);
			expect(retry).toEqual(version);
			await expect(
				send({ ...submit, commandId: randomUUID() }),
			).rejects.toMatchObject(interrupted("invalid_transition"));
			await expect(read()).resolves.toMatchObject({
				canEdit: false,
				canSubmit: false,
				draft: { content },
				submitted: {
					...version,
					decision,
					version: 1,
					author: { id: staff.panelist },
				},
			});
			const hr = await getHrAssessment(database, config, staff.hr, id);
			expect(hr.submitted).toMatchObject({
				decision,
				ratings: content.ratings,
			});
			expect(hr).not.toHaveProperty("draft");
			expect(hr.submitted).not.toHaveProperty("notes");
			expect(hr.submitted).not.toHaveProperty("questions");
			const readTab = (tab: "queue" | "history") =>
				listInterviews(
					database,
					interviewListQuerySchema.parse({ tab, search: item.email }),
					now,
					domains,
				);
			await expect(readTab("history")).resolves.toMatchObject({
				items: [{ id, state: "feedback_submitted", decision }],
			});
			const rebook = {
				...request,
				commandId: randomUUID(),
				workflowRevision: 2,
			};
			if (decision === "incomplete") {
				await expect(readTab("queue")).resolves.toMatchObject({
					items: [
						{ id: item.id, level: "l1", lastAttempt: 1, workflowRevision: 2 },
					],
				});
				await expect(
					bookInterview(database, config, staff.hr, {
						...rebook,
						workflowRevision: 1,
					}),
				).rejects.toMatchObject(interrupted("workflow_changed"));
				const fresh = await bookInterview(database, config, staff.hr, rebook);
				expect(fresh.id).not.toBe(id);
				await expect(
					getHrRound(database, fresh.id, now, domains),
				).resolves.toMatchObject({ attempt: 2 });
				await expect(read()).resolves.toMatchObject({
					draft: { content },
					submitted: version,
				});
			} else {
				await expect(readTab("queue")).resolves.toMatchObject({
					items:
						decision === "pass"
							? [
									{
										id: item.id,
										level: "l2",
										lastAttempt: 0,
										workflowRevision: 2,
										qualifyingL1RoundId: id,
									},
								]
							: [],
				});
				await expect(
					bookInterview(database, config, staff.hr, rebook),
				).rejects.toMatchObject(interrupted("round_not_eligible"));
			}
		},
	);

	test("preserves upgraded rounds, allows closure before skills review, and freezes each snapshot once", async () => {
		const [scheduled, active, awaiting, cancelled] = upgradeCases;
		const today = { ...config, clock: () => new Date("2032-01-01T05:10:00Z") };
		const read = (id: string) =>
			getAssignedAssessment(database, today, staff.other, id);
		const initialize = (id: string) =>
			changeAssessment(database, today, staff.other, id, {
				action: "initialize",
				commandId: randomUUID(),
			});
		await expect(read(scheduled.id)).resolves.toMatchObject({
			status: "unavailable",
		});
		await expect(read(cancelled.id)).resolves.toMatchObject({
			status: "unavailable",
		});
		await expect(read(active.id)).resolves.toMatchObject({
			status: "skills_need_review",
		});
		await expect(initialize(active.id)).rejects.toMatchObject(
			interrupted("skills_need_review"),
		);
		const close = (id: string, revision: number) =>
			changeRound(database, today, staff.other, "panelist", id, {
				action: "end",
				commandId: randomUUID(),
				revision,
			});
		await close(active.id, 0);
		const oldInvite = await invite(scheduled.id, scheduled.email);
		const mailbox = captureMail();
		const challenge = await requestCode(
			database,
			today,
			mailbox.mail,
			oldInvite.id,
			oldInvite.input,
		);
		const { token } = await verifyCode(database, today, oldInvite.id, {
			...oldInvite.input,
			challengeId: challenge.challengeId,
			code: mailbox.code(),
		});
		await candidateRound(database, today, scheduled.id, token, {
			action: "confirm",
			name: "Upgraded Applicant",
			years: null,
		});
		await changeRound(database, today, staff.other, "panelist", scheduled.id, {
			action: "start",
			revision: 0,
			commandId: randomUUID(),
		});
		await database.transaction((tx) =>
			fixtureReviewedSkills(tx, upgradeDrive, staff.hr),
		);
		const [opened, retried] = await Promise.all([
			initialize(scheduled.id),
			initialize(scheduled.id),
		]);
		expect(retried).toEqual(opened);
		await close(scheduled.id, 1);
		const original = (await read(scheduled.id)).criteria;
		expect(original).toMatchObject({
			source: "after_booking",
			skillRevision: 1,
		});
		if (!original) throw new Error("Missing legacy criteria");
		const staffLocked = Promise.withResolvers<void>();
		const releaseStaff = Promise.withResolvers<void>();
		const staffLock = database.transaction(async (tx) => {
			await tx
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, staff.other))
				.for("update");
			staffLocked.resolve();
			await releaseStaff.promise;
		});
		await staffLocked.promise;
		const initializing = initialize(active.id);
		let saving: ReturnType<typeof changeSkills> | undefined;
		try {
			await waitForLockedQuery('%from "user" where%for update');
			saving = changeSkills(database, upgradeDrive, "l1", {
				type: "save",
				input: {
					revision: 1,
					skills: original.skills
						.toReversed()
						.map(({ id, name }) => ({ id, name: `Revised ${name}` })),
				},
			});
			await waitForLockedQuery('%from "drive_skills" where%for update');
		} finally {
			releaseStaff.resolve();
			await staffLock;
		}
		const [, edited] = await Promise.all([initializing, saving]);
		if (!edited) throw new Error("Skills save did not run");
		await expect(initialize(awaiting.id)).rejects.toMatchObject(
			interrupted("skills_need_review"),
		);
		await expect(read(active.id)).resolves.toMatchObject({
			criteria: original,
		});
		const candidacyLocked = Promise.withResolvers<void>();
		const releaseCandidacy = Promise.withResolvers<void>();
		const candidacyLock = database.transaction(async (tx) => {
			await lockCandidacy(tx, upgradeDrive, awaiting.candidateId);
			candidacyLocked.resolve();
			await releaseCandidacy.promise;
		});
		await candidacyLocked.promise;
		const waiting = initialize(awaiting.id);
		let reviewed: Awaited<ReturnType<typeof changeSkills>>;
		try {
			await waitForLockedQuery(
				'%from "drive_candidate" where%for no key update',
			);
			reviewed = await changeSkills(database, upgradeDrive, "l1", {
				type: "review",
				reviewerId: staff.hr,
				input: { revision: edited.revision },
			});
		} finally {
			releaseCandidacy.resolve();
			await candidacyLock;
		}
		await waiting;
		await expect(read(awaiting.id)).resolves.toMatchObject({
			criteria: {
				source: "after_booking",
				skills: reviewed.skills,
				skillRevision: reviewed.revision,
			},
		});
		for (const { id } of [scheduled, active, awaiting]) {
			const view = await read(id);
			const content = completeDraft(
				view.criteria?.skills.map((skill) => skill.id) ?? [],
				"pass",
			);
			await changeAssessment(database, today, staff.other, id, {
				action: "draft",
				commandId: randomUUID(),
				draftRevision: 0,
				content,
			});
			await changeAssessment(database, today, staff.other, id, {
				action: "submit",
				commandId: randomUUID(),
				draftRevision: 1,
				attemptRevision: view.attemptRevision,
			});
			await expect(read(id)).resolves.toMatchObject({
				submitted: { decision: "pass" },
			});
		}
		const next = await candidacy(upgradeDrive);
		const newRequest = booking(next, { date: "2033-02-01", time: "10:00" });
		await expect(
			bookInterview(database, config, staff.hr, newRequest),
		).rejects.toMatchObject(
			interrupted("skills_changed", { criteria: reviewed }),
		);
		const fresh = await bookInterview(database, config, staff.hr, {
			...newRequest,
			skillRevision: reviewed.revision,
		});
		await expect(
			getAssignedAssessment(database, config, staff.panelist, fresh.id),
		).resolves.toMatchObject({
			criteria: {
				source: "booking",
				skills: reviewed.skills,
				skillRevision: reviewed.revision,
			},
		});
	});

	test.each([
		["active", "2033-03-01"],
		["awaiting_feedback", "2033-03-02"],
		["feedback_submitted", "2033-03-03"],
	] as const)(
		"checks HR recovery after a panelist changes roles in %s",
		async (state, date) => {
			const item = await candidacy();
			const panelistId = randomUUID();
			await database.insert(user).values({
				id: panelistId,
				name: "Temporary panelist",
				email: `${panelistId}@studio.test`,
				phone: "+1 202 555 0100",
				emailVerified: true,
			});
			const request = booking(item, { date, time: "10:00" }, panelistId);
			const { id } = await bookInterview(database, config, staff.hr, request);
			await database
				.update(interviewRound)
				.set({ state: "active" })
				.where(eq(interviewRound.id, id));
			const starting = await getAssignedAssessment(
				database,
				config,
				panelistId,
				id,
			);
			const content = completeDraft(
				starting.criteria?.skills.map(({ id }) => id) ?? [],
				"incomplete",
			);
			await changeAssessment(database, config, panelistId, id, {
				action: "draft",
				commandId: randomUUID(),
				draftRevision: 0,
				content,
			});
			const cancel = {
				action: "cancel_unavailable_panelist",
				revision: 1,
				commandId: randomUUID(),
				reason: "Panelist changed roles",
			} as const;
			const hrChange = (input: Parameters<typeof changeRound>[5]) =>
				changeRound(database, config, staff.hr, "hr", id, input);
			const close = () =>
				hrChange({ action: "end", revision: 0, commandId: randomUUID() });
			if (state !== "active") {
				await close();
				await expect(hrChange(cancel)).rejects.toMatchObject(
					interrupted("invalid_transition"),
				);
				expect(
					(await getHrRound(database, id, now, domains))
						.canCancelUnavailablePanelist,
				).toBe(false);
			}
			const submit = {
				action: "submit",
				commandId: randomUUID(),
				draftRevision: 1,
				attemptRevision: 1,
			} as const;
			if (state === "feedback_submitted")
				await changeAssessment(database, config, panelistId, id, submit);
			await grantStaffRole(database, domains, staff.director, panelistId, "hr");
			await expect(
				getAssignedAssessment(database, config, panelistId, id),
			).rejects.toMatchObject(interrupted("forbidden"));
			if (state === "feedback_submitted") {
				await expect(
					hrChange({ ...cancel, revision: 2 }),
				).rejects.toMatchObject(interrupted("invalid_transition"));
				await expect(
					getHrAssessment(database, config, staff.hr, id),
				).resolves.toMatchObject({
					submitted: { decision: "incomplete", version: 1 },
				});
				return;
			}
			if (state === "active") {
				await expect(
					hrChange({ ...cancel, revision: 0 }),
				).rejects.toMatchObject(interrupted("invalid_transition"));
				await close();
			}
			const closed = await getHrRound(database, id, now, domains);
			expect(closed.canCancelUnavailablePanelist).toBe(true);
			await expect(
				listInterviewWorkspace(
					database,
					{ tab: "queue", search: item.email, page: 1 },
					now,
					domains,
				),
			).resolves.toMatchObject({
				items: [{ id: item.id, action: "replace_panelist", round: { id } }],
			});
			await expect(
				listInterviewWorkspace(
					database,
					{ tab: "awaiting", search: item.email, page: 1 },
					now,
					domains,
				),
			).resolves.toMatchObject({ items: [] });
			await expect(
				changeAssessment(database, config, panelistId, id, submit),
			).rejects.toMatchObject(interrupted("forbidden"));
			await hrChange(cancel);
			await expect(hrChange(cancel)).resolves.toEqual({ id });
			const [cancelled] = await database
				.select()
				.from(interviewRound)
				.where(eq(interviewRound.id, id));
			expect(cancelled).toMatchObject({
				cancellationCode: "panelist_unavailable",
				cancelledAt: now,
			});
			await expect(
				getHrRound(database, id, now, domains),
			).resolves.toMatchObject({
				state: "cancelled",
				closedAt: closed.closedAt,
				reason: cancel.reason,
				canCancelUnavailablePanelist: false,
			});
			await expect(
				getHrAssessment(database, config, staff.hr, id),
			).rejects.toMatchObject(interrupted("not_found"));
			const next = await bookInterview(database, config, staff.hr, {
				...request,
				commandId: randomUUID(),
				panelistId: staff.panelist,
				workflowRevision: 2,
			});
			await expect(
				getAssignedAssessment(database, config, staff.panelist, next.id),
			).resolves.toMatchObject({
				draft: { revision: 0, content: { notes: "", questions: [] } },
			});
			await database
				.delete(staffGrant)
				.where(eq(staffGrant.userId, panelistId));
			await expect(
				getAssignedAssessment(database, config, panelistId, id),
			).resolves.toMatchObject({
				canEdit: false,
				canSubmit: false,
				draft: { revision: 1, content },
			});
			await expect(
				getAssignedAssessment(database, config, staff.panelist, id),
			).rejects.toMatchObject(interrupted("not_found"));
		},
	);

	test("serializes bookings with changes to reviewed drive skills in either order", async () => {
		const driveId = randomUUID();
		await database.transaction(async (tx) => {
			await tx.insert(drive).values({
				id: driveId,
				clientKey: driveId,
				createdBy: staff.hr,
				name: "Snapshot Race Drive",
			});
			await fixtureReviewedSkills(tx, driveId, staff.hr);
		});
		const first = await candidacy(driveId);
		const second = await candidacy(driveId);
		const editSkills = (revision: number) =>
			changeSkills(database, driveId, "l1", {
				type: "save",
				input: { revision, skills: [{ name: `Updated criteria ${revision}` }] },
			});
		const { promise: staffLocked, resolve: signalStaffLock } =
			Promise.withResolvers<void>();
		const { promise: releaseStaff, resolve: unlockStaff } =
			Promise.withResolvers<void>();
		const staffLock = database.transaction(async (tx) => {
			await tx
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, staff.panelist))
				.for("update");
			signalStaffLock();
			await releaseStaff;
		});
		await staffLocked;
		const bookingFirst = bookInterview(
			database,
			config,
			staff.hr,
			booking(first, { date: "2033-04-01", time: "10:00" }),
		);
		let editing: ReturnType<typeof editSkills> | undefined;
		try {
			await expect
				.poll(async () => {
					try {
						await database.transaction((tx) =>
							tx
								.select({ id: driveSkills.driveId })
								.from(driveSkills)
								.where(eq(driveSkills.driveId, driveId))
								.for("update", { noWait: true }),
						);
						return false;
					} catch (error) {
						return (
							(error as { cause?: { code?: string } }).cause?.code === "55P03"
						);
					}
				})
				.toBe(true);
			editing = editSkills(1);
		} finally {
			unlockStaff();
			await staffLock;
		}
		const [{ id }, firstEdit] = await Promise.all([bookingFirst, editing]);
		expect(firstEdit).toMatchObject({ revision: 2, reviewedAt: null });
		await expect(
			getAssignedAssessment(database, config, staff.panelist, id),
		).resolves.toMatchObject({
			criteria: {
				skillRevision: 1,
				skills: [{ name: "Technical reasoning" }, { name: "Communication" }],
			},
		});
		const reviewed = await changeSkills(database, driveId, "l1", {
			type: "review",
			reviewerId: staff.hr,
			input: { revision: 2 },
		});
		const request = {
			...booking(second, { date: "2033-04-01", time: "11:00" }),
			skillRevision: reviewed.revision,
		};
		const { promise: candidacyLocked, resolve: signalCandidacyLock } =
			Promise.withResolvers<void>();
		const { promise: releaseCandidacy, resolve: unlockCandidacy } =
			Promise.withResolvers<void>();
		const candidacyLock = database.transaction(async (tx) => {
			await lockCandidacy(tx, driveId, second.id);
			signalCandidacyLock();
			await releaseCandidacy;
		});
		await candidacyLocked;
		const bookingSecond = expect(
			bookInterview(database, config, staff.hr, request),
		).rejects.toMatchObject(
			interrupted("skills_need_review", {
				criteria: expect.objectContaining({ revision: 4, reviewedAt: null }),
			}),
		);
		try {
			await editSkills(reviewed.revision);
		} finally {
			unlockCandidacy();
			await candidacyLock;
		}
		await bookingSecond;
	});

	test("accepts every draft field at its limit with escaped supplementary Unicode", async () => {
		const driveId = randomUUID();
		const skills = Array.from({ length: 50 }, (_, index) => ({
			id: randomUUID(),
			name: `Skill ${index + 1}`,
		}));
		await database.transaction(async (tx) => {
			await tx.insert(drive).values({
				id: driveId,
				clientKey: driveId,
				createdBy: staff.hr,
				name: "Maximum Assessment Drive",
			});
			await tx.insert(driveSkills).values({
				driveId,
				round: "l1",
				revision: 1,
				reviewedAt: now,
				reviewedBy: staff.hr,
				skills,
			});
		});
		const item = await candidacy(driveId);
		const { id } = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, { date: "2033-05-01" }),
		);
		await database
			.update(interviewRound)
			.set({ state: "active" })
			.where(eq(interviewRound.id, id));
		const app = new Hono<{ Variables: { staff: StaffIdentity } }>();
		app.use("*", async (context, next) => {
			context.set("staff", {
				id: staff.panelist,
				name: "Panelist",
				email: `${staff.panelist}@studio.test`,
				role: "panelist",
			});
			await next();
		});
		app.route("/", interviewStaffRoutes(database, config));
		const content: AssessmentDraft = {
			decision: "pass",
			rationale: "🧭".repeat(2_000),
			notes: "🧭".repeat(16_000),
			questions: skills.map(() => ({
				id: randomUUID(),
				text: "🧭".repeat(500),
			})),
			ratings: skills.map(({ id }) => ({
				skillId: id,
				rating: "meets_expectations",
				feedback: "🧭".repeat(500),
			})),
		};
		const body = JSON.stringify({
			commandId: randomUUID(),
			draftRevision: 0,
			content,
		}).replaceAll("🧭", "\\ud83e\\udded");
		expect(Buffer.byteLength(body)).toBeGreaterThan(512 * 1024);
		const saved = await app.request(`/my-interviews/${id}/assessment/draft`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body,
		});
		expect(saved.status).toBe(200);
		const view = await getAssignedAssessment(
			database,
			config,
			staff.panelist,
			id,
		);
		expect(view.draft).toMatchObject({ revision: 1, content });
	});

	test.each(["selected", "not_selected", "incomplete"] as const)(
		"books L2 after an L1 pass and handles %s",
		async (decision) => {
			const dates = {
				selected: "2033-06-01",
				not_selected: "2033-06-02",
				incomplete: "2033-06-03",
			};
			const date = dates[decision];
			const driveId = randomUUID();
			await database.transaction(async (tx) => {
				await tx.insert(drive).values({
					id: driveId,
					clientKey: driveId,
					createdBy: staff.hr,
					name: "Two-round Drive",
				});
				await fixtureReviewedSkills(tx, driveId, staff.hr);
			});
			const item = await candidacy(driveId);
			const sameEmail = await candidacy(
				second,
				item.email,
				"Independent Candidate",
			);
			const book = (input: BookInterview) =>
				bookInterview(database, config, staff.hr, input);
			const read = (id: string, assignee: string = staff.other) =>
				getAssignedAssessment(database, config, assignee, id);
			const send = (
				id: string,
				assignee: string,
				input: Parameters<typeof changeAssessment>[4],
			) => changeAssessment(database, config, assignee, id, input);
			const list = (filters: object) =>
				listInterviews(
					database,
					interviewListQuerySchema.parse({ search: item.email, ...filters }),
					now,
					domains,
				);
			const l2Request: BookInterview = {
				...booking(item, { date, time: "11:00" }, staff.other),
				level: "l2",
				workflowRevision: 2,
			};
			await expect(book(l2Request)).rejects.toMatchObject(
				interrupted("round_not_eligible"),
			);
			const l1 = await book(booking(item, { date }));
			const l1Link = await invite(l1.id, item.email);
			const prepareFeedback = (id: string) =>
				database
					.update(interviewRound)
					.set({ state: "awaiting_feedback", revision: 1, closedAt: now })
					.where(eq(interviewRound.id, id));
			await prepareFeedback(l1.id);
			const l1View = await read(l1.id, staff.panelist);
			const l1Draft = completeDraft(
				l1View.criteria?.skills.map(({ id }) => id) ?? [],
				"pass",
			);
			const save = {
				action: "draft",
				commandId: randomUUID(),
				draftRevision: 0,
				content: l1Draft,
			} as const;
			await expect(
				send(l1.id, staff.panelist, {
					...save,
					content: { ...l1Draft, decision: "selected" },
				}),
			).rejects.toMatchObject(
				interrupted("invalid_input", { field: "decision" }),
			);
			await send(l1.id, staff.panelist, save);
			const l1Version = await send(l1.id, staff.panelist, {
				action: "submit",
				commandId: randomUUID(),
				attemptRevision: 1,
				draftRevision: 1,
			});
			await expect(list({ level: "l2" })).resolves.toMatchObject({
				total: 1,
				items: [
					{
						id: item.id,
						level: "l2",
						qualifyingL1RoundId: l1.id,
						criteria: { round: "l2", skills: [], reviewedAt: null },
					},
				],
			});
			await expect(list({ level: "l1" })).resolves.toMatchObject({
				total: 1,
				items: [{ id: sameEmail.id, level: "l1" }],
			});
			await expect(book(l2Request)).rejects.toMatchObject(
				interrupted("skills_need_review"),
			);
			await database.transaction((tx) =>
				fixtureReviewedSkills(tx, driveId, staff.hr, "l2"),
			);
			await expect(
				book({ ...l2Request, workflowRevision: 1 }),
			).rejects.toMatchObject(interrupted("workflow_changed"));
			const results = await Promise.allSettled([
				book(l2Request),
				book({ ...l2Request, commandId: randomUUID() }),
			]);
			const l2 = results.find((result) => result.status === "fulfilled")?.value;
			if (!l2) throw new Error("No L2 booking committed");
			expect(
				results.filter((result) => result.status === "rejected"),
			).toMatchObject([{ reason: interrupted("round_not_eligible") }]);
			expect(l2.id).not.toBe(l1.id);
			expect((await invite(l2.id, item.email)).id).not.toBe(l1Link.id);
			await expect(read(l2.id, staff.panelist)).rejects.toMatchObject(
				interrupted("not_found"),
			);
			const scheduled = await read(l2.id);
			expect(scheduled).toMatchObject({
				canEdit: false,
				criteria: {
					skills: [{ name: "System design" }, { name: "Decision-making" }],
				},
				l1Handoff: { submitted: { id: l1Version.id, decision: "pass" } },
			});
			expect(scheduled.l1Handoff).not.toHaveProperty("draft");
			expect(scheduled.l1Handoff?.submitted).not.toHaveProperty("notes");
			expect(scheduled.l1Handoff?.submitted).not.toHaveProperty("questions");
			await prepareFeedback(l2.id);
			const content = completeDraft(
				scheduled.criteria?.skills.map(({ id }) => id) ?? [],
				decision,
			);
			const draft = {
				action: "draft",
				commandId: randomUUID(),
				draftRevision: 0,
				content,
			} as const;
			await expect(
				send(l2.id, staff.other, {
					...draft,
					content: { ...content, decision: "pass" },
				}),
			).rejects.toMatchObject(
				interrupted("invalid_input", { field: "decision" }),
			);
			await send(l2.id, staff.other, draft);
			const updateL1 = async (previousVersionId: string) => {
				const result = await correctAssessment(
					database,
					config,
					staff.panelist,
					l1.id,
					correction(
						previousVersionId,
						assessmentScorecardSchema.parse(l1Draft),
						"pass",
					),
				);
				return result.id;
			};
			const latestL1Id =
				decision === "selected" ? await updateL1(l1Version.id) : l1Version.id;
			const submit = {
				action: "submit",
				commandId: randomUUID(),
				attemptRevision: 1,
				draftRevision: 1,
			} as const;
			await expect(send(l2.id, staff.other, submit)).rejects.toMatchObject(
				interrupted("l1_handoff_changed", {
					assessment: expect.objectContaining({
						l1Handoff: expect.objectContaining({
							submitted: expect.objectContaining({ id: latestL1Id }),
						}),
					}),
				}),
			);
			if (latestL1Id !== l1Version.id)
				await expect(
					send(l2.id, staff.other, {
						...submit,
						reviewedL1VersionId: l1Version.id,
					}),
				).rejects.toMatchObject(interrupted("l1_handoff_changed"));
			const submitted = await send(l2.id, staff.other, {
				...submit,
				reviewedL1VersionId: latestL1Id,
			});
			if (decision === "selected") await updateL1(latestL1Id);
			await expect(read(l2.id)).resolves.toMatchObject({
				submitted: {
					id: submitted.id,
					decision,
					reviewedL1VersionId: latestL1Id,
				},
				l1Handoff: { submitted: { id: latestL1Id } },
			});
			await expect(
				getHrAssessment(database, config, staff.hr, l2.id),
			).resolves.toMatchObject({
				submitted: { decision, reviewedL1VersionId: latestL1Id },
			});
			if (decision !== "incomplete") {
				await expect(list({ level: "l2" })).resolves.toMatchObject({
					total: 0,
				});
				await expect(
					book({ ...l2Request, commandId: randomUUID(), workflowRevision: 4 }),
				).rejects.toMatchObject(interrupted("round_not_eligible"));
				return;
			}
			await expect(list({ level: "l2" })).resolves.toMatchObject({
				total: 1,
				items: [
					{ id: item.id, level: "l2", lastAttempt: 1, workflowRevision: 4 },
				],
			});
			const rebook = {
				...l2Request,
				slot: { ...l2Request.slot, time: "12:00" },
				commandId: randomUUID(),
				workflowRevision: 4,
			};
			const fresh = await book(rebook);
			await expect(
				getHrRound(database, fresh.id, now, domains),
			).resolves.toMatchObject({ attempt: 2, level: "l2" });
			await expect(
				getHrRound(database, l2.id, now, domains),
			).resolves.toMatchObject({ superseded: true });
			await changeRound(database, config, staff.hr, "hr", fresh.id, {
				action: "reassign",
				commandId: randomUUID(),
				panelistId: staff.panelist,
				revision: 0,
			});
			await expect(read(fresh.id)).rejects.toMatchObject(
				interrupted("not_found"),
			);
			await expect(read(fresh.id, staff.panelist)).resolves.toMatchObject({
				l1Handoff: { submitted: { id: latestL1Id } },
			});
			await changeRound(database, config, staff.hr, "hr", fresh.id, {
				action: "withdraw",
				commandId: randomUUID(),
				revision: 1,
				reason: "Candidate withdrew",
			});
			await expect(read(fresh.id, staff.panelist)).resolves.toMatchObject({
				l1Handoff: null,
			});
			await expect(read(l2.id)).resolves.toMatchObject({
				l1Handoff: { submitted: { id: latestL1Id } },
			});
			const [progress] = await database
				.select()
				.from(interviewProgress)
				.where(eq(interviewProgress.candidateId, item.id));
			expect(progress).toMatchObject({
				currentL2RoundId: null,
				l1VersionId: latestL1Id,
				revision: 6,
			});
			await expect(list({ level: "l2" })).resolves.toMatchObject({ total: 0 });
		},
	);
	test("rechecks an HR booker's role after waiting and before replaying a receipt", async () => {
		const [booked, waiting] = await Promise.all([candidacy(), candidacy()]);
		const actor = randomUUID();
		await database.insert(user).values({
			id: actor,
			name: "Promoted booker",
			email: `${actor}@studio.test`,
			phone: "+1 202 555 0100",
			emailVerified: true,
		});
		await database.insert(staffGrant).values({ userId: actor, role: "hr" });
		const bookedRequest = booking(booked, { date: "2034-01-01" });
		await bookInterview(database, config, actor, bookedRequest);

		const locked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const hold = database.transaction(async (tx) => {
			await lockCandidacy(tx, waiting.driveId, waiting.id);
			locked.resolve();
			await release.promise;
		});
		await locked.promise;
		const pending = expect(
			bookInterview(
				database,
				config,
				actor,
				booking(waiting, { date: "2034-01-02" }),
			),
		).rejects.toMatchObject(interrupted("forbidden"));
		try {
			await grantStaffRole(
				database,
				domains,
				staff.director,
				actor,
				"director",
			);
		} finally {
			release.resolve();
			await hold;
		}
		await pending;
		await expect(
			bookInterview(database, config, actor, bookedRequest),
		).rejects.toMatchObject(interrupted("forbidden"));
	});

	async function prepareReviewCase(date: string, driveId = first) {
		const item = await candidacy(driveId);
		const l1 = await bookInterview(
			database,
			config,
			staff.hr,
			booking(item, { date }),
		);
		const { content, version } = await submitRoundForReview(
			l1.id,
			staff.panelist,
			"pass",
		);
		const l2Request: BookInterview = {
			...booking(item, { date, time: "11:00" }, staff.other),
			level: "l2",
			workflowRevision: 2,
		};
		return {
			item,
			l1,
			l1Version: version,
			l1Scorecard: assessmentScorecardSchema.parse(content),
			l2Request,
			bookL2: () => bookInterview(database, config, staff.hr, l2Request),
			queue: () =>
				listInterviews(
					database,
					interviewListQuerySchema.parse({ search: item.email }),
					now,
					domains,
				),
		};
	}

	async function submitRoundForReview(
		id: string,
		panelist: string,
		decision: AssessmentScorecard["decision"],
		reviewedL1VersionId?: string,
	) {
		await database
			.update(interviewRound)
			.set({ state: "awaiting_feedback", revision: 1, closedAt: now })
			.where(eq(interviewRound.id, id));
		const { criteria } = await getAssignedAssessment(
			database,
			config,
			panelist,
			id,
		);
		const content = completeDraft(
			criteria?.skills.map(({ id }) => id) ?? [],
			decision,
		);
		await changeAssessment(database, config, panelist, id, {
			action: "draft",
			commandId: randomUUID(),
			draftRevision: 0,
			content,
		});
		const version = await changeAssessment(database, config, panelist, id, {
			action: "submit",
			commandId: randomUUID(),
			attemptRevision: 1,
			draftRevision: 1,
			reviewedL1VersionId,
		});
		return { content, version };
	}

	function correction(
		expectedVersionId: string,
		scorecard: AssessmentScorecard,
		decision: AssessmentScorecard["decision"],
		rationale = "Reevaluated the evidence.",
	) {
		return {
			commandId: randomUUID(),
			expectedVersionId,
			reason: "Reviewed the scoring evidence again.",
			scorecard: { ...scorecard, decision, rationale },
		};
	}

	test("reports one current outcome and preserves the exact submitted evidence across an HR review", async () => {
		const driveId = randomUUID();
		const otherDriveId = randomUUID();
		await database.transaction(async (tx) => {
			await tx.insert(drive).values([
				{
					id: driveId,
					clientKey: driveId,
					createdBy: staff.hr,
					name: "Director reporting",
				},
				{
					id: otherDriveId,
					clientKey: otherDriveId,
					createdBy: staff.hr,
					name: "Independent report",
				},
			]);
			for (const round of ["l1", "l2"] as const)
				await fixtureReviewedSkills(tx, driveId, staff.hr, round);
		});
		const { item, l1, l1Version, l1Scorecard, bookL2, l2Request } =
			await prepareReviewCase("2035-02-17", driveId);
		const independent = await candidacy(otherDriveId, item.email, item.name);
		const query = { driveId, page: 1 };
		const scope = { driveId, candidateId: item.id };
		const evidence = () => listDirectorScorecards(database, scope, 1);
		const cancelled = await bookL2();
		await changeRound(database, config, staff.hr, "hr", cancelled.id, {
			action: "cancel",
			revision: 0,
			commandId: randomUUID(),
		});
		const l2 = await bookInterview(database, config, staff.hr, {
			...l2Request,
			commandId: randomUUID(),
			workflowRevision: 4,
		});
		await changeRound(database, config, staff.hr, "hr", l2.id, {
			action: "reschedule",
			commandId: randomUUID(),
			revision: 0,
			slot: { ...l2Request.slot, time: "11:30" },
		});
		const rescheduledOn = "2035-02-18";
		await database
			.update(interviewEvent)
			.set({ createdAt: new Date(`${rescheduledOn}T00:00:00Z`) })
			.where(
				and(
					eq(interviewEvent.roundId, l2.id),
					eq(interviewEvent.action, "reschedule"),
				),
			);
		await expect(
			readDirectorReport(database, {
				...query,
				from: rescheduledOn,
				to: rescheduledOn,
			}),
		).resolves.toMatchObject({
			items: [{ id: item.id, activityDate: rescheduledOn }],
		});
		const cancelledOn = now.toISOString().slice(0, 10);
		await expect(
			readDirectorReport(database, {
				...query,
				from: cancelledOn,
				to: cancelledOn,
			}),
		).resolves.toMatchObject({ items: [], cancelled: 1 });
		await expect(readDirectorReport(database, query)).resolves.toMatchObject({
			totals: { in_progress: 1, selected: 0 },
			cancelled: 1,
			items: [{ id: item.id, status: "in_progress", round: "l2" }],
		});
		await expect(evidence()).resolves.toMatchObject({
			items: [{ roundId: l1.id, versionId: l1Version.id }],
		});
		await expect(
			getAssessmentVersion(
				database,
				config,
				staff.director,
				"director",
				l2.id,
				l1Version.id,
			),
		).rejects.toMatchObject(interrupted("not_found"));
		const { version: selected } = await submitRoundForReview(
			l2.id,
			staff.other,
			"selected",
			l1Version.id,
		);
		const finalized = await readDirectorReport(database, query);
		expect(finalized.totals).toMatchObject({ in_progress: 0, selected: 1 });
		expect(finalized.items).toMatchObject([
			{ id: item.id, status: "selected", round: "l2", hasScorecards: true },
		]);
		expect(finalized.cancelled).toBe(1);
		await expect(
			readDirectorReport(database, { driveId: otherDriveId, page: 1 }),
		).resolves.toMatchObject({
			totals: { in_progress: 1, selected: 0 },
			cancelled: 0,
			items: [
				{
					id: independent.id,
					status: "in_progress",
					round: "l1",
					hasScorecards: false,
				},
			],
		});
		await expect(
			listInterviewWorkspace(
				database,
				{
					tab: "queue",
					page: 1,
					driveId: otherDriveId,
					search: "",
				},
				now,
				domains,
			),
		).resolves.toMatchObject({
			items: [
				{
					id: independent.id,
					action: "review_skills",
					eligible: { id: independent.id },
				},
			],
		});
		const dashboard = await readHrInterviewDashboard(database, now, domains);
		for (const tab of ["queue", "scheduled", "awaiting", "history"] as const) {
			const workspace = await listInterviewWorkspace(
				database,
				{ tab, page: 1, search: "" },
				now,
				domains,
			);
			expect(dashboard[tab]).toEqual({
				total: workspace.total,
				items: workspace.items.slice(0, 3),
			});
		}
		const date = finalized.items[0].activityDate;
		await expect(
			readDirectorReport(database, {
				...query,
				round: "l2",
				from: date,
				to: date,
				outcome: "selected",
			}),
		).resolves.toMatchObject({ items: [{ id: item.id }] });
		await expect(
			readDirectorReport(database, { ...query, round: "l1" }),
		).resolves.toMatchObject({ items: [] });

		await correctAssessment(
			database,
			config,
			staff.panelist,
			l1.id,
			correction(l1Version.id, l1Scorecard, "do_not_proceed"),
		);
		await expect(readDirectorReport(database, query)).resolves.toMatchObject({
			totals: { pending_review: 1, selected: 0, do_not_proceed: 0 },
			items: [{ id: item.id, status: "pending_review", hasScorecards: true }],
		});
		const cards = await evidence();
		expect(cards.items).toMatchObject([
			{ roundId: l1.id, decision: "do_not_proceed" },
			{
				roundId: l2.id,
				versionId: selected.id,
				attempt: 2,
				decision: "selected",
			},
		]);
		const detail = await getAssessmentVersion(
			database,
			config,
			staff.director,
			"director",
			l2.id,
			selected.id,
		);
		expect(detail).toMatchObject({
			submitted: { reviewedL1VersionId: l1Version.id },
			l1Handoff: { submitted: { id: l1Version.id, decision: "pass" } },
		});
		expect(JSON.stringify(detail)).not.toMatch(
			/Private observations|How did you validate the result\?|teamsUrl|invitedEmail/,
		);
		await expect(
			listDirectorScorecards(database, { ...scope, driveId: second }, 1),
		).rejects.toMatchObject(interrupted("not_found"));
		const review = await latestReview(item.id);
		await changeFeedbackReview(
			database,
			config,
			staff.hr,
			review.id,
			resolutionCommand(review),
		);
		await expect(readDirectorReport(database, query)).resolves.toMatchObject({
			totals: { pending_review: 0, selected: 0, do_not_proceed: 1 },
			items: [{ id: item.id, status: "do_not_proceed", round: "l1" }],
		});
		await expect(
			readDirectorReport(database, {
				...query,
				round: "l2",
				outcome: "do_not_proceed",
			}),
		).resolves.toMatchObject({ items: [], cancelled: 1 });
	});

	async function latestReview(candidateId: string) {
		const inbox = await listFeedbackReviews(database, config, staff.hr, 1);
		const entry = inbox.items.find(
			(review) =>
				review.candidate.id === candidateId && review.kind === "pass_reversed",
		);
		if (!entry) throw new Error("Expected an open review");
		return getFeedbackReview(database, config, staff.hr, entry.id);
	}

	function resolutionCommand(
		detail: Awaited<ReturnType<typeof getFeedbackReview>>,
	) {
		if (!detail.availableResolution)
			throw new Error("Expected a resolution action");
		const commandId = randomUUID();
		return {
			action: "resolve" as const,
			commandId,
			resolution: {
				commandId,
				expectedL1VersionId: detail.latestL1.id,
				expectedRevision: detail.revision,
				action: detail.availableResolution.action,
				reason: "Reviewed the scorecards and confirmed the outcome.",
			},
		};
	}

	test.each(["scheduled", "active", "awaiting_feedback"] as const)(
		"cancels %s L2 and revokes admitted candidate access when L1 is reversed",
		async (state) => {
			const date = {
				scheduled: "2035-02-01",
				active: "2035-02-02",
				awaiting_feedback: "2035-02-03",
			}[state];
			const scenario = await prepareReviewCase(date);
			const { item, l1, l1Version, l1Scorecard, l2Request } = scenario;
			const l2 = await scenario.bookL2();
			const entry = await invite(l2.id, item.email);
			let clock = new Date(`${date}T05:31:00Z`);
			const today = { ...config, clock: () => clock };
			const mailbox = captureMail();
			const sendCode = () =>
				requestCode(database, today, mailbox.mail, entry.id, entry.input);
			const firstCode = await sendCode();
			const join = await verifyCode(database, today, entry.id, {
				...entry.input,
				challengeId: firstCode.challengeId,
				code: mailbox.code(),
			});
			await candidateRound(database, today, l2.id, join.token, {
				action: "confirm",
				name: item.name,
				years: null,
			});
			if (state !== "scheduled") {
				await changeRound(database, today, staff.other, "panelist", l2.id, {
					action: "start",
					commandId: randomUUID(),
					revision: 0,
				});
				const { draft } = await getAssignedAssessment(
					database,
					today,
					staff.other,
					l2.id,
				);
				if (!draft) throw new Error("Expected L2 draft");
				await changeAssessment(database, today, staff.other, l2.id, {
					action: "draft",
					commandId: randomUUID(),
					draftRevision: 0,
					content: { ...draft.content, notes: "Preserved L2 private work" },
				});
			}
			clock = new Date(clock.getTime() + 61_000);
			const pendingCode = await sendCode();
			const exchange = {
				...entry.input,
				challengeId: pendingCode.challengeId,
				code: mailbox.code(),
			};
			const close = {
				action: "end",
				commandId: randomUUID(),
				revision: 1,
				binding:
					state === "awaiting_feedback"
						? (await readCandidateWorkspace(database, today, l2.id, join.token))
								.binding
						: undefined,
				expectedHeads: { code: null, board: null },
			} as const;
			const closedAt = clock.toISOString();
			if (state === "awaiting_feedback")
				await candidateRound(database, today, l2.id, join.token, close);
			clock = new Date(clock.getTime() + 1_000);
			const reverse = correction(l1Version.id, l1Scorecard, "do_not_proceed");
			const reversed = await correctAssessment(
				database,
				today,
				staff.panelist,
				l1.id,
				reverse,
			);
			await expect(
				correctAssessment(database, today, staff.panelist, l1.id, reverse),
			).resolves.toEqual(reversed);
			const review = await latestReview(item.id);
			expect(review).toMatchObject({
				l2: { id: l2.id },
				l2Version: null,
				previousL1: { id: l1Version.id },
				latestL1: { id: reversed.id },
				availableResolution: { action: "apply_l1", outcome: "do_not_proceed" },
			});
			await expect(
				getHrRound(database, l2.id, clock, domains),
			).resolves.toMatchObject({
				state: "cancelled",
				effectiveOutcome: null,
				pendingReviewId: review.id,
				closedAt:
					state === "awaiting_feedback" ? closedAt : clock.toISOString(),
				confirmedProfile: { name: item.name },
			});
			await expect(
				candidateRound(database, today, l2.id, join.token, {
					action: "presence",
				}),
			).rejects.toMatchObject(interrupted("unavailable"));
			await expect(
				verifyCode(database, today, entry.id, exchange),
			).rejects.toMatchObject(interrupted("invite_unavailable"));
			await expect(sendCode()).rejects.toMatchObject(
				interrupted("invite_unavailable"),
			);
			if (state === "awaiting_feedback")
				await expect(
					candidateRound(database, today, l2.id, join.token, close),
				).resolves.toEqual({ completed: true });
			const cancelled = await getAssignedAssessment(
				database,
				today,
				staff.other,
				l2.id,
			);
			expect(cancelled).toMatchObject({
				l1Handoff: null,
				canEdit: false,
				draft: {
					content: {
						notes: state === "scheduled" ? "" : "Preserved L2 private work",
					},
				},
			});
			await expect(
				bookInterview(database, config, staff.hr, {
					...l2Request,
					commandId: randomUUID(),
				}),
			).rejects.toMatchObject(interrupted("pending_feedback_review"));
			await expect(
				withdrawCandidacy(
					database,
					config,
					staff.hr,
					{ driveId: item.driveId, candidateId: item.id },
					{
						revision: 0,
						workflowRevision: 4,
						commandId: randomUUID(),
						reason: "Candidate withdrew",
					},
				),
			).rejects.toMatchObject(interrupted("pending_feedback_review"));
			await expect(
				changeAssessment(database, today, staff.other, l2.id, {
					action: "submit",
					commandId: randomUUID(),
					draftRevision: 1,
					attemptRevision: 2,
				}),
			).rejects.toMatchObject(interrupted("pending_feedback_review"));
			await expect(
				changeCandidate(database, item.driveId, item.id, {
					type: "save",
					input: { revision: 0, name: "Updated" },
				}),
			).rejects.toMatchObject(interrupted("pending_feedback_review"));
			await expect(scenario.queue()).resolves.toMatchObject({ total: 0 });

			const restored = await correctAssessment(
				database,
				today,
				staff.panelist,
				l1.id,
				correction(reversed.id, l1Scorecard, "pass"),
			);
			const latest = await latestReview(item.id);
			expect(latest).toMatchObject({
				id: review.id,
				revision: review.revision + 1,
				triggerL1: { id: reversed.id },
				latestL1: { id: restored.id },
				availableResolution: { action: "rebook_l2", outcome: "schedule_l2" },
			});
			await expect(
				changeFeedbackReview(
					database,
					today,
					staff.hr,
					review.id,
					resolutionCommand(review),
				),
			).rejects.toMatchObject(
				interrupted("feedback_review_changed", {
					review: expect.objectContaining({ revision: latest.revision }),
				}),
			);
			await changeFeedbackReview(
				database,
				today,
				staff.hr,
				review.id,
				resolutionCommand(latest),
			);
			const queue = await scenario.queue();
			if (queue.tab !== "queue") throw new Error("Expected queue");
			const [bookable] = queue.items;
			const retry = await bookInterview(database, config, staff.hr, {
				...l2Request,
				commandId: randomUUID(),
				workflowRevision: bookable.workflowRevision,
			});
			await expect(
				getHrRound(database, retry.id, clock, domains),
			).resolves.toMatchObject({ attempt: 2, level: "l2" });
			expect((await invite(retry.id, item.email)).id).not.toBe(entry.id);
		},
	);

	test.each([
		{ outcome: "selected", resolver: "hr", date: "2035-03-01" },
		{ outcome: "incomplete", resolver: "hr", date: "2035-03-02" },
		{ outcome: "do_not_proceed", resolver: "hr", date: "2035-03-03" },
		{ outcome: "schedule_l1", resolver: "hr", date: "2035-03-04" },
		{ outcome: "selected", resolver: "backupHr", date: "2035-03-05" },
	] as const)(
		"resolves a review after submitted L2 to $outcome with $resolver first",
		async ({ outcome, resolver, date }) => {
			const scenario = await prepareReviewCase(date);
			const { item, l1, l1Version, l1Scorecard, l2Request } = scenario;
			const l2 = await scenario.bookL2();
			const l2Decision = outcome === "incomplete" ? "incomplete" : "selected";
			const l2Result = await submitRoundForReview(
				l2.id,
				staff.other,
				l2Decision,
				l1Version.id,
			);
			const l2Scorecard = assessmentScorecardSchema.parse(l2Result.content);
			const l2Corrected = await correctAssessment(
				database,
				config,
				staff.other,
				l2.id,
				correction(l2Result.version.id, l2Scorecard, l2Decision),
			);
			const loss = outcome === "schedule_l1" ? "incomplete" : "do_not_proceed";
			const reversed = await correctAssessment(
				database,
				config,
				staff.panelist,
				l1.id,
				correction(l1Version.id, l1Scorecard, loss),
			);
			const review = await latestReview(item.id);
			expect(review.l2Version?.id).toBe(l2Corrected.id);
			await expect(
				getHrRound(database, l2.id, now, domains),
			).resolves.toMatchObject({
				state: "feedback_submitted",
				effectiveOutcome: null,
				pendingReviewId: review.id,
			});
			await expect(
				correctAssessment(
					database,
					config,
					staff.other,
					l2.id,
					correction(l2Corrected.id, l2Scorecard, l2Decision),
				),
			).rejects.toMatchObject(interrupted("pending_feedback_review"));
			await expect(
				getFeedbackReview(database, config, staff.other, review.id),
			).rejects.toMatchObject(interrupted("forbidden"));
			await expect(
				getAssessmentVersion(
					database,
					config,
					staff.other,
					"panelist",
					l2.id,
					l2Result.version.id,
				),
			).resolves.toMatchObject({
				l1Handoff: { submitted: { id: l1Version.id } },
			});
			await expect(
				getAssessmentVersion(
					database,
					config,
					staff.other,
					"panelist",
					l2.id,
					l1Version.id,
				),
			).rejects.toMatchObject(interrupted("not_found"));
			const reinstating = outcome === "selected" || outcome === "incomplete";
			if (reinstating)
				await correctAssessment(
					database,
					config,
					staff.panelist,
					l1.id,
					correction(reversed.id, l1Scorecard, "pass"),
				);
			const latest = await latestReview(item.id);
			const apply = resolutionCommand(latest);
			const actor = staff[resolver];
			const resolve = () =>
				changeFeedbackReview(database, config, actor, review.id, apply);
			if (outcome === "selected") {
				const other = resolver === "hr" ? staff.backupHr : staff.hr;
				const [winner, follower] = await runInCandidacyOrder(
					item,
					actor,
					resolve,
					() =>
						changeFeedbackReview(
							database,
							config,
							other,
							review.id,
							resolutionCommand(latest),
						),
				);
				expect(winner).toEqual({
					status: "fulfilled",
					value: { id: review.id },
				});
				expect(follower).toMatchObject({
					status: "rejected",
					reason: interrupted("feedback_review_changed"),
				});
			} else {
				await resolve();
			}
			await expect(resolve()).resolves.toEqual({ id: review.id });
			await expect(
				getFeedbackReview(database, config, staff.hr, review.id),
			).resolves.toMatchObject({
				resolution: {
					outcome: outcome === "incomplete" ? "schedule_l2" : outcome,
					resolvedBy: { id: actor },
					appliedL1VersionId: latest.latestL1.id,
					reinstatedL2VersionId: reinstating ? l2Corrected.id : null,
				},
			});
			await expect(
				getHrRound(database, l2.id, now, domains),
			).resolves.toMatchObject({
				effectiveOutcome:
					outcome === "selected" || outcome === "do_not_proceed"
						? outcome
						: null,
				pendingReviewId: null,
				superseded: !reinstating,
			});
			await expect(
				getAssessmentVersion(
					database,
					config,
					staff.hr,
					"hr",
					l2.id,
					l2Corrected.id,
				),
			).resolves.toMatchObject({
				submitted: { reviewedL1VersionId: l1Version.id },
				l1Handoff: { submitted: { id: l1Version.id } },
			});
			const versions = await listAssessmentVersions(
				database,
				config,
				staff.panelist,
				"panelist",
				l1.id,
				1,
			);
			expect(versions.items[0].id).toBe(latest.latestL1.id);
			expect(versions.items.at(-1)?.id).toBe(l1Version.id);
			const queue = await scenario.queue();
			if (queue.tab !== "queue") throw new Error("Expected queue");
			if (outcome === "schedule_l1" || outcome === "incomplete") {
				const [next] = queue.items;
				const level = outcome === "schedule_l1" ? "l1" : "l2";
				expect(next.level).toBe(level);
				const fresh = await bookInterview(database, config, staff.hr, {
					...l2Request,
					level,
					commandId: randomUUID(),
					workflowRevision: next.workflowRevision,
				});
				await expect(
					getHrRound(database, fresh.id, now, domains),
				).resolves.toMatchObject({ attempt: 2, level });
				const olderCorrection =
					level === "l1"
						? correctAssessment(
								database,
								config,
								staff.panelist,
								l1.id,
								correction(latest.latestL1.id, l1Scorecard, "pass"),
							)
						: correctAssessment(
								database,
								config,
								staff.other,
								l2.id,
								correction(l2Corrected.id, l2Scorecard, l2Decision),
							);
				await expect(olderCorrection).rejects.toMatchObject(
					interrupted("invalid_transition"),
				);
			} else expect(queue.total).toBe(0);
		},
	);

	test("records a passing update, resolves a reversed rebook, and keeps retired feedback read-only", async () => {
		const scenario = await prepareReviewCase("2035-04-01");
		const { item, l1, l1Version, l1Scorecard, l2Request } = scenario;
		const originalL2 = await scenario.bookL2();
		const originalResult = await submitRoundForReview(
			originalL2.id,
			staff.other,
			"incomplete",
			l1Version.id,
		);
		const replacement = await bookInterview(database, config, staff.hr, {
			...l2Request,
			commandId: randomUUID(),
			workflowRevision: 4,
		});
		const correct = (head: string, decision: AssessmentScorecard["decision"]) =>
			correctAssessment(
				database,
				config,
				staff.panelist,
				l1.id,
				correction(head, l1Scorecard, decision),
			);
		const updated = await correct(l1Version.id, "pass");
		const inbox = await listFeedbackReviews(database, config, staff.hr, 1);
		const notification = inbox.items.find(
			(entry) =>
				entry.kind === "handoff_updated" && entry.candidate.id === item.id,
		);
		if (!notification)
			throw new Error("Expected an informational notification");
		await expect(
			getFeedbackReview(database, config, staff.hr, notification.id),
		).resolves.toMatchObject({
			l2: { id: replacement.id },
			latestL1: { id: updated.id },
			availableResolution: null,
		});
		await expect(
			getAssignedAssessment(database, config, staff.other, replacement.id),
		).resolves.toMatchObject({ l1Handoff: { submitted: { id: updated.id } } });
		await expect(
			getAssignedAssessment(database, config, staff.other, originalL2.id),
		).resolves.toMatchObject({
			l1Handoff: { submitted: { id: l1Version.id } },
			submitted: { id: originalResult.version.id },
		});
		const acknowledge = {
			action: "acknowledge",
			commandId: randomUUID(),
		} as const;
		await changeFeedbackReview(
			database,
			config,
			staff.hr,
			notification.id,
			acknowledge,
		);
		const secondHr = randomUUID();
		await database.insert(user).values({
			id: secondHr,
			name: "Second HR",
			email: `${secondHr}@studio.test`,
			phone: "+1 202 555 0100",
			emailVerified: true,
		});
		await database.insert(staffGrant).values({ userId: secondHr, role: "hr" });
		await changeFeedbackReview(database, config, secondHr, notification.id, {
			...acknowledge,
			commandId: randomUUID(),
		});
		await expect(
			getFeedbackReview(database, config, staff.hr, notification.id),
		).resolves.toMatchObject({ acknowledgment: { readBy: { id: staff.hr } } });
		expect(
			(await listFeedbackReviews(database, config, secondHr, 1)).items.some(
				({ id }) => id === notification.id,
			),
		).toBe(false);
		await expect(correct(l1Version.id, "do_not_proceed")).rejects.toMatchObject(
			interrupted("feedback_version_changed"),
		);
		const reversed = await correct(updated.id, "do_not_proceed");
		const present = await latestReview(item.id);
		expect(present).toMatchObject({
			l2: { id: replacement.id },
			l2Version: null,
			triggerL1: { id: reversed.id },
		});
		await changeFeedbackReview(
			database,
			config,
			staff.hr,
			present.id,
			resolutionCommand(present),
		);
		const reopened = await correct(reversed.id, "pass");
		const lostAgain = await correct(reopened.id, "do_not_proceed");
		expect(
			(await listFeedbackReviews(database, config, staff.hr, 1)).items.some(
				(review) => review.candidate.id === item.id,
			),
		).toBe(false);
		const newPass = await correct(lostAgain.id, "pass");
		const queue = await scenario.queue();
		if (queue.tab !== "queue") throw new Error("Expected queue");
		const fresh = await bookInterview(database, config, staff.hr, {
			...l2Request,
			commandId: randomUUID(),
			workflowRevision: queue.items[0].workflowRevision,
		});
		const nextLoss = await correct(newPass.id, "do_not_proceed");
		const nextReview = await latestReview(item.id);
		expect(nextReview.id).not.toBe(present.id);
		expect(nextReview.l2.id).toBe(fresh.id);
		const restored = await correct(nextLoss.id, "pass");
		await changeFeedbackReview(
			database,
			config,
			staff.hr,
			nextReview.id,
			resolutionCommand(await latestReview(item.id)),
		);
		const finalQueue = await scenario.queue();
		if (finalQueue.tab !== "queue") throw new Error("Expected queue");
		await withdrawCandidacy(
			database,
			config,
			staff.hr,
			{ driveId: item.driveId, candidateId: item.id },
			{
				commandId: randomUUID(),
				reason: "Candidate withdrew.",
				revision: 0,
				workflowRevision: finalQueue.items[0].workflowRevision,
			},
		);
		await expect(
			getAssignedAssessment(database, config, staff.panelist, l1.id),
		).resolves.toMatchObject({ canCorrect: false });
		await expect(correct(restored.id, "pass")).rejects.toMatchObject(
			interrupted("invalid_transition"),
		);
		await expect(
			getHrRound(database, originalL2.id, now, domains),
		).resolves.toMatchObject({
			decision: "incomplete",
			effectiveOutcome: "withdrawn",
		});
	});

	async function runInCandidacyOrder<A, B>(
		item: { driveId: string; id: string },
		lockedStaff: string,
		first: () => Promise<A>,
		second: () => Promise<B>,
	) {
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const hold = database.transaction(async (tx) => {
			await tx
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, lockedStaff))
				.for("update");
			held.resolve();
			await release.promise;
		});
		await held.promise;
		const firstWrite = first();
		void firstWrite.catch(() => {});
		let secondWrite: Promise<B> | undefined;
		try {
			await expect
				.poll(async () => {
					try {
						await database.transaction((tx) =>
							tx.execute(
								sql`select id from drive_candidate where id = ${item.id} for no key update nowait`,
							),
						);
						return false;
					} catch (error) {
						return (
							(error as { cause?: { code?: string } }).cause?.code === "55P03"
						);
					}
				})
				.toBe(true);
			secondWrite = second();
			void secondWrite.catch(() => {});
			await waitForLockedQuery(
				'%from "drive_candidate" where%for no key update',
			);
		} finally {
			release.resolve();
			await hold;
		}
		return Promise.allSettled([firstWrite, secondWrite] as const);
	}

	test.each([true, false])(
		"serializes L2 booking and L1 reversal (booking first: %s)",
		async (bookingFirst) => {
			const scenario = await prepareReviewCase(
				bookingFirst ? "2035-05-01" : "2035-05-02",
			);
			const reverse = () =>
				correctAssessment(
					database,
					config,
					staff.panelist,
					scenario.l1.id,
					correction(
						scenario.l1Version.id,
						scenario.l1Scorecard,
						"do_not_proceed",
					),
				);
			const [winner, follower] = bookingFirst
				? await runInCandidacyOrder(
						scenario.item,
						staff.other,
						scenario.bookL2,
						reverse,
					)
				: await runInCandidacyOrder(
						scenario.item,
						staff.panelist,
						reverse,
						scenario.bookL2,
					);
			if (winner.status !== "fulfilled") throw winner.reason;
			if (bookingFirst) {
				expect(follower.status).toBe("fulfilled");
				await expect(
					getHrRound(database, winner.value.id, now, domains),
				).resolves.toMatchObject({
					state: "cancelled",
					pendingReviewId: expect.any(String),
				});
			} else {
				expect(follower).toMatchObject({
					status: "rejected",
					reason: interrupted("round_not_eligible"),
				});
				expect(
					(await listFeedbackReviews(database, config, staff.hr, 1)).items.some(
						(review) => review.candidate.id === scenario.item.id,
					),
				).toBe(false);
			}
		},
	);

	test.each([true, false])(
		"serializes L2 submission and L1 reversal (submission first: %s)",
		async (submissionFirst) => {
			const scenario = await prepareReviewCase(
				submissionFirst ? "2035-06-01" : "2035-06-02",
			);
			const l2 = await scenario.bookL2();
			await database
				.update(interviewRound)
				.set({ state: "awaiting_feedback", revision: 1, closedAt: now })
				.where(eq(interviewRound.id, l2.id));
			const { criteria } = await getAssignedAssessment(
				database,
				config,
				staff.other,
				l2.id,
			);
			const content = completeDraft(
				criteria?.skills.map(({ id }) => id) ?? [],
				"selected",
			);
			await changeAssessment(database, config, staff.other, l2.id, {
				action: "draft",
				commandId: randomUUID(),
				draftRevision: 0,
				content,
			});
			const submit = () =>
				changeAssessment(database, config, staff.other, l2.id, {
					action: "submit",
					commandId: randomUUID(),
					attemptRevision: 1,
					draftRevision: 1,
					reviewedL1VersionId: scenario.l1Version.id,
				});
			const reverse = () =>
				correctAssessment(
					database,
					config,
					staff.panelist,
					scenario.l1.id,
					correction(
						scenario.l1Version.id,
						scenario.l1Scorecard,
						"do_not_proceed",
					),
				);
			const [winner, follower] = submissionFirst
				? await runInCandidacyOrder(scenario.item, staff.other, submit, reverse)
				: await runInCandidacyOrder(
						scenario.item,
						staff.panelist,
						reverse,
						submit,
					);
			if (winner.status !== "fulfilled") throw winner.reason;
			const review = await latestReview(scenario.item.id);
			if (submissionFirst) {
				expect(follower.status).toBe("fulfilled");
				expect(review.l2Version?.id).toBe(winner.value.id);
			} else {
				expect(follower).toMatchObject({
					status: "rejected",
					reason: interrupted("pending_feedback_review"),
				});
				expect(review.l2Version).toBeNull();
			}
			await expect(
				getHrRound(database, l2.id, now, domains),
			).resolves.toMatchObject({
				state: submissionFirst ? "feedback_submitted" : "cancelled",
				effectiveOutcome: null,
				pendingReviewId: review.id,
			});
		},
	);

	test.each([true, false])(
		"serializes L2 admission and cancellation (admission first: %s)",
		async (admissionFirst) => {
			const date = admissionFirst ? "2035-07-01" : "2035-07-02";
			const scenario = await prepareReviewCase(date);
			const l2 = await scenario.bookL2();
			const today = { ...config, clock: () => new Date(`${date}T05:31:00Z`) };
			const entry = await invite(l2.id, scenario.item.email);
			const mailbox = captureMail();
			const challenge = await requestCode(
				database,
				today,
				mailbox.mail,
				entry.id,
				entry.input,
			);
			const admit = () =>
				verifyCode(database, today, entry.id, {
					...entry.input,
					challengeId: challenge.challengeId,
					code: mailbox.code(),
				});
			const reverse = () =>
				correctAssessment(
					database,
					today,
					staff.panelist,
					scenario.l1.id,
					correction(
						scenario.l1Version.id,
						scenario.l1Scorecard,
						"do_not_proceed",
					),
				);
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const hold = database.transaction(async (tx) => {
				await tx
					.select({ id: interviewRound.id })
					.from(interviewRound)
					.where(eq(interviewRound.id, l2.id))
					.for("update");
				held.resolve();
				await release.promise;
			});
			await held.promise;
			let admission: ReturnType<typeof admit> | undefined;
			let reversal: ReturnType<typeof reverse> | undefined;
			try {
				if (admissionFirst) {
					admission = admit();
					void admission.catch(() => {});
					await waitForLockedQuery(
						'%from "interview_round" where "interview_round"."id" =%for update',
					);
					reversal = reverse();
				} else {
					reversal = reverse();
					await waitForLockedQuery(
						'%from "interview_round" where "interview_round"."id" in%for update',
					);
					admission = admit();
				}
				void admission.catch(() => {});
				void reversal.catch(() => {});
			} finally {
				release.resolve();
				await hold;
			}
			const [join, changed] = await Promise.allSettled([admission, reversal]);
			expect(changed.status).toBe("fulfilled");
			if (admissionFirst) {
				if (join.status !== "fulfilled" || !join.value)
					throw new Error("Admission was expected to commit first");
				await expect(
					candidateRound(database, today, l2.id, join.value.token, {
						action: "presence",
					}),
				).rejects.toMatchObject(interrupted("unavailable"));
			} else
				expect(join).toMatchObject({
					status: "rejected",
					reason: interrupted("invite_unavailable"),
				});
		},
	);
});
