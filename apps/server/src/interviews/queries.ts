import {
	type AssignedInterview,
	candidateEmailSchema,
	type HrInterview,
	type InterviewListQuery,
	type InterviewPanelist,
	interviewListSchema,
} from "@studio/contracts";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lte,
	notExists,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { drive, driveCandidate } from "../drives/schema.ts";
import { user } from "../staff/auth-schema.ts";
import { staffGrant } from "../staff/role-schema.ts";
import { InterviewProblem } from "./problem.ts";
import {
	interviewAttendance,
	interviewInvitation,
	interviewRound,
	interviewSession,
	interviewWithdrawal,
} from "./schema.ts";
import type { Database, RoundRow, Transaction } from "./store.ts";
import { entryOpensAt, presenceFresh } from "./time.ts";

export const unresolved = ["scheduled", "active", "awaiting_feedback"] as const;
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
	query: InterviewListQuery,
	driveId: typeof driveCandidate.driveId | typeof interviewRound.driveId,
	experience:
		| typeof driveCandidate.experienceTenths
		| typeof interviewRound.experienceTenths,
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

function eligibleWhere(database: Transaction, query: InterviewListQuery) {
	const sameWithdrawal = and(
		eq(interviewWithdrawal.driveId, driveCandidate.driveId),
		eq(interviewWithdrawal.candidateId, driveCandidate.id),
	);
	const sameRound = and(
		eq(interviewRound.driveId, driveCandidate.driveId),
		eq(interviewRound.candidateId, driveCandidate.id),
	);
	return and(
		eq(driveCandidate.reviewState, "confirmed"),
		sql`length(btrim(${driveCandidate.name})) between 1 and 120 and ${driveCandidate.name} !~ '[[:cntrl:]]'`,
		sql`length(${driveCandidate.email}) <= 254 and ${driveCandidate.email} ~ ${z.regexes.email.source}`,
		notExists(
			database
				.select({ id: interviewWithdrawal.candidateId })
				.from(interviewWithdrawal)
				.where(sameWithdrawal),
		),
		notExists(
			database
				.select({ id: interviewRound.id })
				.from(interviewRound)
				.where(
					and(
						sameRound,
						eq(interviewRound.level, "l1"),
						inArray(interviewRound.state, unresolved),
					),
				),
		),
		...scopeFilters(
			query,
			driveCandidate.driveId,
			driveCandidate.experienceTenths,
		),
		searchFields(query.search, driveCandidate.name, driveCandidate.email),
	);
}

export function listInterviews(
	database: Database,
	query: InterviewListQuery,
	now: Date,
) {
	return database.transaction((tx) => readInterviewPage(tx, query, now), {
		isolationLevel: "repeatable read",
		accessMode: "read only",
	});
}

async function readInterviewPage(
	database: Transaction,
	query: InterviewListQuery,
	now: Date,
) {
	const drives = await database
		.select(driveSummary)
		.from(drive)
		.orderBy(drive.name, drive.id);
	const pagination = { drives, pageSize, page: query.page, tab: query.tab };
	const offset = (query.page - 1) * pageSize;
	if (query.tab === "queue") {
		const where = eligibleWhere(database, query);
		const [total] = await database
			.select({ total: count() })
			.from(driveCandidate)
			.where(where);
		const rows = await database
			.select({ candidate: driveCandidate, drive: driveSummary })
			.from(driveCandidate)
			.innerJoin(drive, eq(drive.id, driveCandidate.driveId))
			.where(where)
			.orderBy(asc(sql`lower(${driveCandidate.name})`), driveCandidate.id)
			.limit(pageSize)
			.offset(offset);
		const items = rows.map(({ candidate, drive }) => ({
			id: candidate.id,
			drive,
			name: candidate.name,
			email: candidateEmailSchema.parse(candidate.email),
			years: years(candidate.experienceTenths),
			revision: candidate.revision,
		}));
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
				: ["awaiting_feedback", "cancelled", "no_show", "withdrawn"],
		),
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
		items: rows.map((row) => hrView(row, now)),
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

function assignedRows(database: Database | Transaction) {
	return database
		.select({
			round: interviewRound,
			drive: driveSummary,
			attendance: interviewAttendance,
			presence: interviewSession.lastSeenAt,
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
	{ round, drive, attendance, presence }: AssignedRow,
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
	return database
		.select({
			round: interviewRound,
			drive: driveSummary,
			panelist: panelistSummary,
			attendance: interviewAttendance,
			presence: interviewSession.lastSeenAt,
		})
		.from(interviewRound)
		.innerJoin(drive, eq(drive.id, interviewRound.driveId))
		.innerJoin(user, eq(user.id, interviewRound.panelistId))
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
	row: AssignedRow & { panelist: InterviewPanelist },
	now: Date,
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
		canMarkNoShow: row.round.state === "scheduled" && now >= row.round.end,
		reason: row.round.reason,
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
) {
	const [row] = await hrRows(database).where(eq(interviewRound.id, id));
	if (!row) throw new InterviewProblem(404, "not_found");
	return hrView(row, now);
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

export async function listAssignedRounds(
	database: Database,
	panelistId: string,
	now: Date,
	page: number,
) {
	const panelistPageSize = 25;
	const rows = await assignedRows(database)
		.where(eq(interviewRound.panelistId, panelistId))
		.orderBy(...scheduledOrder(now), interviewRound.id)
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
