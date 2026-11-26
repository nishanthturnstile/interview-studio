import {
	candidatePatchSchema,
	canViewDrives,
	documentKindSchema,
	driveCreateSchema,
	duplicateActionSchema,
	idempotencyKeySchema,
	jobDescriptionLimit,
	jobDescriptionSaveSchema,
	reviewActionSchema,
	reviewQueueStatusSchema,
	roundSchema,
	type StaffIdentity,
	skillSaveSchema,
	statusLookupLimit,
} from "@studio/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { DriveProblem } from "./errors.ts";
import {
	candidateColumns,
	candidateView,
	type Database,
	documentStatuses,
	driveColumns,
	getJobDescription,
	listReviewQueue,
	overview,
	page,
	pageBoundary,
	requireDrive,
	skillColumns,
	skillSet,
} from "./queries.ts";
import { changeCandidate, changeSkills } from "./review.ts";
import { drive, driveCandidate, driveDocument, driveSkills } from "./schema.ts";
import { createUploadHandler, original } from "./uploads.ts";
import { wordPreview } from "./word-preview.ts";

const idSchema = z.uuid().transform((value) => value.toLowerCase());
const paging = z.object({
	after: idSchema.optional(),
	limit: z
		.string()
		.regex(/^\d{1,2}$/)
		.transform(Number)
		.pipe(z.number().int().min(1).max(50))
		.optional(),
});
const documentPaging = paging.extend({ kind: documentKindSchema.optional() });
const reviewPaging = z.object({
	page: z
		.string()
		.regex(/^\d{1,8}$/)
		.transform(Number)
		.pipe(z.number().int().positive())
		.optional(),
	q: z.string().trim().max(160).optional(),
	status: reviewQueueStatusSchema.optional(),
});
const boundedJson = bodyLimit({
	maxSize: 16_384,
	onError: (c) => c.json({ error: "invalid_input", field: "body" }, 413),
});
const boundedDescription = bodyLimit({
	maxSize: jobDescriptionLimit * 6 + 1024,
	onError: (c) => c.json({ error: "invalid_input", field: "body" }, 413),
});

function read<T extends z.ZodType>(
	schema: T,
	value: unknown,
	field?: string,
): z.output<T> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const path = parsed.error.issues[0]?.path[0];
		throw new DriveProblem(400, "invalid_input", {
			field: field ?? (typeof path === "string" ? path : "body"),
		});
	}
	return parsed.data;
}

function recordId(value: string) {
	const id = idSchema.safeParse(value);
	if (!id.success) throw new DriveProblem(404, "not_found");
	return id.data;
}

export async function createDrive(
	database: Database,
	createdBy: string,
	clientKey: string,
	name: string,
) {
	return database.transaction(async (tx) => {
		const [created] = await tx
			.insert(drive)
			.values({ createdBy, clientKey, name })
			.onConflictDoNothing({ target: [drive.createdBy, drive.clientKey] })
			.returning({ id: drive.id });
		if (created) {
			await tx.insert(driveSkills).values([
				{ driveId: created.id, round: "l1" },
				{ driveId: created.id, round: "l2" },
			]);
			return { id: created.id, status: 201 } as const;
		}
		const [existing] = await tx
			.select({ id: drive.id, name: drive.name })
			.from(drive)
			.where(
				and(eq(drive.createdBy, createdBy), eq(drive.clientKey, clientKey)),
			);
		if (existing.name !== name)
			throw new DriveProblem(409, "idempotency_conflict");
		return { id: existing.id, status: 200 } as const;
	});
}

