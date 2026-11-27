import {
	type AssessmentScorecard,
	type AssignedInterview,
	candidateEmailSchema,
	type EligibleInterviewCandidate,
	type HrInterview,
	hrInterviewDashboardSchema,
	type InterviewListQuery,
	type InterviewWorkspaceItem,
	type InterviewWorkspaceQuery,
	interviewListSchema,
	interviewTimelineSchema,
	interviewWorkspaceSchema,
	type PanelistRoundGroup,
} from "@studio/contracts";
import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	not,
	or,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { drive, driveCandidate, driveSkills } from "../drives/schema.ts";
import { user } from "../staff/auth-schema.ts";
import { staffGrant } from "../staff/role-schema.ts";
import { isApprovedEmail } from "../staff/settings.ts";
import { InterviewProblem } from "./problem.ts";
import {
	interviewAssessment,
	interviewAssessmentVersion,
	interviewAttendance,
	interviewFeedbackReview,
	interviewInvitation,
	interviewProgress,
	interviewRound,
	interviewSession,
	interviewWithdrawal,
} from "./schema.ts";
import type { Database, RoundRow, Transaction } from "./store.ts";
import {
	entryLeadMs,
	entryOpensAt,
	presenceFresh,
	presenceTtlMs,
} from "./time.ts";

import {
	type Candidacy,
	criteriaView,
	effectiveOutcome,
	eligibleCandidacies,
	openFeedbackReview,
	readEligibleCandidacy,
	unresolved,
} from "./workflow.ts";
export const occupying = ["scheduled", "active"] as const;
const pageSize = 20;
const driveSummary = { id: drive.id, title: drive.name };
const panelistSummary = { id: user.id, name: user.name, email: user.email };

export function findPanelists(
	database: Database,
	domains: ReadonlySet<string>,
	search: string,
) {
	return database
		.select(panelistSummary)
		.from(user)
		.leftJoin(staffGrant, eq(user.id, staffGrant.userId))
		.where(
			and(
				eq(user.emailVerified, true),
				sql`coalesce(${staffGrant.role}, 'panelist') = 'panelist'`,
				inArray(sql<string>`split_part(${user.email}, '@', 2)`, [...domains]),
				searchFields(search, user.name, user.email),
			),
		)
		.orderBy(user.name, user.id)
		.limit(40);
}

function searchFields(search: string, name: SQLWrapper, email: SQLWrapper) {
	if (!search) return undefined;
	return sql`(strpos(lower(${name}), lower(${search})) > 0 or strpos(lower(${email}), lower(${search})) > 0)`;
}

function scopeFilters(
	query: Pick<InterviewListQuery, "driveId" | "minYears" | "maxYears">,
	driveId: SQLWrapper,
	experience: SQLWrapper,
) {
	return [
		query.driveId ? eq(driveId, query.driveId) : undefined,
		query.minYears === undefined
			? undefined
			: gte(experience, Math.round(query.minYears * 10)),
		query.maxYears === undefined
			? undefined
			: lte(experience, Math.round(query.maxYears * 10)),
	];
}

export function listInterviews(
	database: Database,
	query: InterviewListQuery,
	now: Date,
	domains: ReadonlySet<string>,
) {
	return database.transaction(
		(tx) => readInterviewPage(tx, query, now, domains),
		{
			isolationLevel: "repeatable read",
			accessMode: "read only",
		},
	);
}

function eligibleView({
	candidate,
	drive,
	criteria,
	level,
	lastAttempt,
	workflowRevision,
	qualifyingL1RoundId,
}: Awaited<
	ReturnType<typeof readEligibleCandidacy>
>): EligibleInterviewCandidate {
	return {
		id: candidate.id,
		drive,
		name: candidate.name,
		email: candidateEmailSchema.parse(candidate.email),
		years: years(candidate.experienceTenths),
		revision: candidate.revision,
		level,
		criteria: criteriaView(level, criteria),
		qualifyingL1RoundId,
		lastAttempt,
		workflowRevision,
	};
}

