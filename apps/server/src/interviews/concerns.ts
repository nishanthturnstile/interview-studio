import type { SaveConcern } from "@studio/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import {
	lockStaffSession,
	type StaffSessionIdentity,
} from "../staff/session-access.ts";
import { isApprovedEmail } from "../staff/settings.ts";
import { InterviewProblem } from "./problem.ts";
import { interviewConcern as concern, interviewRound } from "./schema.ts";
import {
	currentTime,
	type Database,
	type InterviewConfig,
	lockStaff,
} from "./store.ts";
import { staffWorkspaceAccess } from "./workspace.ts";

const fields = {
	id: concern.id,
	commandId: concern.commandId,
	context: concern.context,
	observation: concern.observation,
	createdAt: concern.createdAt,
};

const toEntry = (row: { id: string; createdAt: Date } & SaveConcern) => ({
	...row,
	createdAt: row.createdAt.toISOString(),
});
const notFound = () => new InterviewProblem(404, "not_found");

export async function readConcerns(
	db: Database,
	config: InterviewConfig,
	roundId: string,
	identity: StaffSessionIdentity,
) {
	const access = staffWorkspaceAccess(db, identity, roundId).as(
		"concern_access",
	);
	const rows = await db
		.select({
			email: access.email,
			state: access.state,
			entry: fields,
		})
		.from(access)
		.leftJoin(
			concern,
			and(
				eq(concern.roundId, access.roundId),
				eq(concern.authorId, identity.userId),
			),
		)
		.where(sql`${access.meeting}->>'mode' = 'virtual'`)
		.orderBy(desc(concern.createdAt), desc(concern.id))
		.limit(50);
	if (!rows[0] || !isApprovedEmail(rows[0].email, config.domains))
		throw notFound();
	return {
		canAdd: rows[0].state === "active" && rows.length < 50,
		entries: rows.flatMap(({ entry }) => (entry ? [toEntry(entry)] : [])),
	};
}

export function saveConcern(
	db: Database,
	config: InterviewConfig,
	roundId: string,
	identity: StaffSessionIdentity,
	input: SaveConcern,
) {
	return db.transaction(async (tx) => {
		if (
			(await lockStaff(tx, identity.userId, config.domains))?.role !==
			"panelist"
		)
			throw notFound();
		await lockStaffSession(tx, identity);
		await tx
			.select({ id: interviewRound.id })
			.from(interviewRound)
			.where(eq(interviewRound.id, roundId))
			.for("update");
		const [access] = await staffWorkspaceAccess(tx, identity, roundId);
		if (
			access?.meeting.mode !== "virtual" ||
			!isApprovedEmail(access.email, config.domains)
		)
			throw notFound();

		// The concern row is its own receipt. It remains available after the round closes.
		const where = and(
			eq(concern.roundId, roundId),
			eq(concern.authorId, identity.userId),
		);
		const [prior] = await tx
			.select(fields)
			.from(concern)
			.where(and(where, eq(concern.commandId, input.commandId)));
		if (prior) {
			if (
				prior.context !== input.context ||
				prior.observation !== input.observation
			)
				throw new InterviewProblem(409, "idempotency_conflict");
			return toEntry(prior);
		}
		if (access.state !== "active")
			throw new InterviewProblem(409, "invalid_transition");
		const total = await tx.$count(concern, eq(concern.roundId, roundId));
		if (total >= 50) throw new InterviewProblem(409, "concern_limit");
		const [created] = await tx
			.insert(concern)
			.values({
				...input,
				roundId,
				authorId: identity.userId,
				createdAt: currentTime(config),
			})
			.returning(fields);
		return toEntry(created);
	});
}
