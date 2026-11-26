import {
	type BookInterview,
	candidateEmailSchema,
	candidateFieldsSchema,
	type InterviewCommand,
	type InterviewConflict,
} from "@studio/contracts";
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { drive } from "../drives/schema.ts";
import { InterviewProblem } from "./problem.ts";
import {
	getAssignedRound,
	getHrRound,
	occupying,
	unresolved,
	years,
} from "./queries.ts";
import {
	interviewInvitation,
	interviewRound,
	interviewSession,
	interviewWithdrawal,
} from "./schema.ts";
import {
	type Actor,
	commandReceipt,
	createInvitation,
	currentTime,
	type Database,
	hash,
	type InterviewConfig,
	invitationSecret,
	lock,
	lockCandidacy,
	lockResources,
	lockStaff,
	type RoundRow,
	readPreferences,
	recordEvent,
	revokeAdmission,
	sameDigest,
	type Transaction,
} from "./store.ts";
import { presenceFresh, requireEntryWindow, resolveSlot } from "./time.ts";

type StaffRole = "hr" | "panelist";

async function checkConflicts(
	tx: Transaction,
	resource: {
		invitedEmail: string;
		panelistId: string;
		start: Date;
		end: Date;
	},
	now: Date,
	acknowledge?: string,
	excludeId?: string,
) {
	const start = sql`least(${interviewRound.start}, ${interviewRound.startedAt})`;
	const overtime = and(
		eq(interviewRound.state, "active"),
		sql`${interviewRound.end} <= ${now.toISOString()}::timestamptz`,
	);
	const rows = await tx
		.select({
			round: interviewRound,
			drive: { id: drive.id, title: drive.name },
		})
		.from(interviewRound)
		.innerJoin(drive, eq(drive.id, interviewRound.driveId))
		.where(
			and(
				inArray(interviewRound.state, occupying),
				or(
					eq(interviewRound.invitedEmail, resource.invitedEmail),
					eq(interviewRound.panelistId, resource.panelistId),
				),
				sql`${start} < ${resource.end.toISOString()}::timestamptz`,
				or(gt(interviewRound.end, resource.start), overtime),
				excludeId ? ne(interviewRound.id, excludeId) : undefined,
			),
		)
		.orderBy(interviewRound.id);
	const conflicts = rows.map(({ round, drive }) => {
		const resources: InterviewConflict["resources"] = [];
		if (round.invitedEmail === resource.invitedEmail)
			resources.push("candidate");
		if (round.panelistId === resource.panelistId) resources.push("panelist");
		return {
			id: round.id,
			drive,
			resources,
			timeZone: round.timeZone,
			start: (round.startedAt && round.startedAt < round.start
				? round.startedAt
				: round.start
			).toISOString(),
			end:
				round.state === "active" && round.end <= now
					? null
					: round.end.toISOString(),
		};
	});
	const token = hash(
		JSON.stringify([
			resource.invitedEmail,
			resource.panelistId,
			resource.start,
			resource.end,
			conflicts,
		]),
	);
	if (conflicts.length && acknowledge !== token) {
		throw new InterviewProblem(409, "slot_conflict", {
			conflicts,
			acknowledge: token,
		});
	}
}

function scheduledCandidates(round: { driveId: string; candidateId: string }) {
	return and(
		eq(interviewRound.driveId, round.driveId),
		eq(interviewRound.candidateId, round.candidateId),
	);
}

async function wasWithdrawn(
	tx: Transaction,
	round: { driveId: string; candidateId: string },
) {
	const [withdrawal] = await tx
		.select({ id: interviewWithdrawal.candidateId })
		.from(interviewWithdrawal)
		.where(
			and(
				eq(interviewWithdrawal.driveId, round.driveId),
				eq(interviewWithdrawal.candidateId, round.candidateId),
			),
		);
	return Boolean(withdrawal);
}