export function getBookingEligibility(database: Database, scope: Candidacy) {
	return database.transaction(
		async (tx) => eligibleView(await readEligibleCandidacy(tx, scope)),
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

function workspaceRows(
	tx: Transaction,
	now: Date,
	domains: ReadonlySet<string>,
) {
	const bookable = eligibleCandidacies(tx).as("bookable");
	const l1 = alias(interviewAssessmentVersion, "workspace_l1");
	const attempt = alias(interviewRound, "workspace_attempt");
	const l2 = tx
		.select({
			decision: interviewAssessmentVersion.decision,
			date: interviewAssessmentVersion.submittedAt,
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
		.as("workspace_l2");
	const candidateScope = (table: {
		driveId: SQLWrapper;
		candidateId: SQLWrapper;
	}) =>
		and(
			eq(table.driveId, driveCandidate.driveId),
			eq(table.candidateId, driveCandidate.id),
		);
	const outcome = effectiveOutcome(l1.decision, l2.decision);
	const level = sql<InterviewWorkspaceItem["level"]>`coalesce(
		${interviewRound.level}, ${bookable.level},
		case when ${outcome} in ('selected', 'not_selected') then 'l2'::drive_round
			when ${outcome} = 'do_not_proceed' then 'l1'::drive_round
			when ${interviewFeedbackReview.id} is not null then 'l2'::drive_round end)`;
	const email = sql<string>`lower(btrim(${user.email}))`;
	const panelistUnavailable = sql`(${user.emailVerified} is not true or coalesce(${staffGrant.role}, 'panelist') <> 'panelist'
		or length(${email}) > 254 or ${email} !~ ${z.regexes.email.source}
		or not ${inArray(sql<string>`split_part(${email}, '@', 2)`, [...domains])})`;
	const skillsMissing = sql`(${driveSkills.reviewedAt} is null or jsonb_array_length(${driveSkills.skills}) = 0)`;
	const action = sql<InterviewWorkspaceItem["action"]>`case
		when ${interviewWithdrawal.candidateId} is not null then null
		when ${interviewFeedbackReview.id} is not null then 'review_feedback'
		when ${interviewRound.state} = 'awaiting_feedback' and ${panelistUnavailable} then 'replace_panelist'
		when ${interviewRound.state} = 'awaiting_feedback' and ${interviewRound.legacyAssessment}
			and ${interviewAssessment.roundId} is null and ${skillsMissing} then 'review_skills'
		when ${interviewRound.state} = 'scheduled' and ${interviewRound.end} <= ${now.toISOString()}::timestamptz then 'review_attendance'
		when ${bookable.scopeCandidateId} is not null then case when ${skillsMissing} then 'review_skills' else 'schedule' end
	end`;
	const classified = tx
		.select({
			id: driveCandidate.id,
			driveId: driveCandidate.driveId,
			driveTitle: sql<string>`${drive.name}`.as("workspace_drive_title"),
			name: driveCandidate.name,
			email: driveCandidate.email,
			experience: driveCandidate.experienceTenths,
			level: level.as("workspace_level"),
			l1RoundId: sql<
				string | null
			>`coalesce(${interviewRound.qualifyingL1RoundId}, ${l1.roundId})`.as(
				"workspace_l1_round",
			),
			hasAttempts:
				sql<boolean>`${exists(tx.select({ id: attempt.id }).from(attempt).where(candidateScope(attempt)))}`.as(
					"workspace_has_attempts",
				),
			roundId: sql<string | null>`${interviewRound.id}`.as("workspace_round"),
			reviewId: sql<string | null>`${interviewFeedbackReview.id}`.as(
				"workspace_review",
			),
			outcome: outcome.as("workspace_outcome"),
			action: action.as("workspace_action"),
			state: interviewRound.state,
			start: interviewRound.start,
			closedAt: interviewRound.closedAt,
			lastUpdate:
				sql`greatest(${interviewWithdrawal.createdAt}, ${l1.submittedAt}, ${l2.date})`.as(
					"workspace_last_update",
				),
		})
		.from(driveCandidate)
		.innerJoin(drive, eq(drive.id, driveCandidate.driveId))
		.leftJoin(bookable, eq(bookable.scopeCandidateId, driveCandidate.id))
		.leftJoin(
			interviewRound,
			and(
				candidateScope(interviewRound),
				inArray(interviewRound.state, unresolved),
			),
		)
		.leftJoin(interviewProgress, candidateScope(interviewProgress))
		.leftJoin(l1, eq(l1.id, interviewProgress.l1VersionId))
		.leftJoinLateral(l2, sql`true`)
		.leftJoin(user, eq(user.id, interviewRound.panelistId))
		.leftJoin(staffGrant, eq(staffGrant.userId, user.id))
		.leftJoin(
			interviewAssessment,
			eq(interviewAssessment.roundId, interviewRound.id),
		)
		.leftJoin(interviewWithdrawal, candidateScope(interviewWithdrawal))
		.leftJoin(
			interviewFeedbackReview,
			and(candidateScope(interviewFeedbackReview), openFeedbackReview),
		)
		.leftJoin(
			driveSkills,
			and(
				eq(driveSkills.driveId, driveCandidate.driveId),
				eq(driveSkills.round, level),
			),
		)
		.where(eq(driveCandidate.reviewState, "confirmed"))
		.as("classified_interviews");
	return tx
		.select({
			id: classified.id,
			driveId: classified.driveId,
			driveTitle: classified.driveTitle,
			name: classified.name,
			email: classified.email,
			experience: classified.experience,
			level: classified.level,
			l1RoundId: classified.l1RoundId,
			hasAttempts: classified.hasAttempts,
			roundId: classified.roundId,
			reviewId: classified.reviewId,
			outcome: classified.outcome,
			action: classified.action,
			state: classified.state,
			start: classified.start,
			closedAt: classified.closedAt,
			lastUpdate: classified.lastUpdate,
			tab: sql<InterviewWorkspaceQuery["tab"] | null>`case
			when ${classified.action} is not null then 'queue'
			when ${classified.outcome} is not null then 'history'
			when ${classified.state} in ('scheduled', 'active') then 'scheduled'
			when ${classified.state} = 'awaiting_feedback' then 'awaiting'
		end`.as("workspace_tab"),
		})
		.from(classified)
		.as("interview_workspace");
}

type WorkspaceProjection = Omit<
	InterviewWorkspaceItem,
	"drive" | "years" | "round" | "eligible"
> & {
	driveId: string;
	driveTitle: string;
	experience: number | null;
	roundId: string | null;
};

function workspaceOrdering(item: ReturnType<typeof workspaceRows>) {
	return [
		sql`case
			when ${item.tab} = 'queue' then case ${item.action}
				when 'review_feedback' then 0 when 'replace_panelist' then 1
				when 'review_attendance' then 2 when 'review_skills' then 3 else 4 end
			when ${item.tab} = 'scheduled' and ${item.state} <> 'active' then 1
			else 0 end`,
		asc(sql`case ${item.tab}
			when 'scheduled' then ${item.start}
			when 'awaiting' then ${item.closedAt} end`),
		sql`case when ${item.tab} = 'history' then ${item.lastUpdate} end desc nulls last`,
		asc(item.name),
		asc(item.id),
	];
}

async function hydrateWorkspace(
	tx: Transaction,
	rows: WorkspaceProjection[],
	now: Date,
	domains: ReadonlySet<string>,
): Promise<InterviewWorkspaceItem[]> {
	const roundIds = rows.flatMap((row) => (row.roundId ? [row.roundId] : []));
	const bookingIds = rows
		.filter(
			(row) =>
				row.action === "schedule" ||
				(row.action === "review_skills" && !row.roundId),
		)
		.map((row) => row.id);
	const rounds = roundIds.length
		? await hrRows(tx).where(inArray(interviewRound.id, roundIds))
		: [];
	const bookings = bookingIds.length
		? await eligibleCandidacies(tx, inArray(driveCandidate.id, bookingIds))
		: [];
	const roundById = new Map(
		rounds.map((row) => [row.round.id, hrView(row, now, domains)]),
	);
	const bookingById = new Map(
		bookings.map((row) => [row.candidate.id, eligibleView(row)]),
	);
	return rows.map((row) => ({
		...row,
		drive: { id: row.driveId, title: row.driveTitle },
		years: years(row.experience),
		round: row.roundId ? (roundById.get(row.roundId) ?? null) : null,
		eligible: bookingById.get(row.id) ?? null,
	}));
}

export function readHrInterviewDashboard(
	database: Database,
	now: Date,
	domains: ReadonlySet<string>,
) {
	return database.transaction(
		async (tx) => {
			const workspace = workspaceRows(tx, now, domains);
			const ordering = workspaceOrdering(workspace);
			const ranked = tx
				.select({
					id: workspace.id,
					driveId: workspace.driveId,
					driveTitle: workspace.driveTitle,
					name: workspace.name,
					email: workspace.email,
					experience: workspace.experience,
					level: workspace.level,
					l1RoundId: workspace.l1RoundId,
					hasAttempts: workspace.hasAttempts,
					roundId: workspace.roundId,
					reviewId: workspace.reviewId,
					outcome: workspace.outcome,
					action: workspace.action,
					tab: workspace.tab,
					total: sql<number>`count(*) over (partition by ${workspace.tab})`
						.mapWith(Number)
						.as("dashboard_total"),
					rank: sql<number>`row_number() over (partition by ${workspace.tab} order by ${sql.join(ordering, sql`, `)})`.as(
						"dashboard_rank",
					),
				})
				.from(workspace)
				.where(isNotNull(workspace.tab))
				.as("ranked_dashboard_workspace");
			const rows = await tx
				.select()
				.from(ranked)
				.where(lte(ranked.rank, 3))
				.orderBy(asc(ranked.rank));
			const items = await hydrateWorkspace(tx, rows, now, domains);
			const dashboard: z.infer<typeof hrInterviewDashboardSchema> = {
				queue: { total: 0, items: [] },
				scheduled: { total: 0, items: [] },
				awaiting: { total: 0, items: [] },
				history: { total: 0, items: [] },
			};
			for (const [index, item] of items.entries()) {
				const { tab, total } = rows[index];
				if (!tab) continue;
				dashboard[tab].total = total;
				dashboard[tab].items.push(item);
			}
			return hrInterviewDashboardSchema.parse(dashboard);
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export function listInterviewWorkspace(
	database: Database,
	query: InterviewWorkspaceQuery,
	now: Date,
	domains: ReadonlySet<string>,
) {
	return database.transaction(
		async (tx) => {
			const item = workspaceRows(tx, now, domains);
			const matchesLevel =
				query.level &&
				(query.tab === "history"
					? exists(
							tx
								.select({ id: interviewRound.id })
								.from(interviewRound)
								.where(
									and(
										eq(interviewRound.candidateId, item.id),
										eq(interviewRound.driveId, item.driveId),
										eq(interviewRound.level, query.level),
									),
								),
						)
					: eq(item.level, query.level));
			const where = and(
				eq(item.tab, query.tab),
				...scopeFilters(query, item.driveId, item.experience),
				searchFields(query.search, item.name, item.email),
				matchesLevel,
			);
			const [counts] = await tx
				.select({
					total: sql<number>`count(*) filter (where ${where})`.mapWith(Number),
					actionTotal:
						sql<number>`count(*) filter (where ${item.tab} = 'queue')`.mapWith(
							Number,
						),
				})
				.from(item);
			const rows = await tx
				.select()
				.from(item)
				.where(where)
				.orderBy(...workspaceOrdering(item))
				.limit(pageSize)
				.offset((query.page - 1) * pageSize);
			const drives = await tx
				.select(driveSummary)
				.from(drive)
				.orderBy(drive.name, drive.id);
			return interviewWorkspaceSchema.parse({
				...counts,
				drives,
				tab: query.tab,
				page: query.page,
				pageSize,
				items: await hydrateWorkspace(tx, rows, now, domains),
			});
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export function listInterviewTimeline(
	database: Database,
	scope: Candidacy,
	page: number,
	now: Date,
	domains: ReadonlySet<string>,
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
			const [withdrawal] = await tx
				.select({
					reason: interviewWithdrawal.reason,
					at: interviewWithdrawal.createdAt,
				})
				.from(interviewWithdrawal)
				.where(
					and(
						eq(interviewWithdrawal.candidateId, scope.candidateId),
						eq(interviewWithdrawal.driveId, scope.driveId),
					),
				);
			const rounds = await hrRows(tx)
				.where(
					and(
						eq(interviewRound.driveId, scope.driveId),
						eq(interviewRound.candidateId, scope.candidateId),
					),
				)
				.orderBy(
					asc(interviewRound.level),
					asc(interviewRound.attempt),
					asc(interviewRound.id),
				)
				.limit(pageSize + 1)
				.offset((page - 1) * pageSize);
			return interviewTimelineSchema.parse({
				page,
				hasNext: rounds.length > pageSize,
				withdrawal: withdrawal
					? { reason: withdrawal.reason, at: withdrawal.at.toISOString() }
					: null,
				items: rounds
					.slice(0, pageSize)
					.map((row) => hrView(row, now, domains)),
			});
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

async function readInterviewPage(
	database: Transaction,
	query: InterviewListQuery,
	now: Date,
	domains: ReadonlySet<string>,
) {
	const drives = await database
		.select(driveSummary)
		.from(drive)
		.orderBy(drive.name, drive.id);
	const pagination = { drives, pageSize, page: query.page, tab: query.tab };
	const offset = (query.page - 1) * pageSize;
	if (query.tab === "queue") {
		const where = and(
			...scopeFilters(
				query,
				driveCandidate.driveId,
				driveCandidate.experienceTenths,
			),
			searchFields(query.search, driveCandidate.name, driveCandidate.email),
		);
		const eligible = eligibleCandidacies(database, where, query.level);
		const [total] = await database
			.select({ total: count() })
			.from(eligible.as("eligible_candidates"));
		const rows = await eligible
			.orderBy(asc(sql`lower(${driveCandidate.name})`), driveCandidate.id)
			.limit(pageSize)
			.offset(offset);
		const items = rows.map(eligibleView);
		return interviewListSchema.parse({
			...pagination,
			total: total.total,
			items,
		});
	}

	const where = and(
		inArray(
			interviewRound.state,
			query.tab === "scheduled"
				? occupying
				: [
						"awaiting_feedback",
						"feedback_submitted",
						"cancelled",
						"no_show",
						"withdrawn",
					],
		),
		query.level ? eq(interviewRound.level, query.level) : undefined,
		...scopeFilters(
			query,
			interviewRound.driveId,
			interviewRound.experienceTenths,
		),
		searchFields(
			query.search,
			interviewRound.candidateName,
			interviewRound.invitedEmail,
		),
	);
	const [total] = await database
		.select({ total: count() })
		.from(interviewRound)
		.where(where);
	const rows = await hrRows(database)
		.where(where)
		.orderBy(
			...(query.tab === "scheduled"
				? scheduledOrder(now)
				: [desc(interviewRound.closedAt)]),
			interviewRound.id,
		)
		.limit(pageSize)
		.offset(offset);
	return interviewListSchema.parse({
		...pagination,
		total: total.total,
		items: rows.map((row) => hrView(row, now, domains)),
	});
}

export const years = (tenths: number | null) =>
	tenths === null ? null : tenths / 10;
export const iso = (time: Date | null | undefined) =>
	time?.toISOString() ?? null;

export function roundCore(round: RoundRow) {
	return {
		id: round.id,
		level: round.level,
		attempt: round.attempt,
		start: round.start.toISOString(),
		end: round.end.toISOString(),
		timeZone: round.timeZone,
		duration: round.duration,
		meeting: round.meeting,
		revision: round.revision,
		state: round.state,
		candidate: {
			name: round.candidateName,
			years: years(round.experienceTenths),
		},
		startedAt: iso(round.startedAt),
		closedAt: iso(round.closedAt),
	};
}

const firstSubmissionAt = sql<Date | null>`(
	select ${interviewAssessmentVersion.submittedAt}
	from ${interviewAssessmentVersion}
	where ${interviewAssessmentVersion.roundId} = ${interviewRound.id}
		and ${interviewAssessmentVersion.version} = 1
)`.mapWith(interviewAssessmentVersion.submittedAt);

function assignedRows(
	database: Database | Transaction,
	dashboardGroup?: PanelistRoundGroup,
) {
	return database
		.select({
			round: interviewRound,
			drive: driveSummary,
			attendance: interviewAttendance,
			presence: interviewSession.lastSeenAt,
			submittedAt:
				dashboardGroup === "submitted" ? firstSubmissionAt : sql<null>`null`,
			total: dashboardGroup
				? sql<number>`count(*) over ()`.mapWith(Number)
				: sql<number>`0`,
		})
		.from(interviewRound)
		.innerJoin(drive, eq(drive.id, interviewRound.driveId))
		.leftJoin(
			interviewAttendance,
			eq(interviewAttendance.roundId, interviewRound.id),
		)
		.leftJoin(
			interviewSession,
			and(
				eq(interviewSession.roundId, interviewRound.id),
				isNull(interviewSession.revokedAt),
			),
		);
}

type AssignedRow = Awaited<ReturnType<typeof assignedRows>>[number];

function assignedView(
	{
		round,
		drive,
		attendance,
		presence,
	}: Pick<AssignedRow, "round" | "drive" | "attendance" | "presence">,
	now: Date,
): AssignedInterview {
	const core = roundCore(round);
	return {
		...core,
		candidate: attendance
			? { name: attendance.name, years: years(attendance.experienceTenths) }
			: core.candidate,
		drive,
		attendance: {
			confirmedAt: iso(attendance?.confirmedAt),
			lastSeenAt: iso(attendance?.lastSeenAt),
			connected:
				(round.state === "active" ||
					(round.state === "scheduled" &&
						now >= entryOpensAt(round.start) &&
						now < round.end)) &&
				presenceFresh(presence, now),
		},
	};
}

function hrRows(database: Database | Transaction) {
	const newer = alias(interviewRound, "newer_round");
	const l1 = alias(interviewAssessmentVersion, "controlling_l1");
	const l2 = sql`(select ${interviewAssessmentVersion.decision} from ${interviewAssessmentVersion}
		where ${interviewAssessmentVersion.roundId} = ${interviewProgress.currentL2RoundId}
		order by ${interviewAssessmentVersion.version} desc limit 1)`;
	return database
		.select({
			round: interviewRound,
			drive: driveSummary,
			panelist: panelistSummary,
			panelistVerified: user.emailVerified,
			panelistRole: staffGrant.role,
			pendingReviewId: interviewFeedbackReview.id,
			reviewAffectsRound: sql<boolean>`coalesce(${interviewRound.id} in (${interviewFeedbackReview.l1RoundId}, ${interviewFeedbackReview.affectedL2RoundId}), false)`,
			currentL2RoundId: interviewProgress.currentL2RoundId,
			effectiveOutcome: effectiveOutcome(l1.decision, l2),
			superseded: sql<boolean>`${exists(
				database
					.select({ id: newer.id })
					.from(newer)
					.where(
						and(
							eq(newer.driveId, interviewRound.driveId),
							eq(newer.candidateId, interviewRound.candidateId),
							eq(newer.level, interviewRound.level),
							gt(newer.attempt, interviewRound.attempt),
						),
					),
			)}`,
			decision: sql<AssessmentScorecard["decision"] | null>`(
				select ${interviewAssessmentVersion.decision} from ${interviewAssessmentVersion}
				where ${interviewAssessmentVersion.roundId} = ${interviewRound.id}
				order by ${interviewAssessmentVersion.version} desc limit 1
			)`,
			attendance: interviewAttendance,
			presence: interviewSession.lastSeenAt,
		})
		.from(interviewRound)
		.innerJoin(drive, eq(drive.id, interviewRound.driveId))
		.innerJoin(user, eq(user.id, interviewRound.panelistId))
		.leftJoin(staffGrant, eq(staffGrant.userId, user.id))
		.leftJoin(
			interviewProgress,
			and(
				eq(interviewProgress.driveId, interviewRound.driveId),
				eq(interviewProgress.candidateId, interviewRound.candidateId),
			),
		)
		.leftJoin(l1, eq(l1.id, interviewProgress.l1VersionId))
		.leftJoin(
			interviewFeedbackReview,
			and(
				openFeedbackReview,
				eq(interviewFeedbackReview.driveId, interviewRound.driveId),
				eq(interviewFeedbackReview.candidateId, interviewRound.candidateId),
			),
		)
		.leftJoin(
			interviewWithdrawal,
			and(
				eq(interviewWithdrawal.driveId, interviewRound.driveId),
				eq(interviewWithdrawal.candidateId, interviewRound.candidateId),
			),
		)
		.leftJoin(
			interviewAttendance,
			eq(interviewAttendance.roundId, interviewRound.id),
		)
		.leftJoin(
			interviewSession,
			and(
				eq(interviewSession.roundId, interviewRound.id),
				isNull(interviewSession.revokedAt),
			),
		);
}

function hrView(
	row: Awaited<ReturnType<typeof hrRows>>[number],
	now: Date,
	domains: ReadonlySet<string>,
): HrInterview {
	return {
		...assignedView(row, now),
		candidate: {
			id: row.round.candidateId,
			name: row.round.candidateName,
			email: row.round.invitedEmail,
			years: years(row.round.experienceTenths),
		},
		panelist: row.panelist,
		qualifyingL1RoundId: row.round.qualifyingL1RoundId,
		canMarkNoShow: row.round.state === "scheduled" && now >= row.round.end,
		canCancelUnavailablePanelist:
			!row.pendingReviewId &&
			row.round.state === "awaiting_feedback" &&
			!row.decision &&
			(!row.panelistVerified ||
				(row.panelistRole !== null && row.panelistRole !== "panelist") ||
				!isApprovedEmail(row.panelist.email, domains)),
		decision: row.decision,
		effectiveOutcome: row.effectiveOutcome,
		pendingReviewId: row.pendingReviewId,
		reviewAffectsRound: row.reviewAffectsRound,
		superseded:
			Boolean(row.decision) &&
			(row.superseded ||
				(row.round.level === "l2" && row.currentL2RoundId !== row.round.id)),
		reason:
			row.round.reason ??
			(row.round.cancellationCode === "l1_pass_reversed"
				? "The L1 pass was reversed."
				: null),
		absent: row.round.absent,
		confirmedProfile: row.attendance && {
			name: row.attendance.name,
			years: years(row.attendance.experienceTenths),
		},
	};
}

export async function getHrRound(
	database: Database | Transaction,
	id: string,
	now: Date,
	domains: ReadonlySet<string>,
) {
	const [row] = await hrRows(database).where(eq(interviewRound.id, id));
	if (!row) throw new InterviewProblem(404, "not_found");
	return hrView(row, now, domains);
}

export async function getAssignedRound(
	database: Database | Transaction,
	id: string,
	panelistId: string,
	now: Date,
) {
	const [row] = await assignedRows(database).where(
		and(eq(interviewRound.id, id), eq(interviewRound.panelistId, panelistId)),
	);
	if (!row) throw new InterviewProblem(404, "not_found");
	return assignedView(row, now);
}

function scheduledOrder(now: Date) {
	const scheduled = eq(interviewRound.state, "scheduled");
	const upcoming = sql`${scheduled} and ${interviewRound.end} > ${now.toISOString()}::timestamptz`;
	return [
		sql`case when ${interviewRound.state} = 'active' then 0 when ${upcoming} then 1 when ${scheduled} then 2 else 3 end`,
		sql`case when ${upcoming} then ${interviewRound.start} end asc`,
		desc(
			sql`case when ${scheduled} then ${interviewRound.start} else ${interviewRound.closedAt} end`,
		),
	];
}

function panelistGroup(now: Date, group: PanelistRoundGroup) {
	const active = eq(interviewRound.state, "active");
	const awaiting = eq(interviewRound.state, "awaiting_feedback");
	const scheduled = and(
		eq(interviewRound.state, "scheduled"),
		gt(interviewRound.end, now),
	);
	const waiting = sql`(${and(
		scheduled,
		lte(interviewRound.start, new Date(now.getTime() + entryLeadMs)),
		gte(interviewSession.lastSeenAt, new Date(now.getTime() - presenceTtlMs)),
	)}) is true`;
	switch (group) {
		case "attention":
			return {
				where: or(active, waiting, awaiting),
				order: [
					sql`case when ${active} then 0 when ${waiting} then 1 else 2 end`,
					asc(
						sql`case when ${awaiting} then coalesce(${interviewRound.closedAt}, ${interviewRound.start}) else ${interviewRound.start} end`,
					),
				],
			};
		case "upcoming":
			return {
				where: and(scheduled, not(waiting)),
				order: [asc(interviewRound.start)],
			};
		case "submitted":
			return {
				where: eq(interviewRound.state, "feedback_submitted"),
				order: [
					desc(
						sql`coalesce(${firstSubmissionAt}, ${interviewRound.closedAt}, ${interviewRound.start})`,
					),
				],
			};
	}
}

export function getPanelistDashboard(
	database: Database,
	panelistId: string,
	now: Date,
) {
	return database.transaction(
		async (tx) => {
			async function preview(group: PanelistRoundGroup) {
				const { where, order } = panelistGroup(now, group);
				const rows = await assignedRows(tx, group)
					.where(and(eq(interviewRound.panelistId, panelistId), where))
					.orderBy(...order, interviewRound.id)
					.limit(3);
				return {
					total: rows[0]?.total ?? 0,
					items: rows.map((row) => {
						const round = assignedView(row, now);
						return {
							...round,
							connected: round.attendance.connected,
							submittedAt: iso(row.submittedAt),
						};
					}),
				};
			}
			return {
				attention: await preview("attention"),
				upcoming: await preview("upcoming"),
				submitted: await preview("submitted"),
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export async function listAssignedRounds(
	database: Database,
	panelistId: string,
	now: Date,
	page: number,
	group?: PanelistRoundGroup,
) {
	const panelistPageSize = 25;
	const filter = group ? panelistGroup(now, group) : undefined;
	const rows = await assignedRows(database)
		.where(and(eq(interviewRound.panelistId, panelistId), filter?.where))
		.orderBy(...(filter?.order ?? scheduledOrder(now)), interviewRound.id)
		.limit(panelistPageSize + 1)
		.offset((page - 1) * panelistPageSize);
	return {
		page,
		hasNext: rows.length > panelistPageSize,
		items: rows.slice(0, panelistPageSize).map((row) => assignedView(row, now)),
	};
}

export async function resolveStaffInvite(
	database: Database,
	invitationId: string,
	panelistId: string,
) {
	const [row] = await database
		.select({ id: interviewRound.id })
		.from(interviewInvitation)
		.innerJoin(
			interviewRound,
			eq(interviewInvitation.roundId, interviewRound.id),
		)
		.where(
			and(
				eq(interviewInvitation.id, invitationId),
				isNull(interviewInvitation.revokedAt),
				eq(interviewRound.panelistId, panelistId),
				inArray(interviewRound.state, occupying),
			),
		);
	if (!row) throw new InterviewProblem(404, "not_found");
	return row;
}
