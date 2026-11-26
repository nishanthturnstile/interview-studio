import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { CandidateInterview } from "@studio/contracts";
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { InterviewProblem } from "./problem.ts";
import { occupying, roundCore, years } from "./queries.ts";
import { closeRound } from "./scheduling.ts";
import {
	interviewAttendance,
	interviewChallenge,
	interviewInvitation,
	interviewRateLimit,
	interviewRound,
	interviewSession,
} from "./schema.ts";
import {
	commandReceipt,
	currentTime,
	type Database,
	hash,
	type InterviewConfig,
	invitationSecret,
	recordEvent,
	sameDigest,
	sign,
	type Transaction,
} from "./store.ts";
import { entryOpensAt, requireEntryWindow } from "./time.ts";

type InviteInput = { secret: string; email: string };
type VerifyInput = InviteInput & { challengeId: string; code: string };
type Mail = (to: string, subject: string, text: string) => Promise<void>;

const resendDelay = 60_000;
const sendBudget = 900_000;
const pendingLease = 60_000;
const codeLifetime = 600_000;

function throttle(seconds: number) {
	return new InterviewProblem(429, "rate_limited", {
		retryAfter: Math.max(1, Math.ceil(seconds)),
	});
}

export async function limitPublicRequests(
	database: Database,
	config: InterviewConfig,
	source: string,
	action: string,
) {
	const key = sign(config.key, "source", action, source);
	const now = currentTime(config);
	const expired = new Date(now.getTime() - 60_000);
	const [state] = await database
		.insert(interviewRateLimit)
		.values({ key, windowStart: now, attempts: 1 })
		.onConflictDoUpdate({
			target: interviewRateLimit.key,
			set: {
				windowStart: sql`case when ${interviewRateLimit.windowStart} <= ${expired.toISOString()}::timestamptz then excluded.window_start else ${interviewRateLimit.windowStart} end`,
				attempts: sql`case when ${interviewRateLimit.windowStart} <= ${expired.toISOString()}::timestamptz then 1 else least(${interviewRateLimit.attempts} + 1, 61) end`,
			},
		})
		.returning();
	if (state.attempts > 60)
		throw throttle(
			(state.windowStart.getTime() + 60_000 - now.getTime()) / 1_000,
		);
}

async function lockInvite(
	tx: Transaction,
	config: InterviewConfig,
	invitationId: string,
	input: InviteInput,
) {
	const denied = () => new InterviewProblem(404, "invite_unavailable");
	const [initial] = await tx
		.select({ roundId: interviewInvitation.roundId })
		.from(interviewInvitation)
		.where(eq(interviewInvitation.id, invitationId));
	if (!initial) throw denied();
	const [round] = await tx
		.select()
		.from(interviewRound)
		.where(eq(interviewRound.id, initial.roundId))
		.for("update");
	const [invite] = await tx
		.select()
		.from(interviewInvitation)
		.where(
			and(
				eq(interviewInvitation.id, invitationId),
				isNull(interviewInvitation.revokedAt),
			),
		);
	if (
		!invite ||
		!sameDigest(invite.secretHash, hash(input.secret)) ||
		!sameDigest(input.secret, invitationSecret(config, invitationId)) ||
		!sameDigest(hash(round.invitedEmail), hash(input.email)) ||
		!occupying.some((state) => state === round.state)
	) {
		throw denied();
	}
	const now = currentTime(config);
	requireEntryWindow(round, now);
	return { round, now };
}

