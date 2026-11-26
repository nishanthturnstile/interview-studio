import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
	type DocumentMedia,
	documentBytes,
	documentKindSchema,
	documentMediaForFilename,
	idempotencyKeySchema,
	wordMediaType,
} from "@studio/contracts";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { intakeQueue } from "../jobs.ts";
import { errorClass, logger } from "../logger.ts";
import { s3, storage } from "../storage.ts";
import { inspectDocx, ParseLimit } from "./archive.ts";
import { DriveProblem } from "./errors.ts";
import { type Database, documentStatus } from "./queries.ts";
import { drive, driveCandidate, driveDocument } from "./schema.ts";
import { SizeLimit, withStagedFile, writeStagedFile } from "./staging.ts";

class UploadAdmission {
	active = 0;
	windows = new Map<string, { end: number; requests: number }>();

	enter(userId: string) {
		const now = Date.now();
		for (const [key, window] of this.windows) {
			if (window.end <= now) this.windows.delete(key);
		}
		const window = this.windows.get(userId) ?? {
			end: now + 60_000,
			requests: 0,
		};
		if (window.requests >= 30) {
			throw new DriveProblem(
				429,
				"upload_rate_limit",
				{},
				Math.ceil((window.end - now) / 1000),
			);
		}
		window.requests++;
		this.windows.set(userId, window);
		if (this.active >= 2) throw new DriveProblem(429, "upload_busy", {}, 2);
		this.active++;
		return () => {
			this.active--;
		};
	}
}

function metadata(request: Request, rawKind: string | undefined) {
	const kind = documentKindSchema.safeParse(rawKind);
	const clientKey = idempotencyKeySchema.safeParse(
		request.headers.get("idempotency-key"),
	);
	if (!kind.success)
		throw new DriveProblem(400, "invalid_input", { field: "kind" });
	if (!clientKey.success)
		throw new DriveProblem(400, "invalid_input", { field: "idempotencyKey" });
	const header = request.headers.get("x-upload-filename");
	let filename = "";
	try {
		if (header && header.length <= 1_024)
			filename = decodeURIComponent(header).normalize("NFC").trim();
	} catch {
		throw new DriveProblem(400, "invalid_file", { field: "filename" });
	}
	if (
		!filename ||
		Buffer.byteLength(filename) > 255 ||
		/[/\\\p{Cc}]/u.test(filename)
	) {
		throw new DriveProblem(400, "invalid_file", { field: "filename" });
	}
	const mediaType = documentMediaForFilename(filename, kind.data);
	const declaredType =
		request.headers.get("content-type")?.trim().toLowerCase() || null;
	if (
		!mediaType ||
		(declaredType &&
			declaredType !== "application/octet-stream" &&
			declaredType !== mediaType)
	) {
		throw new DriveProblem(415, "unsupported_file", { field: "contentType" });
	}
	let jdRevision = null;
	if (kind.data === "job_description") {
		const revision = request.headers.get("x-jd-revision");
		if (
			!revision ||
			!/^\d{1,10}$/.test(revision) ||
			Number(revision) > 2_147_483_647
		) {
			throw new DriveProblem(400, "invalid_input", { field: "jdRevision" });
		}
		jdRevision = Number(revision);
	}
	const length = request.headers.get("content-length");
	if (length !== null) {
		if (!/^\d+$/.test(length))
			throw new DriveProblem(400, "invalid_file", { field: "file" });
		if (Number(length) > documentBytes)
			throw new DriveProblem(413, "file_too_large", { field: "file" });
	}
	return {
		kind: kind.data,
		clientKey: clientKey.data,
		declaredType,
		mediaType,
		filename,
		jdRevision,
	};
}

async function validateStructure(path: string, type: DocumentMedia) {
	try {
		if (type === wordMediaType) {
			await inspectDocx(path, false);
		} else {
			const file = await open(path);
			try {
				const magic = Buffer.alloc(8);
				await file.read(magic);
				const valid =
					type === "application/pdf"
						? magic.subarray(0, 5).toString("ascii") === "%PDF-"
						: type === "image/png"
							? magic.toString("hex") === "89504e470d0a1a0a"
							: magic.subarray(0, 3).toString("hex") === "ffd8ff";
				if (!valid) throw new Error("Missing document signature");
			} finally {
				await file.close();
			}
		}
	} catch (error) {
		if (error instanceof ParseLimit)
			throw new DriveProblem(413, "file_too_large", { field: "file" });
		throw new DriveProblem(415, "unsupported_file", { field: "file" });
	}
}

type Metadata = ReturnType<typeof metadata> & {
	size: number;
	sha256: string;
	driveId: string;
	uploadedBy: string;
};

