import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	defaultInterviewPreferences,
	type InterviewPreferences,
} from "@studio/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../database.ts";
import { driveCandidate } from "../drives/schema.ts";
import { user } from "../staff/auth-schema.ts";
import { getStaff } from "../staff/roles.ts";
import type { StaffSettings } from "../staff/settings.ts";
import { readInterviewProxyAddresses } from "./client-address.ts";
import { InterviewProblem } from "./problem.ts";
import {
	interviewChallenge,
	interviewEvent,
	interviewInvitation,
	interviewPreference,
	interviewReceipt,
	type interviewRound,
	interviewSession,
} from "./schema.ts";
import { validateTimeZone } from "./time.ts";
import { notifyWorkspace } from "./workspace-signals.ts";

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type RoundRow = typeof interviewRound.$inferSelect;
export type Actor = { actor: "staff" | "candidate"; actorId: string };
export type InterviewConfig = {
	key: string;
	origin: string;
	domains: ReadonlySet<string>;
	trustedProxies?: ReadonlySet<string>;
	codeExecutionEnabled?: boolean;
	clock?: () => Date;
};
export function readInterviewConfig(
	env: NodeJS.ProcessEnv,
	staff: StaffSettings,
): InterviewConfig {
	const key = z.string().min(32).parse(env.STUDIO_INTERVIEW_SECRET);
	if (key === staff.secret)
		throw new Error("Interview links require a dedicated key");
	return {
		key,
		origin: staff.origin,
		domains: staff.domains,
		codeExecutionEnabled: env.STUDIO_CODE_EXECUTION_ENABLED === "true",
		trustedProxies: readInterviewProxyAddresses(
			env.STUDIO_INTERVIEW_TRUSTED_PROXIES,
		),
	};
}
export const currentTime = (config: InterviewConfig) =>
	config.clock?.() ?? new Date();

export const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
export function sign(key: string, purpose: string, ...values: string[]) {
	return createHmac("sha256", key)
		.update(JSON.stringify([purpose, ...values]))
		.digest("base64url");
}
export function sameDigest(left: string, right: string) {
	return (
		left.length === right.length &&
		timingSafeEqual(Buffer.from(left), Buffer.from(right))
	);
}

export async function lock(tx: Transaction, key: string) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
	);
}
export async function lockResources(
	tx: Transaction,
	email: string,
	...panelists: string[]
) {
	for (const key of [
		...new Set([
			`candidate:${email}`,
			...panelists.map((id) => `panelist:${id}`),
		]),
	].sort()) {
		await lock(tx, `interview:schedule:${key}`);
	}
}
export async function lockCandidacy(
	tx: Transaction,
	driveId: string,
	candidateId: string,
) {
	const [candidate] = await tx
		.select()
		.from(driveCandidate)
		.where(
			and(
				eq(driveCandidate.driveId, driveId),
				eq(driveCandidate.id, candidateId),
			),
		)
		// Interview events reference this row while candidate commands hold the round lock.
		.for("no key update");
	if (!candidate) throw new InterviewProblem(404, "not_found");
	return candidate;
}

export async function lockStaff(
	tx: Transaction,
	id: string,
	domains: ReadonlySet<string>,
) {
	await tx
		.select({ id: user.id })
		.from(user)
		.where(eq(user.id, id))
		.for("update");
	return getStaff(tx, id, domains);
}

export async function readPreferences(
	database: Database | Transaction,
	staffId: string,
): Promise<InterviewPreferences> {
	const [row] = await database
		.select({
			timeZone: interviewPreference.timeZone,
			duration: interviewPreference.duration,
			revision: interviewPreference.revision,
		})
		.from(interviewPreference)
		.where(eq(interviewPreference.staffId, staffId));
	return row ?? defaultInterviewPreferences;
}

export function savePreferences(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	input: InterviewPreferences,
) {
	const timeZone = validateTimeZone(input.timeZone);
	return database.transaction(async (tx) => {
		if ((await lockStaff(tx, staffId, config.domains))?.role !== "hr")
			throw new InterviewProblem(403, "forbidden");
		await lock(tx, `interview:preferences:${staffId}`);
		const current = await readPreferences(tx, staffId);
		if (current.revision !== input.revision) {
			throw new InterviewProblem(409, "preferences_changed", {
				preferences: current,
			});
		}
		const next = {
			timeZone,
			duration: input.duration,
			revision: current.revision + 1,
		};
		await tx
			.insert(interviewPreference)
			.values({ staffId, ...next })
			.onConflictDoUpdate({ target: interviewPreference.staffId, set: next });
		return next;
	});
}

export function invitationSecret(config: InterviewConfig, id: string) {
	return sign(config.key, "invitation", id);
}

export async function createInvitation(
	tx: Transaction,
	config: InterviewConfig,
	roundId: string,
) {
	const [previous] = await tx
		.select({ generation: interviewInvitation.generation })
		.from(interviewInvitation)
		.where(eq(interviewInvitation.roundId, roundId))
		.orderBy(desc(interviewInvitation.generation))
		.limit(1);
	const id = randomUUID();
	await tx.insert(interviewInvitation).values({
		id,
		roundId,
		generation: (previous?.generation ?? 0) + 1,
		secretHash: hash(invitationSecret(config, id)),
	});
}

export async function revokeAdmission(
	tx: Transaction,
	roundId: string,
	now: Date,
) {
	const [invitation] = await tx
		.update(interviewInvitation)
		.set({ revokedAt: now })
		.where(
			and(
				eq(interviewInvitation.roundId, roundId),
				isNull(interviewInvitation.revokedAt),
			),
		)
		.returning({ id: interviewInvitation.id });
	if (invitation) {
		await tx
			.update(interviewChallenge)
			.set({ revokedAt: now })
			.where(
				and(
					eq(interviewChallenge.invitationId, invitation.id),
					isNull(interviewChallenge.revokedAt),
					isNull(interviewChallenge.consumedAt),
				),
			);
	}
	await tx
		.update(interviewSession)
		.set({ revokedAt: now })
		.where(
			and(
				eq(interviewSession.roundId, roundId),
				isNull(interviewSession.revokedAt),
			),
		);
	await notifyWorkspace(tx, { roundId });
}

export async function commandReceipt(
	tx: Transaction,
	config: InterviewConfig,
	actor: Actor,
	input: { commandId: string },
	scope: string,
) {
	const command = { ...actor, commandId: input.commandId };
	const where = and(
		eq(interviewReceipt.actor, command.actor),
		eq(interviewReceipt.actorId, command.actorId),
		eq(interviewReceipt.commandId, command.commandId),
	);
	const fingerprint = sign(config.key, "command", scope, JSON.stringify(input));
	await lock(
		tx,
		`interview:receipt:${command.actor}:${command.actorId}:${command.commandId}`,
	);
	const [previous] = await tx.select().from(interviewReceipt).where(where);
	return {
		previous,
		matches: previous?.fingerprint === fingerprint,
		async record(resourceId: string) {
			await tx
				.insert(interviewReceipt)
				.values({ ...command, resourceId, fingerprint });
		},
	};
}

export async function recordEvent(
	tx: Transaction,
	actor: Actor,
	scope: { driveId: string; candidateId: string },
	action: string,
	revision: number,
	roundId?: string,
	references: { assessmentVersionId?: string; feedbackReviewId?: string } = {},
) {
	await tx.insert(interviewEvent).values({
		...actor,
		driveId: scope.driveId,
		candidateId: scope.candidateId,
		roundId,
		action,
		revision,
		...references,
	});
}
