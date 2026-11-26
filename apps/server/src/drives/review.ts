import { randomUUID } from "node:crypto";
import type {
	candidatePatchSchema,
	duplicateActionSchema,
	Round,
	skillSaveSchema,
} from "@studio/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { occupying } from "../interviews/queries.ts";
import { interviewRound } from "../interviews/schema.ts";
import { DriveProblem } from "./errors.ts";
import { candidateView, type Database, skillSet } from "./queries.ts";
import { driveCandidate, driveSkills } from "./schema.ts";

type CandidateChange =
	| { type: "save"; input: z.infer<typeof candidatePatchSchema> }
	| { type: "confirm"; input: { revision: number } }
	| { type: "duplicate"; input: z.infer<typeof duplicateActionSchema> };

function isDuplicateEmail(error: unknown) {
	const cause = (error as { cause?: unknown })?.cause ?? error;
	return (
		(cause as { constraint?: string })?.constraint ===
		"drive_candidate_confirmed_email"
	);
}

export async function changeCandidate(
	database: Database,
	driveId: string,
	id: string,
	change: CandidateChange,
) {
	let attemptedEmail: string | null = null;
	try {
		return await database.transaction(async (tx) => {
			const ids =
				change.type === "duplicate" ? [id, change.input.targetId] : [id];
			const rows = await tx
				.select()
				.from(driveCandidate)
				.where(
					and(
						eq(driveCandidate.driveId, driveId),
						inArray(driveCandidate.id, ids),
					),
				)
				.orderBy(driveCandidate.id)
				.for("update");
			const row = rows.find((entry) => entry.id === id);
			if (
				!row ||
				(change.type === "duplicate" &&
					!rows.some((entry) => entry.id === change.input.targetId))
			) {
				throw new DriveProblem(404, "not_found");
			}
			if (row.revision !== change.input.revision) {
				throw new DriveProblem(409, "revision_conflict", {
					current: candidateView(row),
				});
			}
			if (
				row.reviewState === "duplicate" ||
				(change.type !== "save" && row.reviewState !== "draft")
			) {
				throw new DriveProblem(409, "invalid_review", {
					current: candidateView(row),
				});
			}
			const next: Partial<typeof driveCandidate.$inferInsert> = {
				revision: row.revision + 1,
			};
			if (change.type === "save") {
				if (change.input.name !== undefined) next.name = change.input.name;
				if (change.input.email !== undefined) next.email = change.input.email;
				if (change.input.years !== undefined)
					next.experienceTenths =
						change.input.years === null
							? null
							: Math.round(change.input.years * 10);
			} else if (change.type === "confirm") {
				next.reviewState = "confirmed";
			} else {
				const target = rows.find((entry) => entry.id === change.input.targetId);
				if (!target) throw new DriveProblem(404, "not_found");
				if (target.revision !== change.input.targetRevision) {
					throw new DriveProblem(409, "revision_conflict", {
						current: candidateView(row),
						target: { id: target.id, revision: target.revision },
					});
				}
				if (
					!row.email ||
					row.email !== target.email ||
					target.reviewState !== "confirmed"
				) {
					throw new DriveProblem(409, "invalid_review", {
						current: candidateView(row),
					});
				}
				next.reviewState = "duplicate";
				next.duplicateOf = target.id;
			}
			if ((next.reviewState ?? row.reviewState) === "confirmed") {
				const email = next.email === undefined ? row.email : next.email;
				if (!(next.name ?? row.name))
					throw new DriveProblem(400, "invalid_input", { field: "name" });
				if (row.reviewState === "confirmed" && email !== row.email) {
					const [booking] = await tx
						.select({ id: interviewRound.id })
						.from(interviewRound)
						.where(
							and(
								eq(interviewRound.driveId, driveId),
								eq(interviewRound.candidateId, id),
								inArray(interviewRound.state, occupying),
							),
						)
						.limit(1);
					if (booking)
						throw new DriveProblem(409, "interview_email_in_use", {
							field: "email",
						});
				}
				if (!email)
					throw new DriveProblem(400, "invalid_input", { field: "email" });
				attemptedEmail = email;
			}
			const [updated] = await tx
				.update(driveCandidate)
				.set(next)
				.where(
					and(eq(driveCandidate.id, id), eq(driveCandidate.driveId, driveId)),
				)
				.returning();
			return candidateView(updated);
		});
	} catch (error) {
		if (!attemptedEmail || !isDuplicateEmail(error)) throw error;
		const [target] = await database
			.select({ id: driveCandidate.id, revision: driveCandidate.revision })
			.from(driveCandidate)
			.where(
				and(
					eq(driveCandidate.driveId, driveId),
					eq(driveCandidate.reviewState, "confirmed"),
					eq(driveCandidate.email, attemptedEmail),
				),
			);
		throw new DriveProblem(409, "duplicate_email", { field: "email", target });
	}
}

type SkillChange =
	| { type: "save"; input: z.infer<typeof skillSaveSchema> }
	| { type: "review"; input: { revision: number }; reviewerId: string };

export async function changeSkills(
	database: Database,
	driveId: string,
	round: Round,
	change: SkillChange,
) {
	return database.transaction(async (tx) => {
		const scope = and(
			eq(driveSkills.driveId, driveId),
			eq(driveSkills.round, round),
		);
		const [current] = await tx
			.select()
			.from(driveSkills)
			.where(scope)
			.for("update");
		if (!current) throw new DriveProblem(404, "not_found");
		if (current.revision !== change.input.revision)
			throw new DriveProblem(409, "revision_conflict", {
				current: skillSet(current),
			});
		let next: Pick<
			typeof driveSkills.$inferInsert,
			"skills" | "reviewedAt" | "reviewedBy"
		>;
		if (change.type === "save") {
			const existing = new Set(current.skills.map(({ id }) => id));
			if (change.input.skills.some(({ id }) => id && !existing.has(id)))
				throw new DriveProblem(400, "invalid_input", { field: "skills" });
			const skills = change.input.skills.map(({ id, name }) => ({
				id: id ?? randomUUID(),
				name,
			}));
			next = { skills, reviewedAt: null, reviewedBy: null };
		} else {
			if (!current.skills.length)
				throw new DriveProblem(400, "invalid_input", { field: "skills" });
			next = { reviewedAt: new Date(), reviewedBy: change.reviewerId };
		}
		const [updated] = await tx
			.update(driveSkills)
			.set({
				...next,
				revision: sql`${driveSkills.revision} + 1`,
			})
			.where(scope)
			.returning();
		return skillSet(updated);
	});
}