async function requirePanelist(
	tx: Transaction,
	config: InterviewConfig,
	id: string,
) {
	const staff = await lockStaff(tx, id, config.domains);
	if (staff?.role !== "panelist")
		throw new InterviewProblem(409, "panelist_ineligible");
}

function requireCandidacyRevision(
	candidate: Awaited<ReturnType<typeof lockCandidacy>>,
	revision: number,
) {
	if (candidate.revision !== revision)
		throw new InterviewProblem(409, "revision_conflict", {
			candidacy: {
				id: candidate.id,
				name: candidate.name,
				email: candidate.email,
				years: years(candidate.experienceTenths),
				revision: candidate.revision,
			},
		});
}

export function bookInterview(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	input: BookInterview,
) {
	return database.transaction(async (tx) => {
		const actor = { actor: "staff", actorId: staffId } as const;
		const receipt = await commandReceipt(tx, config, actor, input, "book");
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id: receipt.previous.resourceId };
		}

		const candidate = await lockCandidacy(tx, input.driveId, input.candidateId);
		const email = candidateEmailSchema.safeParse(candidate.email);
		const name = candidateFieldsSchema.shape.name.safeParse(candidate.name);
		const [attempt] = await tx
			.select({
				last: sql<number>`coalesce(max(${interviewRound.attempt}), 0)`,
				open: sql<boolean>`coalesce(bool_or(${interviewRound.state} in ('scheduled', 'active', 'awaiting_feedback')), false)`,
			})
			.from(interviewRound)
			.where(and(scheduledCandidates(input), eq(interviewRound.level, "l1")));
		if (
			input.level !== "l1" ||
			candidate.reviewState !== "confirmed" ||
			!email.success ||
			!name.success ||
			!name.data ||
			attempt.open ||
			(await wasWithdrawn(tx, input))
		) {
			throw new InterviewProblem(409, "round_not_eligible");
		}
		requireCandidacyRevision(candidate, input.candidateRevision);

		await requirePanelist(tx, config, input.panelistId);
		await lockResources(tx, email.data, input.panelistId);
		await lock(tx, `interview:preferences:${staffId}`);
		const preferences = await readPreferences(tx, staffId);
		if (input.preferenceRevision !== preferences.revision) {
			throw new InterviewProblem(409, "preferences_changed", { preferences });
		}
		const { start, end, timeZone, duration } = resolveSlot(
			input.slot,
			preferences.timeZone,
		);
		const resource = {
			start,
			end,
			timeZone,
			duration,
			invitedEmail: email.data,
			panelistId: input.panelistId,
		};
		await checkConflicts(tx, resource, currentTime(config), input.acknowledge);
		const [round] = await tx
			.insert(interviewRound)
			.values({
				...resource,
				driveId: candidate.driveId,
				candidateId: candidate.id,
				candidateName: name.data,
				experienceTenths: candidate.experienceTenths,
				level: input.level,
				attempt: attempt.last + 1,
				meeting: input.meeting,
				createdBy: staffId,
			})
			.returning({ id: interviewRound.id });
		await createInvitation(tx, config, round.id);
		await recordEvent(tx, actor, input, "book", 0, round.id);
		await receipt.record(round.id);
		return round;
	});
}

async function addWithdrawal(
	tx: Transaction,
	scope: { driveId: string; candidateId: string },
	staffId: string,
	reason: string,
) {
	await tx.insert(interviewWithdrawal).values({
		driveId: scope.driveId,
		candidateId: scope.candidateId,
		staffId,
		reason,
	});
}

