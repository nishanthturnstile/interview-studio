import type {
	Candidate,
	CandidateSummary,
	DocumentStatus,
	DriveOverview,
	JobDescription,
	ReviewQueueStatus,
	reviewQueueSchema,
	SkillSet,
} from "@studio/contracts";
import { and, desc, eq, inArray, or, type SQLWrapper, sql } from "drizzle-orm";
import type { z } from "zod";
import type { db } from "../database.ts";
import { DriveProblem } from "./errors.ts";
import { drive, driveCandidate, driveDocument, driveSkills } from "./schema.ts";

export type Database = typeof db;
export const driveColumns = {
	id: drive.id,
	name: drive.name,
	createdAt: drive.createdAt,
	counts: sql<DriveOverview["counts"]>`(
		select jsonb_build_object(
			'resumes', count(*)::int,
			'drafts', count(*) filter (where review_state = 'draft')::int,
			'confirmed', count(*) filter (where review_state = 'confirmed')::int,
			'duplicates', count(*) filter (where review_state = 'duplicate')::int
		)
		from ${driveCandidate}
		where drive_id = ${drive}.${sql.identifier(drive.id.name)}
	)`,
};

export const skillColumns = {
	driveId: driveSkills.driveId,
	round: driveSkills.round,
	skills: driveSkills.skills,
	revision: driveSkills.revision,
	reviewedAt: driveSkills.reviewedAt,
};

export function skillSet(
	row: Pick<
		typeof driveSkills.$inferSelect,
		"round" | "skills" | "revision" | "reviewedAt"
	>,
): SkillSet {
	return {
		round: row.round,
		skills: row.skills,
		revision: row.revision,
		reviewedAt: row.reviewedAt?.toISOString() ?? null,
	};
}

export function overview(
	row: {
		id: string;
		name: string;
		createdAt: Date;
		counts: DriveOverview["counts"];
	},
	skills: SkillSet[],
): DriveOverview {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.createdAt.toISOString(),
		counts: row.counts,
		skills,
	};
}

export async function requireDrive(database: Database, id: string) {
	const [row] = await database
		.select({ activeJdId: drive.activeJdId, jdRevision: drive.jdRevision })
		.from(drive)
		.where(eq(drive.id, id));
	if (!row) throw new DriveProblem(404, "not_found");
	return row;
}

export async function getJobDescription(
	database: Pick<Database, "select">,
	id: string,
): Promise<JobDescription> {
	const [row] = await database
		.select({
			jdRevision: drive.jdRevision,
			activeJdId: drive.activeJdId,
			editedText: drive.jdText,
			extractedText: driveDocument.extractedText,
		})
		.from(drive)
		.leftJoin(
			driveDocument,
			and(
				eq(driveDocument.id, drive.activeJdId),
				eq(driveDocument.driveId, drive.id),
				eq(driveDocument.kind, "job_description"),
				eq(driveDocument.uploadState, "stored"),
			),
		)
		.where(eq(drive.id, id));
	if (!row) throw new DriveProblem(404, "not_found");
	return row;
}

export const documentColumns = {
	id: driveDocument.id,
	kind: driveDocument.kind,
	filename: driveDocument.filename,
	mediaType: driveDocument.mediaType,
	size: driveDocument.size,
	uploadState: driveDocument.uploadState,
	parseState: driveDocument.parseState,
	parseAttempts: driveDocument.parseAttempts,
	parseFailure: driveDocument.parseFailure,
	usedOcr: driveDocument.usedOcr,
	candidateId: driveCandidate.id,
};

export function documentStatuses(database: Database) {
	return database
		.select(documentColumns)
		.from(driveDocument)
		.leftJoin(
			driveCandidate,
			and(
				eq(driveDocument.driveId, driveCandidate.driveId),
				eq(driveDocument.id, driveCandidate.sourceId),
			),
		);
}

export async function documentStatus(
	database: Database,
	driveId: string,
	id: string,
): Promise<DocumentStatus> {
	const [row] = await documentStatuses(database).where(
		and(eq(driveDocument.driveId, driveId), eq(driveDocument.id, id)),
	);
	if (!row) throw new DriveProblem(404, "not_found");
	return row;
}

const candidateRecordColumns = {
	id: driveCandidate.id,
	sourceId: driveCandidate.sourceId,
	name: driveCandidate.name,
	email: driveCandidate.email,
	experienceTenths: driveCandidate.experienceTenths,
	revision: driveCandidate.revision,
	reviewState: driveCandidate.reviewState,
	duplicateOf: driveCandidate.duplicateOf,
};

export const candidateColumns = {
	...candidateRecordColumns,
	suggestions: driveDocument.suggestions,
	extractedText: driveDocument.extractedText,
};