export async function requestCode(
	database: Database,
	config: InterviewConfig,
	mail: Mail,
	invitationId: string,
	input: InviteInput,
) {
	const code = String(randomInt(1_000_000)).padStart(6, "0");
	const challengeId = randomUUID();
	const reservation = await database.transaction(async (tx) => {
		const { round, now } = await lockInvite(tx, config, invitationId, input);
		const windowStart = new Date(now.getTime() - sendBudget);
		const recent = await tx
			.select()
			.from(interviewChallenge)
			.where(
				and(
					eq(interviewChallenge.invitationId, invitationId),
					gt(interviewChallenge.createdAt, windowStart),
					ne(interviewChallenge.phase, "failed"),
				),
			)
			.orderBy(desc(interviewChallenge.createdAt))
			.limit(3);
		const latest = recent[0];
		const nextSend = latest
			? latest.createdAt.getTime() + resendDelay
			: now.getTime();
		if (now.getTime() < nextSend)
			throw throttle((nextSend - now.getTime()) / 1_000);
		if (recent.length >= 3)
			throw throttle(
				(recent[2].createdAt.getTime() + sendBudget - now.getTime()) / 1_000,
			);
		await tx
			.update(interviewChallenge)
			.set({ revokedAt: now })
			.where(
				and(
					eq(interviewChallenge.invitationId, invitationId),
					isNull(interviewChallenge.revokedAt),
					isNull(interviewChallenge.consumedAt),
				),
			);
		const expiresAt = new Date(
			Math.min(now.getTime() + codeLifetime, round.end.getTime()),
		);
		await tx.insert(interviewChallenge).values({
			id: challengeId,
			invitationId,
			phase: "pending",
			createdAt: now,
			expiresAt,
			codeDigest: sign(
				config.key,
				"mail-code",
				invitationId,
				challengeId,
				code,
			),
		});
		return {
			email: round.invitedEmail,
			roundId: round.id,
			expiresAt,
			reservedAt: now,
		};
	});

	let sent = false;
	try {
		await mail(
			reservation.email,
			"Your Interview Studio code",
			`Your Interview Studio verification code is ${code}.\n\nUse it in the interview tab before it expires.`,
		);
		sent = true;
	} catch {
		// The shared mailer logs the transport error without message contents.
	}
	const completed = await database.transaction(async (tx) => {
		const [round] = await tx
			.select()
			.from(interviewRound)
			.where(eq(interviewRound.id, reservation.roundId))
			.for("update");
		const now = currentTime(config);
		const usable =
			sent &&
			now < reservation.expiresAt &&
			now.getTime() - reservation.reservedAt.getTime() < pendingLease &&
			occupying.some((state) => state === round.state);
		const [updated] = await tx
			.update(interviewChallenge)
			.set(
				usable
					? { phase: "sent" }
					: sent
						? { phase: "sent", revokedAt: now }
						: { phase: "failed", revokedAt: now },
			)
			.where(
				and(
					eq(interviewChallenge.id, challengeId),
					eq(interviewChallenge.phase, "pending"),
					isNull(interviewChallenge.revokedAt),
				),
			)
			.returning({ id: interviewChallenge.id });
		return Boolean(updated) && usable;
	});
	if (!sent) throw new InterviewProblem(503, "delivery_failed");
	if (!completed) throw new InterviewProblem(404, "invite_unavailable");

	return {
		challengeId,
		expiresAt: reservation.expiresAt.toISOString(),
		resendAt: new Date(
			reservation.reservedAt.getTime() + resendDelay,
		).toISOString(),
	};
}

export async function verifyCode(
	database: Database,
	config: InterviewConfig,
	invitationId: string,
	input: VerifyInput,
) {
	const session = await database.transaction(async (tx) => {
		const { round, now } = await lockInvite(tx, config, invitationId, input);
		const [challenge] = await tx
			.select()
			.from(interviewChallenge)
			.where(
				and(
					eq(interviewChallenge.id, input.challengeId),
					eq(interviewChallenge.invitationId, invitationId),
					eq(interviewChallenge.phase, "sent"),
					isNull(interviewChallenge.revokedAt),
					isNull(interviewChallenge.consumedAt),
				),
			);
		if (!challenge || challenge.expiresAt <= now || challenge.attempts <= 0)
			return null;
		const expected = sign(
			config.key,
			"mail-code",
			invitationId,
			input.challengeId,
			input.code,
		);
		if (!sameDigest(challenge.codeDigest, expected)) {
			await tx
				.update(interviewChallenge)
				.set({ attempts: challenge.attempts - 1 })
				.where(eq(interviewChallenge.id, challenge.id));
			return null;
		}
		await tx
			.update(interviewChallenge)
			.set({ consumedAt: now })
			.where(eq(interviewChallenge.id, challenge.id));
		await tx
			.update(interviewSession)
			.set({ revokedAt: now })
			.where(
				and(
					eq(interviewSession.roundId, round.id),
					isNull(interviewSession.revokedAt),
				),
			);
		const token = randomBytes(32).toString("base64url");
		const [created] = await tx
			.insert(interviewSession)
			.values({
				roundId: round.id,
				invitationId,
				tokenHash: hash(token),
				admittedAt: now,
			})
			.returning({ id: interviewSession.id });
		await recordEvent(
			tx,
			{ actor: "candidate", actorId: created.id },
			round,
			"admitted",
			round.revision,
			round.id,
		);
		return { id: round.id, token };
	});
	if (!session) throw new InterviewProblem(409, "invalid_code");
	return session;
}

type CandidateAction =
	| { action: "read" | "presence" }
	| { action: "confirm"; name: string; years: number | null }
	| { action: "end"; commandId: string; revision: number };