export function withdrawCandidacy(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	scope: { driveId: string; candidateId: string },
	input: { commandId: string; revision: number; reason: string },
) {
	return database.transaction(async (tx) => {
		const actor = { actor: "staff", actorId: staffId } as const;
		const receipt = await commandReceipt(
			tx,
			config,
			actor,
			input,
			`withdraw:${scope.driveId}:${scope.candidateId}`,
		);
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id: receipt.previous.resourceId };
		}
		const candidate = await lockCandidacy(tx, scope.driveId, scope.candidateId);
		requireCandidacyRevision(candidate, input.revision);
		const [open] = await tx
			.select({ id: interviewRound.id })
			.from(interviewRound)
			.where(
				and(
					scheduledCandidates(scope),
					inArray(interviewRound.state, unresolved),
				),
			)
			.limit(1);
		if (
			candidate.reviewState !== "confirmed" ||
			open ||
			(await wasWithdrawn(tx, scope))
		) {
			throw new InterviewProblem(409, "round_not_eligible");
		}
		await addWithdrawal(tx, scope, staffId, input.reason);
		await recordEvent(tx, actor, scope, "withdraw", candidate.revision);
		await receipt.record(candidate.id);
		return { id: candidate.id };
	});
}

export async function closeRound(
	tx: Transaction,
	actor: Actor,
	round: RoundRow,
	now: Date,
) {
	await tx
		.update(interviewRound)
		.set({
			state: "awaiting_feedback",
			closedAt: now,
			revision: round.revision + 1,
		})
		.where(eq(interviewRound.id, round.id));
	await revokeAdmission(tx, round.id, now);
	await recordEvent(tx, actor, round, "end", round.revision + 1, round.id);
}

export function changeRound(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	role: StaffRole,
	id: string,
	input: InterviewCommand,
) {
	return database.transaction(async (tx) => {
		const actor = { actor: "staff", actorId: staffId } as const;
		const receipt = await commandReceipt(
			tx,
			config,
			actor,
			input,
			`round:${id}`,
		);
		const [scope] = await tx
			.select()
			.from(interviewRound)
			.where(eq(interviewRound.id, id));
		if (!scope || (role === "panelist" && scope.panelistId !== staffId))
			throw new InterviewProblem(404, "not_found");
		await lockCandidacy(tx, scope.driveId, scope.candidateId);
		const [snapshot] = await tx
			.select()
			.from(interviewRound)
			.where(eq(interviewRound.id, id));
		if (role === "panelist") {
			if (snapshot.panelistId !== staffId)
				throw new InterviewProblem(404, "not_found");
			if ((await lockStaff(tx, staffId, config.domains))?.role !== "panelist")
				throw new InterviewProblem(403, "forbidden");
		}
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id };
		}
		if (
			role === "hr" &&
			input.action === "reassign" &&
			snapshot.state === "scheduled" &&
			snapshot.revision === input.revision
		) {
			await requirePanelist(tx, config, input.panelistId);
		}
		await lockResources(
			tx,
			snapshot.invitedEmail,
			snapshot.panelistId,
			input.action === "reassign" ? input.panelistId : snapshot.panelistId,
		);
		const [round] = await tx
			.select()
			.from(interviewRound)
			.where(eq(interviewRound.id, id))
			.for("update");
		const now = currentTime(config);
		if (round.revision !== input.revision) {
			const current =
				role === "hr"
					? await getHrRound(tx, id, now)
					: await getAssignedRound(tx, id, staffId, now);
			throw new InterviewProblem(409, "revision_conflict", { round: current });
		}
		const invalid = () => new InterviewProblem(409, "invalid_transition");
		if (input.action === "end") {
			if (round.state !== "active") throw invalid();
			await closeRound(tx, actor, round, now);
		} else {
			const next: Partial<typeof interviewRound.$inferInsert> = {
				revision: round.revision + 1,
			};
			if (input.action === "start") {
				if (role !== "panelist" || round.state !== "scheduled") throw invalid();
				requireEntryWindow(round, now);
				const [session] = await tx
					.select({ lastSeen: interviewSession.lastSeenAt })
					.from(interviewSession)
					.where(
						and(
							eq(interviewSession.roundId, id),
							isNull(interviewSession.revokedAt),
						),
					);
				if (!presenceFresh(session?.lastSeen, now))
					throw new InterviewProblem(409, "candidate_not_present");
				Object.assign(next, {
					state: "active",
					startedBy: staffId,
					startedAt: now,
				} satisfies Partial<typeof interviewRound.$inferInsert>);
			} else {
				if (
					role !== "hr" ||
					(round.state !== "scheduled" &&
						!(input.action === "withdraw" && round.state === "active"))
				)
					throw invalid();
				await applyHrChange(tx, config, staffId, input, round, next, now);
			}
			await tx
				.update(interviewRound)
				.set(next)
				.where(eq(interviewRound.id, id));
			await recordEvent(tx, actor, round, input.action, round.revision + 1, id);
		}
		await receipt.record(id);
		return { id };
	});
}

