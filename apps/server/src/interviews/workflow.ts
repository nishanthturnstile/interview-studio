import type {
	AssessmentCriteria,
	HrInterview,
	Round,
	SkillSet,
} from "@studio/contracts";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	notExists,
	or,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { skillSet } from "../drives/queries.ts";
import { drive, driveCandidate, driveSkills } from "../drives/schema.ts";
import { InterviewProblem } from "./problem.ts";
import {
	interviewAssessmentVersion,
	interviewFeedbackReview,
	interviewProgress,
	interviewRound,
	interviewWithdrawal,
} from "./schema.ts";
import type { Transaction } from "./store.ts";

export type Candidacy = { driveId: string; candidateId: string };
export const unresolved = ["scheduled", "active", "awaiting_feedback"] as const;

export const openFeedbackReview = and(
	eq(interviewFeedbackReview.kind, "pass_reversed"),
	isNull(interviewFeedbackReview.resolvedAt),
);

export function effectiveOutcome(l1: SQLWrapper, l2: SQLWrapper) {
	return sql<HrInterview["effectiveOutcome"]>`case
		when ${interviewWithdrawal.candidateId} is not null then 'withdrawn'
		when ${interviewFeedbackReview.id} is not null then null
		when ${l1} = 'do_not_proceed' then 'do_not_proceed'
		when ${l1} = 'pass' then nullif(${l2}, 'incomplete')
	end`;
}

export async function requireNoPendingReview(
	tx: Transaction,
	scope: Candidacy,
) {
	const [review] = await tx
		.select({ id: interviewFeedbackReview.id })
		.from(interviewFeedbackReview)
		.where(
			and(
				openFeedbackReview,
				eq(interviewFeedbackReview.driveId, scope.driveId),
				eq(interviewFeedbackReview.candidateId, scope.candidateId),
			),
		);
	if (review) throw new InterviewProblem(409, "pending_feedback_review");
}

export async function readCandidacyWorkflow(tx: Transaction, scope: Candidacy) {
	const [state] = await tx
		.select({
			progress: interviewProgress,
			pending: interviewFeedbackReview,
			withdrawn: interviewWithdrawal.candidateId,
		})
		.from(driveCandidate)
		.leftJoin(
			interviewProgress,
			and(
				eq(interviewProgress.driveId, driveCandidate.driveId),
				eq(interviewProgress.candidateId, driveCandidate.id),
			),
		)
		.leftJoin(
			interviewFeedbackReview,
			and(
				openFeedbackReview,
				eq(interviewFeedbackReview.driveId, driveCandidate.driveId),
				eq(interviewFeedbackReview.candidateId, driveCandidate.id),
			),
		)
		.leftJoin(
			interviewWithdrawal,
			and(
				eq(interviewWithdrawal.driveId, driveCandidate.driveId),
				eq(interviewWithdrawal.candidateId, driveCandidate.id),
			),
		)
		.where(
			and(
				eq(driveCandidate.driveId, scope.driveId),
				eq(driveCandidate.id, scope.candidateId),
			),
		);
	if (!state) throw new InterviewProblem(404, "not_found");
	return state;
}

const effectiveL1 = alias(interviewAssessmentVersion, "effective_l1");
const qualifyingL1 = alias(interviewRound, "qualifying_l1");
const nextLevel = sql<Round>`case when ${effectiveL1.decision} = 'pass' then 'l2'::drive_round else 'l1'::drive_round end`;

