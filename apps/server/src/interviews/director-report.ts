import {
	type DirectorReportQuery,
	type DirectorResult,
	directorReportSchema,
	directorScorecardsSchema,
} from "@studio/contracts";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gte,
	inArray,
	lte,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drive, driveCandidate } from "../drives/schema.ts";
import { InterviewProblem } from "./problem.ts";
import {
	interviewAssessmentVersion,
	interviewEvent,
	interviewFeedbackReview,
	interviewProgress,
	interviewRound,
	interviewWithdrawal,
} from "./schema.ts";
import type { Database, Transaction } from "./store.ts";
import {
	type Candidacy,
	effectiveOutcome,
	openFeedbackReview,
	unresolved,
} from "./workflow.ts";

const pageSize = 15;
const driveSummary = { id: drive.id, title: drive.name };
const utcDate = (instant: SQLWrapper) =>
	sql<string>`to_char(${instant} at time zone 'UTC', 'YYYY-MM-DD')`;
const inCandidacy = (table: { driveId: SQLWrapper; candidateId: SQLWrapper }) =>
	and(
		eq(table.driveId, driveCandidate.driveId),
		eq(table.candidateId, driveCandidate.id),
	);

function reportRows(tx: Transaction) {
	const l1 = alias(interviewAssessmentVersion, "report_l1");
	const review = alias(interviewFeedbackReview, "report_review_activity");
	const attempt = alias(interviewRound, "report_scorecard_attempt");
	const active = alias(interviewRound, "report_unresolved_round");
	const schedulingChange = tx
		.select({ createdAt: interviewEvent.createdAt })
		.from(interviewEvent)
		.where(
			and(
				eq(interviewEvent.roundId, interviewRound.id),
				inArray(interviewEvent.action, [
					"reschedule",
					"reassign",
					"meeting",
					"replace_link",
				]),
			),
		)
		.orderBy(desc(interviewEvent.createdAt))
		.limit(1)
		.as("report_scheduling_change");
	const recentActivity = sql`greatest(${interviewRound.createdAt}, ${interviewRound.startedAt}, ${interviewRound.closedAt}, ${interviewRound.cancelledAt}, ${schedulingChange.createdAt})`;
	const recentAttempt = tx
		.select({
			round: interviewRound.level,
			activityAt: recentActivity.as("round_activity_at"),
		})
		.from(interviewRound)
		.leftJoinLateral(schedulingChange, sql`true`)
		.where(inCandidacy(interviewRound))
		.orderBy(desc(recentActivity), desc(interviewRound.id))
		.limit(1)
		.as("report_recent_attempt");
	const l2 = tx
		.select({
			decision: interviewAssessmentVersion.decision,
			submittedAt: interviewAssessmentVersion.submittedAt,
		})
		.from(interviewAssessmentVersion)
		.where(
			eq(
				interviewAssessmentVersion.roundId,
				interviewProgress.currentL2RoundId,
			),
		)
		.orderBy(desc(interviewAssessmentVersion.version))
		.limit(1)
		.as("report_l2");
	const reviewActivity = tx
		.select({
			activityAt:
				sql`max(greatest(${review.createdAt}, ${review.resolvedAt}))`.as(
					"review_activity_at",
				),
		})
		.from(review)
		.where(inCandidacy(review))
		.as("report_reviews");
	const outcome = effectiveOutcome(l1.decision, l2.decision);
	const activity = sql`greatest(${driveCandidate.createdAt}, ${recentAttempt.activityAt},
		${l1.submittedAt}, ${l2.submittedAt}, ${reviewActivity.activityAt}, ${interviewWithdrawal.createdAt})`;

	return tx
		.select({
			id: driveCandidate.id,
			driveId: driveCandidate.driveId,
			title: sql<string>`${drive.name}`.as("report_drive_title"),
			name: driveCandidate.name,
			round: sql<DirectorResult["round"]>`case
			when ${interviewWithdrawal.candidateId} is not null then ${recentAttempt.round}
			when ${interviewFeedbackReview.id} is not null then 'l2'::drive_round
			when ${active.level} is not null then ${active.level}
			when ${l1.decision} = 'pass' then 'l2'::drive_round
			else 'l1'::drive_round
		end`.as("report_round"),
			status: sql<DirectorResult["status"]>`case
			when ${outcome} is not null then ${outcome}
			when ${interviewFeedbackReview.id} is not null then 'pending_review'
			else 'in_progress'
		end`.as("report_status"),
			activityAt: activity.as("report_activity_at"),
			activityDate: utcDate(activity).as("report_activity_date"),
			hasScorecards: sql<boolean>`${exists(
				tx
					.select({ id: attempt.id })
					.from(attempt)
					.where(
						and(inCandidacy(attempt), eq(attempt.state, "feedback_submitted")),
					),
			)}`.as("report_has_scorecards"),
		})
		.from(driveCandidate)
		.innerJoin(drive, eq(drive.id, driveCandidate.driveId))
		.leftJoin(
			active,
			and(inCandidacy(active), inArray(active.state, unresolved)),
		)
		.leftJoin(interviewProgress, inCandidacy(interviewProgress))
		.leftJoin(l1, eq(l1.id, interviewProgress.l1VersionId))
		.leftJoinLateral(l2, sql`true`)
		.leftJoinLateral(recentAttempt, sql`true`)
		.leftJoinLateral(reviewActivity, sql`true`)
		.leftJoin(
			interviewFeedbackReview,
			and(inCandidacy(interviewFeedbackReview), openFeedbackReview),
		)
		.leftJoin(interviewWithdrawal, inCandidacy(interviewWithdrawal))
		.where(eq(driveCandidate.reviewState, "confirmed"))
		.as("director_results");
}