export function candidateRound(
	database: Database,
	config: InterviewConfig,
	id: string,
	token: string | undefined,
	action: Extract<CandidateAction, { action: "end" }>,
): Promise<{ completed: true }>;
export function candidateRound(
	database: Database,
	config: InterviewConfig,
	id: string,
	token: string | undefined,
	action: Exclude<CandidateAction, { action: "end" }>,
): Promise<CandidateInterview>;
export function candidateRound(
	database: Database,
	config: InterviewConfig,
	id: string,
	token: string | undefined,
	action: CandidateAction,
) {
	const unavailable = () => new InterviewProblem(404, "unavailable");
	if (!token) throw new InterviewProblem(401, "unavailable");
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
	return database.transaction(async (tx) => {
		// Candidate writes serialize on the round before touching admission rows.
		const [round] = await tx
			.select()
			.from(interviewRound)
			.where(eq(interviewRound.id, id))
			.for("update");
		const [session] = await tx
			.select({
				session: interviewSession,
				revoked: interviewInvitation.revokedAt,
			})
			.from(interviewSession)
			.innerJoin(
				interviewInvitation,
				eq(interviewSession.invitationId, interviewInvitation.id),
			)
			.where(
				and(
					eq(interviewSession.roundId, id),
					eq(interviewSession.tokenHash, hash(token)),
				),
			);
		if (!round || !session) throw unavailable();
		const actor = { actor: "candidate", actorId: session.session.id } as const;
		const receipt =
			action.action === "end"
				? await commandReceipt(tx, config, actor, action, `round:${id}`)
				: null;
		if (receipt?.previous) {
			if (receipt.matches && receipt.previous.resourceId === id)
				return { completed: true } as const;
			if (!session.session.revokedAt)
				throw new InterviewProblem(409, "idempotency_conflict");
		}
		const now = currentTime(config);
		if (
			session.revoked ||
			session.session.revokedAt ||
			(round.state !== "active" &&
				(round.state !== "scheduled" ||
					now < entryOpensAt(round.start) ||
					now >= round.end))
		) {
			throw unavailable();
		}

		let [attendance] = await tx
			.select()
			.from(interviewAttendance)
			.where(eq(interviewAttendance.roundId, id));
		let confirmed = Boolean(session.session.confirmedAt);
		const profile = (): CandidateInterview => {
			const core = roundCore(round);
			return {
				id: core.id,
				level: core.level,
				start: core.start,
				end: core.end,
				timeZone: core.timeZone,
				duration: core.duration,
				meeting: core.meeting,
				revision: core.revision,
				state: core.state,
				startedAt: core.startedAt,
				closedAt: core.closedAt,
				confirmed,
				candidate: attendance
					? { name: attendance.name, years: years(attendance.experienceTenths) }
					: core.candidate,
			};
		};
		if (action.action === "end") {
			if (!confirmed || round.state !== "active")
				throw new InterviewProblem(409, "invalid_transition");
			if (action.revision !== round.revision)
				throw new InterviewProblem(409, "revision_conflict", {
					round: profile(),
				});
			await closeRound(tx, actor, round, now);
			await receipt?.record(id);
			return { completed: true } as const;
		}
		if (action.action === "confirm" && !confirmed) {
			const values = {
				name: action.name,
				experienceTenths:
					action.years === null ? null : Math.round(action.years * 10),
				confirmedAt: now,
				lastSeenAt: now,
			};
			[attendance] = await tx
				.insert(interviewAttendance)
				.values({ roundId: id, ...values })
				.onConflictDoUpdate({
					target: interviewAttendance.roundId,
					set: {
						...values,
						confirmedAt: sql`${interviewAttendance.confirmedAt}`,
					},
				})
				.returning();
			await tx
				.update(interviewSession)
				.set({ confirmedAt: now, lastSeenAt: now })
				.where(eq(interviewSession.id, actor.actorId));
			await recordEvent(
				tx,
				actor,
				round,
				"confirm_profile",
				round.revision,
				id,
			);
			confirmed = true;
		}
		if (action.action === "presence") {
			if (!confirmed) throw new InterviewProblem(409, "invalid_transition");
			await tx
				.update(interviewAttendance)
				.set({ lastSeenAt: now })
				.where(eq(interviewAttendance.roundId, id));
			await tx
				.update(interviewSession)
				.set({ lastSeenAt: now })
				.where(eq(interviewSession.id, actor.actorId));
		}
		return profile();
	});
}

export async function sweepAdmission(database: Database, now: Date) {
	const oldBudget = new Date(now.getTime() - sendBudget);
	await database
		.delete(interviewChallenge)
		.where(
			inArray(
				interviewChallenge.id,
				database
					.select({ id: interviewChallenge.id })
					.from(interviewChallenge)
					.where(lt(interviewChallenge.createdAt, oldBudget))
					.limit(250),
			),
		);
	await database
		.delete(interviewRateLimit)
		.where(
			and(
				lt(interviewRateLimit.windowStart, oldBudget),
				inArray(
					interviewRateLimit.key,
					database
						.select({ key: interviewRateLimit.key })
						.from(interviewRateLimit)
						.where(lt(interviewRateLimit.windowStart, oldBudget))
						.limit(250),
				),
			),
		);
}