export function eligibleCandidacies(
	tx: Transaction,
	filter?: SQL,
	level?: Round,
) {
	const l2Head = tx
		.select({ decision: interviewAssessmentVersion.decision })
		.from(interviewAssessmentVersion)
		.where(
			eq(
				interviewAssessmentVersion.roundId,
				interviewProgress.currentL2RoundId,
			),
		)
		.orderBy(desc(interviewAssessmentVersion.version))
		.limit(1)
		.as("current_l2_head");

	return tx
		.select({
			scopeCandidateId: sql<string>`${driveCandidate.id}`.as(
				"scope_candidate_id",
			),
			candidate: driveCandidate,
			drive: { id: drive.id, title: drive.name },
			criteria: driveSkills,
			level: nextLevel.as("next_level"),
			qualifyingL1RoundId: sql<
				string | null
			>`case when ${effectiveL1.decision} = 'pass' then ${qualifyingL1.id} end`.as(
				"qualifying_l1_round_id",
			),
			qualifyingL1VersionId: sql<
				string | null
			>`case when ${effectiveL1.decision} = 'pass' then ${effectiveL1.id} end`.as(
				"qualifying_l1_version_id",
			),
			workflowRevision:
				sql<number>`coalesce(${interviewProgress.revision}, 0)`.as(
					"workflow_revision",
				),
			lastAttempt:
				sql<number>`coalesce((select max(${interviewRound.attempt}) from ${interviewRound}
			where ${interviewRound.driveId} = ${driveCandidate.driveId}
			and ${interviewRound.candidateId} = ${driveCandidate.id}
			and ${interviewRound.level} = ${nextLevel}), 0)`.as("last_attempt"),
		})
		.from(driveCandidate)
		.innerJoin(drive, eq(drive.id, driveCandidate.driveId))
		.leftJoin(
			interviewProgress,
			and(
				eq(interviewProgress.driveId, driveCandidate.driveId),
				eq(interviewProgress.candidateId, driveCandidate.id),
			),
		)
		.leftJoin(effectiveL1, eq(effectiveL1.id, interviewProgress.l1VersionId))
		.leftJoin(
			qualifyingL1,
			and(
				eq(qualifyingL1.driveId, driveCandidate.driveId),
				eq(qualifyingL1.candidateId, driveCandidate.id),
				eq(qualifyingL1.level, "l1"),
				eq(qualifyingL1.id, effectiveL1.roundId),
			),
		)
		.leftJoinLateral(l2Head, sql`true`)
		.leftJoin(
			driveSkills,
			and(
				eq(driveSkills.driveId, driveCandidate.driveId),
				eq(driveSkills.round, nextLevel),
			),
		)
		.where(
			and(
				eq(driveCandidate.reviewState, "confirmed"),
				sql`length(btrim(${driveCandidate.name})) between 1 and 120 and ${driveCandidate.name} !~ '[[:cntrl:]]'`,
				sql`length(${driveCandidate.email}) <= 254 and ${driveCandidate.email} ~ ${z.regexes.email.source}`,
				notExists(
					tx
						.select({ id: interviewFeedbackReview.id })
						.from(interviewFeedbackReview)
						.where(
							and(
								openFeedbackReview,
								eq(interviewFeedbackReview.driveId, driveCandidate.driveId),
								eq(interviewFeedbackReview.candidateId, driveCandidate.id),
							),
						),
				),
				notExists(
					tx
						.select({ id: interviewWithdrawal.candidateId })
						.from(interviewWithdrawal)
						.where(
							and(
								eq(interviewWithdrawal.driveId, driveCandidate.driveId),
								eq(interviewWithdrawal.candidateId, driveCandidate.id),
							),
						),
				),
				notExists(
					tx
						.select({ id: interviewRound.id })
						.from(interviewRound)
						.where(
							and(
								eq(interviewRound.driveId, driveCandidate.driveId),
								eq(interviewRound.candidateId, driveCandidate.id),
								inArray(interviewRound.state, unresolved),
							),
						),
				),
				or(isNull(interviewProgress.l1VersionId), isNotNull(qualifyingL1.id)),
				sql`coalesce(${effectiveL1.decision}, 'incomplete') <> 'do_not_proceed'`,
				sql`coalesce(${l2Head.decision}, 'incomplete') not in ('selected', 'not_selected')`,
				level ? eq(nextLevel, level) : undefined,
				filter,
			),
		);
}

export async function readEligibleCandidacy(tx: Transaction, scope: Candidacy) {
	await requireNoPendingReview(tx, scope);
	const [eligible] = await eligibleCandidacies(
		tx,
		and(
			eq(driveCandidate.driveId, scope.driveId),
			eq(driveCandidate.id, scope.candidateId),
		),
	);
	if (!eligible) throw new InterviewProblem(409, "round_not_eligible");
	return eligible;
}

export function requireWorkflowRevision(
	expected: number,
	workflowRevision: number,
) {
	if (expected !== workflowRevision)
		throw new InterviewProblem(409, "workflow_changed", { workflowRevision });
}

// The caller holds the candidacy lock for every workflow write.
export async function advanceWorkflow(
	tx: Transaction,
	scope: Candidacy,
	changes: Pick<
		typeof interviewProgress.$inferInsert,
		"l1VersionId" | "currentL2RoundId"
	> = {},
) {
	const { driveId, candidateId } = scope;
	await tx
		.insert(interviewProgress)
		.values({ driveId, candidateId, revision: 1, ...changes })
		.onConflictDoUpdate({
			target: [interviewProgress.driveId, interviewProgress.candidateId],
			set: { revision: sql`${interviewProgress.revision} + 1`, ...changes },
		});
}

export function criteriaView(
	level: Round,
	row: typeof driveSkills.$inferSelect | null,
) {
	return row
		? skillSet(row)
		: { round: level, skills: [], revision: 0, reviewedAt: null };
}

export async function lockCriteria(
	tx: Transaction,
	driveId: string,
	level: Round,
) {
	const [row] = await tx
		.select()
		.from(driveSkills)
		.where(and(eq(driveSkills.driveId, driveId), eq(driveSkills.round, level)))
		.for("update");
	return criteriaView(level, row ?? null);
}

export function captureCriteria(
	reviewed: SkillSet,
	source: AssessmentCriteria["source"],
	now: Date,
): AssessmentCriteria {
	if (!reviewed.reviewedAt || !reviewed.skills.length)
		throw new InterviewProblem(409, "skills_need_review", {
			criteria: reviewed,
		});
	return {
		skills: reviewed.skills,
		skillRevision: reviewed.revision,
		reviewedAt: reviewed.reviewedAt,
		capturedAt: now.toISOString(),
		source,
	};
}