export function driveRoutes(database: Database, boss: PgBoss) {
	const routes = new Hono<{ Variables: { staff: StaffIdentity } }>();
	const upload = createUploadHandler(database, boss);
	const prefix = "/api/staff/drives";
	routes.use("*", async (c, next) => {
		const role = c.get("staff").role;
		const allowedOverview =
			c.req.method === "GET" &&
			(c.req.path === prefix ||
				/^\/api\/staff\/drives\/[^/]+$/.test(c.req.path));
		if (role !== "hr" && !(allowedOverview && canViewDrives(role))) {
			return c.json({ error: "forbidden" }, 403);
		}
		await next();
	});

	routes.get("/", async (c) => {
		const { after, limit = 20 } = read(paging, c.req.query());
		const rows = page(
			await database
				.select(driveColumns)
				.from(drive)
				.where(pageBoundary(drive, drive, after))
				.orderBy(desc(drive.createdAt), desc(drive.id))
				.limit(limit + 1),
			limit,
		);
		const skills = rows.items.length
			? await database
					.select(skillColumns)
					.from(driveSkills)
					.where(
						inArray(
							driveSkills.driveId,
							rows.items.map(({ id }) => id),
						),
					)
					.orderBy(driveSkills.round)
			: [];
		return c.json({
			items: rows.items.map((row) =>
				overview(
					row,
					skills.filter(({ driveId }) => driveId === row.id).map(skillSet),
				),
			),
			next: rows.next,
		});
	});
	routes.post("/", boundedJson, async (c) => {
		const key = read(
			idempotencyKeySchema,
			c.req.header("Idempotency-Key"),
			"idempotencyKey",
		);
		const { name } = read(
			driveCreateSchema,
			await c.req.json().catch(() => null),
		);
		const { id, status } = await createDrive(
			database,
			c.get("staff").id,
			key,
			name,
		);
		return c.json({ id }, status);
	});
	routes.get("/:driveId", async (c) => {
		const id = recordId(c.req.param("driveId"));
		const [row] = await database
			.select(driveColumns)
			.from(drive)
			.where(eq(drive.id, id));
		if (!row) throw new DriveProblem(404, "not_found");
		const skills = await database
			.select(skillColumns)
			.from(driveSkills)
			.where(eq(driveSkills.driveId, id))
			.orderBy(driveSkills.round);
		return c.json(overview(row, skills.map(skillSet)));
	});
	routes.get("/:driveId/job-description", async (c) => {
		return c.json(
			await getJobDescription(database, recordId(c.req.param("driveId"))),
		);
	});
	routes.put("/:driveId/job-description", boundedDescription, async (c) => {
		const id = recordId(c.req.param("driveId"));
		const { revision, text } = read(
			jobDescriptionSaveSchema,
			await c.req.json().catch(() => null),
		);
		const result = await database.transaction(async (tx) => {
			const [saved] = await tx
				.update(drive)
				.set({
					jdText: text,
					jdRevision: sql`${drive.jdRevision} + 1`,
					updatedAt: sql`clock_timestamp()`,
				})
				.where(and(eq(drive.id, id), eq(drive.jdRevision, revision)))
				.returning({ id: drive.id });
			const current = await getJobDescription(tx, id);
			if (!saved) throw new DriveProblem(409, "revision_conflict", { current });
			return current;
		});
		return c.json(result);
	});
	routes.post("/:driveId/documents", async (c) => {
		const id = recordId(c.req.param("driveId"));
		await requireDrive(database, id);
		const result = await upload(
			c.req.raw,
			c.req.query("kind"),
			id,
			c.get("staff").id,
		);
		return c.json(result.document, result.status);
	});
	routes.get("/:driveId/documents", async (c) => {
		const id = recordId(c.req.param("driveId"));
		const intake = await requireDrive(database, id);
		const scope = eq(driveDocument.driveId, id);
		const requested = c.req.query("ids");
		if (requested !== undefined) {
			const ids = [
				...new Set(
					read(
						z.array(idSchema).min(1).max(statusLookupLimit),
						requested.split(","),
						"ids",
					),
				),
			];
			const items = await documentStatuses(database).where(
				and(scope, inArray(driveDocument.id, ids)),
			);
			if (items.length !== ids.length) throw new DriveProblem(404, "not_found");
			return c.json({ intake, items, next: null });
		}
		const { after, limit = 20, kind } = read(documentPaging, c.req.query());
		const rows = await documentStatuses(database)
			.where(
				and(
					scope,
					kind ? eq(driveDocument.kind, kind) : undefined,
					pageBoundary(driveDocument, driveDocument, after, scope),
				),
			)
			.orderBy(desc(driveDocument.createdAt), desc(driveDocument.id))
			.limit(limit + 1);
		return c.json({ intake, ...page(rows, limit) });
	});
	routes.get("/:driveId/documents/:documentId/original", (c) =>
		original(
			database,
			recordId(c.req.param("driveId")),
			recordId(c.req.param("documentId")),
			c.req.raw.signal,
		),
	);
	routes.get("/:driveId/documents/:documentId/preview", (c) =>
		wordPreview(
			database,
			recordId(c.req.param("driveId")),
			recordId(c.req.param("documentId")),
			c.req.raw.signal,
		),
	);
	routes.get("/:driveId/review-queue", async (c) => {
		const driveId = recordId(c.req.param("driveId"));
		const {
			page = 1,
			q = "",
			status = "all",
		} = read(reviewPaging, c.req.query());
		await requireDrive(database, driveId);
		return c.json(
			await listReviewQueue(database, driveId, { page, q, status }),
		);
	});
	routes.get("/:driveId/candidates", async (c) => {
		const id = recordId(c.req.param("driveId"));
		await requireDrive(database, id);
		const scope = eq(driveCandidate.driveId, id);
		const candidates = database
			.select(candidateColumns)
			.from(driveCandidate)
			.innerJoin(
				driveDocument,
				and(
					eq(driveDocument.id, driveCandidate.sourceId),
					eq(driveDocument.driveId, driveCandidate.driveId),
				),
			);
		const requested = c.req.query("ids");
		if (requested !== undefined) {
			const ids = [
				...new Set(
					read(
						z.array(idSchema).min(1).max(statusLookupLimit),
						requested.split(","),
						"ids",
					),
				),
			];
			const items = await candidates.where(
				and(scope, inArray(driveCandidate.id, ids)),
			);
			if (items.length !== ids.length) throw new DriveProblem(404, "not_found");
			return c.json({ items: items.map(candidateView), next: null });
		}
		const { after, limit = 20 } = read(paging, c.req.query());
		const rows = await candidates
			.where(
				and(scope, pageBoundary(driveCandidate, driveCandidate, after, scope)),
			)
			.orderBy(desc(driveCandidate.createdAt), desc(driveCandidate.id))
			.limit(limit + 1);
		return c.json(page(rows.map(candidateView), limit));
	});
	routes.get("/:driveId/candidates/:candidateId", async (c) => {
		const driveId = recordId(c.req.param("driveId"));
		const candidateId = recordId(c.req.param("candidateId"));
		const [row] = await database
			.select(candidateColumns)
			.from(driveCandidate)
			.innerJoin(
				driveDocument,
				and(
					eq(driveDocument.id, driveCandidate.sourceId),
					eq(driveDocument.driveId, driveCandidate.driveId),
				),
			)
			.where(
				and(
					eq(driveCandidate.driveId, driveId),
					eq(driveCandidate.id, candidateId),
				),
			);
		if (!row) throw new DriveProblem(404, "not_found");
		return c.json(candidateView(row));
	});
	routes.patch("/:driveId/candidates/:candidateId", boundedJson, async (c) =>
		c.json(
			await changeCandidate(
				database,
				recordId(c.req.param("driveId")),
				recordId(c.req.param("candidateId")),
				{
					type: "save",
					input: read(
						candidatePatchSchema,
						await c.req.json().catch(() => null),
					),
				},
			),
		),
	);
	routes.post(
		"/:driveId/candidates/:candidateId/confirm",
		boundedJson,
		async (c) =>
			c.json(
				await changeCandidate(
					database,
					recordId(c.req.param("driveId")),
					recordId(c.req.param("candidateId")),
					{
						type: "confirm",
						input: read(
							reviewActionSchema,
							await c.req.json().catch(() => null),
						),
					},
				),
			),
	);
	routes.post(
		"/:driveId/candidates/:candidateId/duplicate",
		boundedJson,
		async (c) =>
			c.json(
				await changeCandidate(
					database,
					recordId(c.req.param("driveId")),
					recordId(c.req.param("candidateId")),
					{
						type: "duplicate",
						input: read(
							duplicateActionSchema,
							await c.req.json().catch(() => null),
						),
					},
				),
			),
	);
	routes.put("/:driveId/skills/:round", boundedJson, async (c) =>
		c.json(
			await changeSkills(
				database,
				recordId(c.req.param("driveId")),
				read(roundSchema, c.req.param("round"), "round"),
				{
					type: "save",
					input: read(skillSaveSchema, await c.req.json().catch(() => null)),
				},
			),
		),
	);
	routes.post("/:driveId/skills/:round/review", boundedJson, async (c) =>
		c.json(
			await changeSkills(
				database,
				recordId(c.req.param("driveId")),
				read(roundSchema, c.req.param("round"), "round"),
				{
					type: "review",
					reviewerId: c.get("staff").id,
					input: read(reviewActionSchema, await c.req.json().catch(() => null)),
				},
			),
		),
	);
	return routes;
}
