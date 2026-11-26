import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
	type DocumentKind,
	type DocumentMedia,
	intakeJobSchema,
} from "@studio/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { intakeQueue } from "../jobs.ts";
import { errorClass, logger } from "../logger.ts";
import { s3, storage } from "../storage.ts";
import { parserOutputSchema } from "./parse-result.ts";
import type { Database } from "./queries.ts";
import { driveDocument } from "./schema.ts";
import { SizeLimit, withStagedFile, writeStagedFile } from "./staging.ts";

const exec = promisify(execFile);
const parser = fileURLToPath(new URL("./parse-child.ts", import.meta.url));
const activeParse = and(
	eq(driveDocument.uploadState, "stored"),
	inArray(driveDocument.parseState, ["queued", "processing"]),
);

async function parse(
	path: string,
	media: DocumentMedia,
	kind: DocumentKind,
	signal: AbortSignal,
) {
	try {
		const { stdout } = await exec(
			process.execPath,
			["--max-old-space-size=160", parser, path, media, kind],
			{
				env: {},
				signal,
				timeout: 15_000,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
			},
		);
		return parserOutputSchema.parse(JSON.parse(stdout));
	} catch (error) {
		signal.throwIfAborted();
		const child = error as { killed?: boolean; signal?: string; code?: string };
		if (
			child.killed ||
			child.signal === "SIGABRT" ||
			child.signal === "SIGKILL" ||
			child.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
		) {
			return {
				status: "needs_manual_review",
				reason: "resource_limit",
			} as const;
		}
		throw error;
	}
}

export function processDocument(database: Database, shutdown: AbortSignal) {
	return async ([job]: Job[]): Promise<void> => {
		const { documentId, generation, correlationId } = intakeJobSchema.parse(
			job.data,
		);
		const scope = and(
			activeParse,
			eq(driveDocument.id, documentId),
			eq(driveDocument.generation, generation),
			eq(driveDocument.jobId, job.id),
		);
		const claim = randomUUID();
		const [document] = await database
			.update(driveDocument)
			.set({
				parseClaim: claim,
				parseState: "processing",
				parseAttempts: job.retryCount + 1,
			})
			.where(
				and(scope, sql`${driveDocument.parseAttempts} <= ${job.retryCount}`),
			)
			.returning({
				objectKey: driveDocument.objectKey,
				size: driveDocument.size,
				sha256: driveDocument.sha256,
				media: driveDocument.mediaType,
				kind: driveDocument.kind,
			});
		if (!document) return;
		const fenced = and(scope, eq(driveDocument.parseClaim, claim));
		const signal = AbortSignal.any([job.signal, shutdown]);
		const log = logger.child({ documentId, jobId: job.id, correlationId });
		try {
			const result = await withStagedFile(async (path) => {
				const download = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
				const object = await s3.send(
					new GetObjectCommand({
						Bucket: storage.bucket,
						Key: document.objectKey,
					}),
					{ abortSignal: download },
				);
				if (!object.Body) throw new Error("Missing storage body");
				let staged: Awaited<ReturnType<typeof writeStagedFile>>;
				try {
					staged = await writeStagedFile(
						object.Body.transformToWebStream(),
						path,
						download,
					);
				} catch (error) {
					if (error instanceof SizeLimit)
						throw new Error("Unexpected stored document size");
					throw error;
				}
				if (
					staged.size !== document.size ||
					staged.sha256 !== document.sha256
				) {
					throw new Error("Stored document integrity mismatch");
				}
				return parse(path, document.media, document.kind, signal);
			});
			signal.throwIfAborted();
			await database
				.update(driveDocument)
				.set({
					parseState: result.status,
					parseFailure:
						result.status === "needs_manual_review" ? result.reason : null,
					extractedText: result.status === "succeeded" ? result.text : null,
					suggestions:
						result.status === "succeeded" ? result.suggestions : null,
					usedOcr: result.status === "succeeded" && result.usedOcr,
					parseAfter: null,
					parseClaim: null,
				})
				.where(fenced);
			log.info({ status: result.status }, "Intake extraction finished");
		} catch (error) {
			log.warn({ errorClass: errorClass(error) }, "Intake attempt failed");
			await database
				.update(driveDocument)
				.set({ parseState: "queued", parseClaim: null })
				.where(fenced);
			throw new Error("Intake attempt failed");
		}
	};
}

export async function reconcileIntake(database: Database, boss: PgBoss) {
	const due = sql`${driveDocument.parseAfter} <= clock_timestamp()`;
	const rows = await database
		.select({
			id: driveDocument.id,
			generation: driveDocument.generation,
			jobId: driveDocument.jobId,
			claim: driveDocument.parseClaim,
			expired: sql<boolean>`${driveDocument.createdAt} < clock_timestamp() - interval '10 minutes'`,
		})
		.from(driveDocument)
		.where(and(activeParse, due))
		.orderBy(driveDocument.parseAfter)
		.limit(20);
	for (const row of rows) {
		const job = row.jobId
			? await boss.getJobById(intakeQueue, row.jobId)
			: null;
		const eligible =
			job &&
			(job.state === "created" ||
				job.state === "active" ||
				job.state === "retry");
		const terminal = job ? !eligible : row.expired;
		const scope = and(
			activeParse,
			due,
			eq(driveDocument.id, row.id),
			eq(driveDocument.generation, row.generation),
			sql`${driveDocument.parseClaim} is not distinct from ${row.claim}::uuid`,
		);
		if (terminal) {
			await database
				.update(driveDocument)
				.set({
					parseState: "needs_manual_review",
					parseFailure: "infrastructure_exhausted",
					parseAfter: null,
					parseClaim: null,
				})
				.where(scope);
		} else {
			await database
				.update(driveDocument)
				.set({
					parseAfter: sql`clock_timestamp() + interval '10 seconds'`,
				})
				.where(scope);
		}
	}
}