export function readDirectorReport(
	database: Database,
	query: DirectorReportQuery,
) {
	return database.transaction(
		async (tx) => {
			const result = reportRows(tx);
			const outcomeFilter = query.outcome
				? eq(result.status, query.outcome)
				: undefined;
			const filtered = and(
				query.driveId ? eq(result.driveId, query.driveId) : undefined,
				query.round ? eq(result.round, query.round) : undefined,
				outcomeFilter,
				query.from ? gte(result.activityDate, query.from) : undefined,
				query.to ? lte(result.activityDate, query.to) : undefined,
			);
			const countStatus = (status: DirectorResult["status"]) =>
				sql<number>`count(*) filter (where ${result.status} = ${status})`.mapWith(
					Number,
				);
			const groups = await tx
				.select({
					id: result.driveId,
					title: result.title,
					counts: {
						in_progress: countStatus("in_progress"),
						pending_review: countStatus("pending_review"),
						selected: countStatus("selected"),
						not_selected: countStatus("not_selected"),
						do_not_proceed: countStatus("do_not_proceed"),
						withdrawn: countStatus("withdrawn"),
					},
				})
				.from(result)
				.where(filtered)
				.groupBy(result.driveId, result.title)
				.orderBy(asc(result.title), asc(result.driveId));
			const totals = {
				in_progress: 0,
				pending_review: 0,
				selected: 0,
				not_selected: 0,
				do_not_proceed: 0,
				withdrawn: 0,
			};
			for (const { counts } of groups) {
				for (const status of Object.keys(totals) as Array<keyof typeof totals>)
					totals[status] += counts[status];
			}
			const rows = await tx
				.select({
					id: result.id,
					drive: { id: result.driveId, title: result.title },
					name: result.name,
					round: result.round,
					status: result.status,
					activityDate: result.activityDate,
					hasScorecards: result.hasScorecards,
				})
				.from(result)
				.where(filtered)
				.orderBy(desc(result.activityAt), asc(result.name), asc(result.id))
				.limit(pageSize)
				.offset((query.page - 1) * pageSize);
			const terminalDate = utcDate(
				sql`coalesce(${interviewRound.cancelledAt}, ${interviewRound.closedAt})`,
			);
			const [exceptions] = await tx
				.select({
					cancelled:
						sql<number>`count(*) filter (where ${interviewRound.state} = 'cancelled')`.mapWith(
							Number,
						),
					noShows:
						sql<number>`count(*) filter (where ${interviewRound.state} = 'no_show')`.mapWith(
							Number,
						),
				})
				.from(interviewRound)
				.innerJoin(driveCandidate, inCandidacy(interviewRound))
				.where(
					and(
						eq(driveCandidate.reviewState, "confirmed"),
						query.driveId
							? eq(interviewRound.driveId, query.driveId)
							: undefined,
						outcomeFilter
							? exists(
									tx
										.select({ id: result.id })
										.from(result)
										.where(
											and(
												eq(result.driveId, interviewRound.driveId),
												eq(result.id, interviewRound.candidateId),
												outcomeFilter,
											),
										),
								)
							: undefined,
						inArray(interviewRound.state, ["cancelled", "no_show"]),
						query.round ? eq(interviewRound.level, query.round) : undefined,
						query.from ? gte(terminalDate, query.from) : undefined,
						query.to ? lte(terminalDate, query.to) : undefined,
					),
				);
			const drives = await tx
				.select(driveSummary)
				.from(drive)
				.orderBy(asc(drive.name), asc(drive.id));
			return directorReportSchema.parse({
				drives,
				progress: groups.map(({ id, title, counts }) => ({
					drive: { id, title },
					counts,
				})),
				totals,
				...exceptions,
				page: query.page,
				pageSize,
				items: rows,
			});
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export function listDirectorScorecards(
	database: Database,
	scope: Candidacy,
	page: number,
) {
	return database.transaction(
		async (tx) => {
			const [candidate] = await tx
				.select({ id: driveCandidate.id })
				.from(driveCandidate)
				.where(
					and(
						eq(driveCandidate.id, scope.candidateId),
						eq(driveCandidate.driveId, scope.driveId),
					),
				);
			if (!candidate) throw new InterviewProblem(404, "not_found");
			const head = tx
				.select({
					id: interviewAssessmentVersion.id,
					decision: interviewAssessmentVersion.decision,
					submittedAt: interviewAssessmentVersion.submittedAt,
				})
				.from(interviewAssessmentVersion)
				.where(eq(interviewAssessmentVersion.roundId, interviewRound.id))
				.orderBy(desc(interviewAssessmentVersion.version))
				.limit(1)
				.as("reported_scorecard");
			const rows = await tx
				.select({
					roundId: interviewRound.id,
					round: interviewRound.level,
					attempt: interviewRound.attempt,
					versionId: head.id,
					decision: head.decision,
					submittedAt: head.submittedAt,
				})
				.from(interviewRound)
				.innerJoinLateral(head, sql`true`)
				.where(
					and(
						eq(interviewRound.driveId, scope.driveId),
						eq(interviewRound.candidateId, scope.candidateId),
						eq(interviewRound.state, "feedback_submitted"),
					),
				)
				.orderBy(
					asc(interviewRound.level),
					desc(interviewRound.attempt),
					asc(interviewRound.id),
				)
				.limit(pageSize + 1)
				.offset((page - 1) * pageSize);
			return directorScorecardsSchema.parse({
				page,
				hasNext: rows.length > pageSize,
				items: rows.slice(0, pageSize).map((row) => ({
					...row,
					submittedAt: row.submittedAt.toISOString(),
				})),
			});
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}