async function reserve(database: Database, input: Metadata) {
	return database.transaction(async (tx) => {
		// Every new reservation uses the same transaction lock before counting backlog.
		await tx.execute(sql`select pg_advisory_xact_lock(84531742)`);
		const [existing] = await tx
			.select()
			.from(driveDocument)
			.where(
				and(
					eq(driveDocument.driveId, input.driveId),
					eq(driveDocument.uploadedBy, input.uploadedBy),
					eq(driveDocument.kind, input.kind),
					eq(driveDocument.clientKey, input.clientKey),
				),
			);
		if (existing) {
			for (const field of [
				"size",
				"sha256",
				"filename",
				"declaredType",
				"mediaType",
				"jdRevision",
			] as const) {
				if (existing[field] !== input[field])
					throw new DriveProblem(409, "idempotency_conflict");
			}
			if (
				existing.uploadState === "stored" ||
				existing.uploadState === "retired" ||
				(existing.uploadState === "cleanup" && existing.jobId !== null)
			) {
				return { id: existing.id, status: 200 } as const;
			}
			if (
				existing.uploadState === "pending" &&
				existing.deadline.getTime() > Date.now()
			) {
				return { id: existing.id, status: 202 } as const;
			}
			throw new DriveProblem(409, "upload_retry_required");
		}
		if (input.kind === "job_description") {
			const [current] = await tx
				.select({ jdRevision: drive.jdRevision, activeJdId: drive.activeJdId })
				.from(drive)
				.where(eq(drive.id, input.driveId));
			if (!current) throw new DriveProblem(404, "not_found");
			if (current.jdRevision !== input.jdRevision)
				throw new DriveProblem(409, "revision_conflict", { current });
		}
		const [backlog] = await tx
			.select({ total: count() })
			.from(driveDocument)
			.where(
				or(
					and(
						eq(driveDocument.uploadState, "pending"),
						sql`${driveDocument.deadline} > clock_timestamp()`,
					),
					and(
						eq(driveDocument.uploadState, "stored"),
						inArray(driveDocument.parseState, ["queued", "processing"]),
					),
				),
			);
		if (backlog.total >= 100)
			throw new DriveProblem(429, "intake_full", {}, 10);
		const objectKey = `drive-uploads/${randomUUID()}`;
		const [row] = await tx
			.insert(driveDocument)
			.values({
				...input,
				objectKey,
				deadline: sql`clock_timestamp() + interval '25 seconds'`,
				cleanupAfter: sql`clock_timestamp() + interval '25 seconds'`,
			})
			.returning({
				id: driveDocument.id,
				attempt: driveDocument.attempt,
				objectKey: driveDocument.objectKey,
			});
		return { ...row, status: 201 } as const;
	});
}

async function publish(
	database: Database,
	boss: PgBoss,
	reservation: { id: string; attempt: string },
) {
	await database.transaction(async (tx) => {
		const pending = and(
			eq(driveDocument.id, reservation.id),
			eq(driveDocument.attempt, reservation.attempt),
			eq(driveDocument.uploadState, "pending"),
			sql`${driveDocument.deadline} > clock_timestamp()`,
		);
		const [document] = await tx
			.select()
			.from(driveDocument)
			.where(pending)
			.for("update");
		if (!document) throw new DriveProblem(409, "upload_retry_required");
		if (document.kind === "job_description") {
			const [current] = await tx
				.select({ jdRevision: drive.jdRevision, activeJdId: drive.activeJdId })
				.from(drive)
				.where(eq(drive.id, document.driveId))
				.for("update");
			if (!current || current.jdRevision !== document.jdRevision) {
				throw new DriveProblem(409, "revision_conflict", { current });
			}
			await tx
				.update(drive)
				.set({
					activeJdId: document.id,
					jdRevision: current.jdRevision + 1,
					updatedAt: sql`clock_timestamp()`,
				})
				.where(eq(drive.id, document.driveId));
			if (current.activeJdId) {
				await tx
					.update(driveDocument)
					.set({
						uploadState: "retired",
						cleanupAfter: sql`clock_timestamp()`,
						parseClaim: null,
						parseAfter: null,
						generation: sql`${driveDocument.generation} + 1`,
					})
					.where(
						and(
							eq(driveDocument.id, current.activeJdId),
							eq(driveDocument.driveId, document.driveId),
							eq(driveDocument.kind, "job_description"),
						),
					);
			}
		} else {
			await tx
				.insert(driveCandidate)
				.values({ driveId: document.driveId, sourceId: document.id });
		}
		let jobId: string | null;
		try {
			jobId = await boss.send(
				intakeQueue,
				{
					documentId: document.id,
					generation: document.generation,
					correlationId: randomUUID(),
				},
				{ db: fromDrizzle(tx, sql) },
			);
		} catch (error) {
			logger.warn(
				{ documentId: document.id, errorClass: errorClass(error) },
				"Intake enqueue failed",
			);
			throw new DriveProblem(503, "queue_unavailable");
		}
		if (!jobId) throw new DriveProblem(503, "queue_unavailable");
		const [stored] = await tx
			.update(driveDocument)
			.set({
				uploadState: "stored",
				parseState: "queued",
				jobId,
				cleanupAfter: null,
				parseAfter: sql`clock_timestamp()`,
			})
			.where(pending)
			.returning({ id: driveDocument.id });
		if (!stored) throw new DriveProblem(409, "upload_retry_required");
	});
}

