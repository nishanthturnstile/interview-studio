import { and, eq } from "drizzle-orm";
import { InterviewProblem } from "./problem.ts";
import {
	interviewInvitation,
	interviewRound,
	interviewSession,
} from "./schema.ts";
import {
	currentTime,
	type Database,
	hash,
	type InterviewConfig,
	type Transaction,
} from "./store.ts";
import { entryOpensAt } from "./time.ts";

export const candidateUnavailable = () =>
	new InterviewProblem(404, "unavailable");

export function candidateToken(token: string | undefined) {
	if (!token) throw new InterviewProblem(401, "unavailable");
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw candidateUnavailable();
	return hash(token);
}

export function candidateIdentity(
	database: Database | Transaction,
	id: string,
	tokenHash: string,
) {
	return database
		.select({
			session: interviewSession,
			invitationRevokedAt: interviewInvitation.revokedAt,
		})
		.from(interviewSession)
		.innerJoin(
			interviewInvitation,
			eq(interviewSession.invitationId, interviewInvitation.id),
		)
		.where(
			and(
				eq(interviewSession.roundId, id),
				eq(interviewSession.tokenHash, tokenHash),
			),
		);
}

export async function lockCandidateRound(
	tx: Transaction,
	id: string,
	tokenHash: string,
) {
	// All candidate writes take the round lock before reading admission rows.
	const [round] = await tx
		.select()
		.from(interviewRound)
		.where(eq(interviewRound.id, id))
		.for("update");
	const [identity] = await candidateIdentity(tx, id, tokenHash);
	if (!round || !identity) throw candidateUnavailable();
	return { round, ...identity };
}

export function requireCurrentCandidate(
	config: InterviewConfig,
	{
		round,
		session,
		invitationRevokedAt,
	}: Awaited<ReturnType<typeof lockCandidateRound>>,
) {
	const now = currentTime(config);
	if (
		invitationRevokedAt ||
		session.revokedAt ||
		(round.state !== "active" &&
			(round.state !== "scheduled" ||
				now < entryOpensAt(round.start) ||
				now >= round.end))
	)
		throw candidateUnavailable();
	return now;
}
