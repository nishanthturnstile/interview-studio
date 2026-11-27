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
import { getAssignedRound, getHrRound, occupying, years } from "./queries.ts";
import {
	interviewAssessment,
	interviewAssessmentVersion,
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
import {
	advanceWorkflow,
	captureCriteria,
	lockCriteria,
	readEligibleCandidacy,
	requireNoPendingReview,
	requireWorkflowRevision,
} from "./workflow.ts";

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

async function lockHr(
	tx: Transaction,
	config: InterviewConfig,
	hrId: string,
	panelistId?: string,
) {
	let panelist: Awaited<ReturnType<typeof lockStaff>> = null;
	for (const id of [...new Set([hrId, panelistId ?? hrId])].sort()) {
		const staff = await lockStaff(tx, id, config.domains);
		if (id === hrId && staff?.role !== "hr")
			throw new InterviewProblem(403, "forbidden");
		if (id === panelistId) panelist = staff;
	}
	return panelist;
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
			await lockHr(tx, config, staffId);
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id: receipt.previous.resourceId };
		}

		const candidate = await lockCandidacy(tx, input.driveId, input.candidateId);
		const skills = await lockCriteria(tx, input.driveId, input.level);
		const panelist = await lockHr(tx, config, staffId, input.panelistId);
		const email = candidateEmailSchema.safeParse(candidate.email);
		const name = candidateFieldsSchema.shape.name.safeParse(candidate.name);
		if (!email.success || !name.success || !name.data)
			throw new InterviewProblem(409, "round_not_eligible");
		const eligible = await readEligibleCandidacy(tx, input);
		if (eligible.level !== input.level)
			throw new InterviewProblem(409, "round_not_eligible");
		requireCandidacyRevision(candidate, input.candidateRevision);
		requireWorkflowRevision(input.workflowRevision, eligible.workflowRevision);

		const criteria = captureCriteria(skills, "booking", currentTime(config));
		if (input.skillRevision !== skills.revision)
			throw new InterviewProblem(409, "skills_changed", { criteria: skills });

		if (panelist?.role !== "panelist")
			throw new InterviewProblem(409, "panelist_ineligible");
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
				qualifyingL1RoundId: eligible.qualifyingL1RoundId,
				qualifyingL1VersionId: eligible.qualifyingL1VersionId,
				attempt: eligible.lastAttempt + 1,
				meeting: input.meeting,
				createdBy: staffId,
			})
			.returning({ id: interviewRound.id });
		await tx
			.insert(interviewAssessment)
			.values({ roundId: round.id, criteria });
		await advanceWorkflow(
			tx,
			input,
			input.level === "l2" ? { currentL2RoundId: round.id } : undefined,
		);
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
	input: {
		commandId: string;
		revision: number;
		workflowRevision: number;
		reason: string;
	},
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
			await lockHr(tx, config, staffId);
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id: receipt.previous.resourceId };
		}
		const candidate = await lockCandidacy(tx, scope.driveId, scope.candidateId);
		await lockHr(tx, config, staffId);
		requireCandidacyRevision(candidate, input.revision);
		const eligible = await readEligibleCandidacy(tx, scope);
		requireWorkflowRevision(input.workflowRevision, eligible.workflowRevision);
		await addWithdrawal(tx, scope, staffId, input.reason);
		await advanceWorkflow(tx, scope, { currentL2RoundId: null });
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
		} else {
			const reassign =
				!receipt.previous &&
				input.action === "reassign" &&
				snapshot.state === "scheduled" &&
				snapshot.revision === input.revision;
			const recover =
				!receipt.previous && input.action === "cancel_unavailable_panelist";
			const panelist = await lockHr(
				tx,
				config,
				staffId,
				reassign ? input.panelistId : recover ? snapshot.panelistId : undefined,
			);
			if (reassign && panelist?.role !== "panelist")
				throw new InterviewProblem(409, "panelist_ineligible");
			if (recover && panelist?.role === "panelist")
				throw new InterviewProblem(409, "invalid_transition");
		}
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id };
		}
		await requireNoPendingReview(tx, snapshot);
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
					? await getHrRound(tx, id, now, config.domains)
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
					(input.action === "cancel_unavailable_panelist" &&
						round.state !== "awaiting_feedback") ||
					(round.state !== "scheduled" &&
						!(input.action === "withdraw" && round.state === "active") &&
						!(
							input.action === "cancel_unavailable_panelist" &&
							round.state === "awaiting_feedback"
						))
				)
					throw invalid();
				await applyHrChange(tx, config, staffId, input, round, next, now);
				if (
					input.action === "cancel" ||
					input.action === "no_show" ||
					input.action === "withdraw" ||
					input.action === "cancel_unavailable_panelist"
				)
					await advanceWorkflow(
						tx,
						round,
						input.action === "withdraw"
							? { currentL2RoundId: null }
							: undefined,
					);
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
		case "cancel_unavailable_panelist": {
			const [submitted] = await tx
				.select({ id: interviewAssessmentVersion.id })
				.from(interviewAssessmentVersion)
				.where(eq(interviewAssessmentVersion.roundId, id))
				.limit(1);
			if (submitted) throw new InterviewProblem(409, "invalid_transition");
			next.reason = input.reason;
			next.cancelledAt = now;
			next.cancellationCode = "panelist_unavailable";
			next.state = "cancelled";
			await revokeAdmission(tx, id, now);
			break;
		}
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
			? `${round.meeting.mode === "virtual" ? "Meeting" : "Room"}: ${meeting}`
			: "Meeting link pending",
	].join("\n");
	return { link: link.href, text };
}