async function markFailed(
	database: Database,
	reservation: { id: string; attempt: string },
) {
	try {
		await database
			.update(driveDocument)
			.set({ uploadState: "failed", cleanupAfter: sql`clock_timestamp()` })
			.where(
				and(
					eq(driveDocument.id, reservation.id),
					eq(driveDocument.attempt, reservation.attempt),
					eq(driveDocument.uploadState, "pending"),
				),
			);
	} catch (error) {
		logger.warn(
			{ documentId: reservation.id, errorClass: errorClass(error) },
			"Intake failure state unavailable",
		);
	}
}

export function createUploadHandler(database: Database, boss: PgBoss) {
	const admission = new UploadAdmission();
	return async (
		request: Request,
		kind: string | undefined,
		driveId: string,
		uploadedBy: string,
	) => {
		const release = admission.enter(uploadedBy);
		try {
			const fields = metadata(request, kind);
			const body = request.body;
			if (!body) throw new DriveProblem(400, "invalid_file", { field: "file" });
			return await withStagedFile(async (path) => {
				const deadline = AbortSignal.timeout(30_000);
				const signal = AbortSignal.any([deadline, request.signal]);
				const file = await writeStagedFile(body, path, signal).catch(
					(error: unknown) => {
						if (error instanceof SizeLimit)
							throw new DriveProblem(413, "file_too_large", { field: "file" });
						if (signal.aborted)
							throw new DriveProblem(400, "upload_timeout", { field: "file" });
						throw new DriveProblem(400, "invalid_file", { field: "file" });
					},
				);
				if (!file.size)
					throw new DriveProblem(400, "invalid_file", { field: "file" });
				await validateStructure(path, fields.mediaType);
				const reserved = await reserve(database, {
					...fields,
					...file,
					driveId,
					uploadedBy,
				});
				if (reserved.status === 201) {
					try {
						const contents = createReadStream(path);
						try {
							await s3.send(
								new PutObjectCommand({
									Bucket: storage.bucket,
									Key: reserved.objectKey,
									Body: contents,
									ContentLength: file.size,
									ContentType: fields.mediaType,
								}),
								{
									abortSignal: AbortSignal.any([
										AbortSignal.timeout(12_000),
										request.signal,
									]),
								},
							);
						} catch (error) {
							logger.warn(
								{ documentId: reserved.id, errorClass: errorClass(error) },
								"Intake storage write failed",
							);
							throw new DriveProblem(503, "storage_unavailable");
						} finally {
							contents.destroy();
						}
						await publish(database, boss, reserved);
					} catch (error) {
						await markFailed(database, reserved);
						throw error;
					}
				}
				return {
					document: await documentStatus(database, driveId, reserved.id),
					status: reserved.status,
				};
			});
		} finally {
			release();
		}
	};
}

export async function original(
	database: Database,
	driveId: string,
	documentId: string,
	signal: AbortSignal,
	media?: DocumentMedia,
) {
	const [document] = await database
		.select({
			objectKey: driveDocument.objectKey,
			filename: driveDocument.filename,
			media: driveDocument.mediaType,
			state: driveDocument.uploadState,
		})
		.from(driveDocument)
		.where(
			and(eq(driveDocument.driveId, driveId), eq(driveDocument.id, documentId)),
		);
	if (document?.state !== "stored" || (media && document.media !== media))
		throw new DriveProblem(404, "not_found");
	try {
		const result = await s3.send(
			new GetObjectCommand({ Bucket: storage.bucket, Key: document.objectKey }),
			{ abortSignal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
		);
		if (!result.Body) throw new DriveProblem(503, "original_missing");
		const ascii = document.filename.replace(/[^a-zA-Z0-9 ._-]/g, "_");
		const unicode = encodeURIComponent(document.filename).replace(
			/['()*]/g,
			(value) => `%${value.charCodeAt(0).toString(16)}`,
		);
		return new Response(result.Body.transformToWebStream(), {
			headers: {
				"Content-Type": document.media,
				"Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${unicode}`,
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		if (error instanceof DriveProblem) throw error;
		logger.warn(
			{ documentId, errorClass: errorClass(error) },
			"Intake original unavailable",
		);
		const notFound =
			(error as { $metadata?: { httpStatusCode?: number } })?.$metadata
				?.httpStatusCode === 404;
		throw new DriveProblem(
			503,
			notFound ? "original_missing" : "storage_unavailable",
		);
	}
}