type CandidateRecord = Pick<
	typeof driveCandidate.$inferSelect,
	| "id"
	| "sourceId"
	| "name"
	| "email"
	| "experienceTenths"
	| "revision"
	| "reviewState"
	| "duplicateOf"
>;

function candidateSummary(
	row: CandidateRecord,
	suggestions: CandidateSummary["suggestions"],
): CandidateSummary {
	return {
		id: row.id,
		sourceId: row.sourceId,
		name: row.name,
		email: row.email,
		years: row.experienceTenths === null ? null : row.experienceTenths / 10,
		revision: row.revision,
		reviewState: row.reviewState,
		duplicateOf: row.duplicateOf,
		suggestions,
	};
}

export function candidateView(
	row: CandidateRecord &
		Partial<
			Pick<typeof driveDocument.$inferSelect, "suggestions" | "extractedText">
		>,
): Candidate {
	return {
		...candidateSummary(row, row.suggestions ?? null),
		extractedText: row.extractedText ?? null,
	};
}

const processingResume = or(
	eq(driveDocument.uploadState, "pending"),
	and(
		eq(driveDocument.uploadState, "stored"),
		inArray(driveDocument.parseState, ["queued", "processing"]),
	),
);

const resumeNeedsAttention = or(
	inArray(driveDocument.uploadState, ["failed", "cleanup"]),
	and(
		eq(driveCandidate.reviewState, "draft"),
		or(
			eq(driveDocument.parseState, "needs_manual_review"),
			and(
				eq(driveDocument.parseState, "succeeded"),
				sql`(
					coalesce(nullif(${driveCandidate.name}, ''), nullif(${driveDocument.suggestions}->>'name', '')) is null
					or coalesce(${driveCandidate.email}, nullif(${driveDocument.suggestions}->>'email', '')) is null
				)`,
			),
		),
	),
);

function matchesReviewStatus(status: ReviewQueueStatus) {
	switch (status) {
		case "all":
			return undefined;
		case "processing":
			return processingResume;
		case "needs_attention":
			return resumeNeedsAttention;
		default:
			return eq(driveCandidate.reviewState, status);
	}
}

export async function listReviewQueue(
	database: Database,
	driveId: string,
	{
		page: requestedPage,
		q,
		status,
	}: { page: number; q: string; status: ReviewQueueStatus },
): Promise<z.infer<typeof reviewQueueSchema>> {
	const pageSize = 20;
	const scope = and(
		eq(driveDocument.driveId, driveId),
		eq(driveDocument.kind, "resume"),
	);
	const join = and(
		eq(driveCandidate.driveId, driveDocument.driveId),
		eq(driveCandidate.sourceId, driveDocument.id),
	);
	const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
	const search = q
		? sql`(
		${driveDocument.filename} ilike ${pattern} or
		${driveCandidate.name} ilike ${pattern} or ${driveCandidate.email} ilike ${pattern} or
		${driveDocument.suggestions}->>'name' ilike ${pattern} or
		${driveDocument.suggestions}->>'email' ilike ${pattern}
	)`
		: undefined;
	const filter = and(matchesReviewStatus(status), search);

	return database.transaction(
		async (tx) => {
			const [counts] = await tx
				.select({
					total: sql<number>`count(*) filter (where ${filter ?? sql`true`})::int`,
					processing: sql<number>`count(*) filter (where ${processingResume})::int`,
				})
				.from(driveDocument)
				.leftJoin(driveCandidate, join)
				.where(scope);
			const page = Math.min(
				requestedPage,
				Math.max(1, Math.ceil(counts.total / pageSize)),
			);
			const rows = counts.total
				? await tx
						.select({
							document: documentColumns,
							candidate: candidateRecordColumns,
							suggestions: driveDocument.suggestions,
						})
						.from(driveDocument)
						.leftJoin(driveCandidate, join)
						.where(and(scope, filter))
						.orderBy(desc(driveDocument.createdAt), desc(driveDocument.id))
						.limit(pageSize)
						.offset((page - 1) * pageSize)
				: [];
			return {
				...counts,
				page,
				pageSize,
				items: rows.map(({ document, candidate, suggestions }) => ({
					document,
					candidate: candidate
						? candidateSummary(candidate, suggestions)
						: null,
				})),
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export function pageBoundary(
	table: SQLWrapper,
	columns: { id: SQLWrapper; createdAt: SQLWrapper },
	after: string | undefined,
	scope?: ReturnType<typeof eq>,
) {
	if (!after) return undefined;
	return sql`(${columns.createdAt}, ${columns.id}) < (
		select ${columns.createdAt}, ${columns.id} from ${table} where ${and(eq(columns.id, after), scope)}
	)`;
}

export function page<T extends { id: string }>(rows: T[], limit: number) {
	const items = rows.slice(0, limit);
	return {
		items,
		next: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
	};
}