async function applyHrChange(
	tx: Transaction,
	config: InterviewConfig,
	staffId: string,
	input: Exclude<InterviewCommand, { action: "start" | "end" }>,
	round: RoundRow,
	next: Partial<typeof interviewRound.$inferInsert>,
	now: Date,
) {
	const id = round.id;
	switch (input.action) {
		case "meeting":
			if (input.meeting.mode !== round.meeting.mode)
				throw new InterviewProblem(409, "invalid_transition");
			next.meeting = input.meeting;
			break;
		case "reassign":
			await checkConflicts(
				tx,
				{ ...round, panelistId: input.panelistId },
				now,
				input.acknowledge,
				id,
			);
			next.panelistId = input.panelistId;
			break;
		case "reschedule": {
			const { start, end, duration } = resolveSlot(input.slot, round.timeZone);
			const slot = { start, end, duration };
			await checkConflicts(
				tx,
				{ ...round, ...slot },
				now,
				input.acknowledge,
				id,
			);
			Object.assign(next, slot);
			await revokeAdmission(tx, id, now);
			await createInvitation(tx, config, id);
			break;
		}
		case "replace_link":
			await revokeAdmission(tx, id, now);
			await createInvitation(tx, config, id);
			break;
		case "no_show":
			if (now < round.end)
				throw new InterviewProblem(409, "invalid_transition");
			next.absent = input.absent;
			next.reason = input.reason;
			break;
		case "withdraw":
			await addWithdrawal(tx, round, staffId, input.reason);
			next.reason = input.reason;
			break;
	}
	if (
		input.action === "cancel" ||
		input.action === "no_show" ||
		input.action === "withdraw"
	) {
		next.state =
			input.action === "cancel"
				? "cancelled"
				: input.action === "withdraw"
					? "withdrawn"
					: "no_show";
		next.closedAt = now;
		await revokeAdmission(tx, id, now);
	}
}

export async function copyInvitation(
	database: Database,
	config: InterviewConfig,
	roundId: string,
) {
	const [result] = await database
		.select({ invitation: interviewInvitation, round: interviewRound })
		.from(interviewInvitation)
		.innerJoin(
			interviewRound,
			eq(interviewRound.id, interviewInvitation.roundId),
		)
		.where(
			and(
				eq(interviewInvitation.roundId, roundId),
				isNull(interviewInvitation.revokedAt),
				inArray(interviewRound.state, occupying),
			),
		);
	if (!result) throw new InterviewProblem(404, "not_found");
	const { invitation, round } = result;
	const link = new URL(`/join/${invitation.id}`, config.origin);
	const secret = invitationSecret(config, invitation.id);
	if (!sameDigest(hash(secret), invitation.secretHash))
		throw new InterviewProblem(409, "invite_unavailable");
	link.hash = secret;
	const format = new Intl.DateTimeFormat("en-GB", {
		timeZone: round.timeZone,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	});
	const meeting =
		round.meeting.mode === "virtual"
			? round.meeting.teamsUrl
			: round.meeting.room;
	const text = [
		`Interview Studio · ${round.level.toUpperCase()} interview`,
		`Start: ${format.format(round.start)} (${round.timeZone})`,
		`End: ${format.format(round.end)} (${round.timeZone})`,
		`Studio: ${link.href}`,
		meeting
			? `${round.meeting.mode === "virtual" ? "Teams" : "Room"}: ${meeting}`
			: "Teams link pending",
	].join("\n");
	return { link: link.href, text };
}
