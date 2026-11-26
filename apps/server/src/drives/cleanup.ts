import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { and, eq, inArray, sql } from "drizzle-orm";
import { errorClass, logger } from "../logger.ts";
import { s3, storage } from "../storage.ts";
import type { Database } from "./queries.ts";
import { drive, driveCandidate, driveDocument } from "./schema.ts";

const due = sql`${driveDocument.cleanupAfter} <= clock_timestamp()`;
const reclaimable = and(
	due,
	sql`(${driveDocument.uploadState} <> 'pending' or ${driveDocument.deadline} <= clock_timestamp())`,
	inArray(driveDocument.uploadState, [
		"pending",
		"retired",
		"failed",
		"cleanup",
	]),
);

export async function sweepOriginals(database: Database, signal: AbortSignal) {
	const claims = await database.transaction(async (tx) => {
		const rows = await tx
			.select({
				id: driveDocument.id,
				driveId: driveDocument.driveId,
				attempt: driveDocument.attempt,
				objectKey: driveDocument.objectKey,
			})
			.from(driveDocument)
			.where(reclaimable)
			.orderBy(driveDocument.cleanupAfter)
			.limit(8)
			.for("update", { skipLocked: true });
		const claimed = [];
		for (const row of rows) {
			// Publication holds the same document lock and can only publish a pending row.
			const {
				rows: [references],
			} = await tx.execute<{ jd: boolean; candidate: boolean }>(sql`
				select exists (select 1 from ${drive} where ${drive.id} = ${row.driveId} and ${drive.activeJdId} = ${row.id}) as jd,
					exists (select 1 from ${driveCandidate} where ${driveCandidate.driveId} = ${row.driveId} and ${driveCandidate.sourceId} = ${row.id}) as candidate
			`);
			if (references.jd || references.candidate) continue;
			const [claim] = await tx
				.update(driveDocument)
				.set({
					uploadState: "cleanup",
					parseAfter: null,
					parseClaim: null,
					cleanupAfter: sql`clock_timestamp() + interval '45 seconds'`,
				})
				.where(
					and(
						eq(driveDocument.id, row.id),
						eq(driveDocument.attempt, row.attempt),
						reclaimable,
					),
				)
				.returning({
					id: driveDocument.id,
					attempt: driveDocument.attempt,
					objectKey: driveDocument.objectKey,
				});
			if (claim) claimed.push(claim);
		}
		return claimed;
	});
	await Promise.all(
		claims.map(async (claim) => {
			try {
				await s3.send(
					new DeleteObjectCommand({
						Bucket: storage.bucket,
						Key: claim.objectKey,
					}),
					{
						abortSignal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
					},
				);
				// Keep deleting during a grace window to catch a late S3 write after the first delete.
				await database
					.update(driveDocument)
					.set({
						cleanupDeletedAt: sql`clock_timestamp()`,
						cleanupAfter: sql`case when clock_timestamp() > ${driveDocument.deadline} + interval '10 minutes'
					then null else clock_timestamp() + interval '60 seconds' end`,
					})
					.where(
						and(
							eq(driveDocument.id, claim.id),
							eq(driveDocument.attempt, claim.attempt),
							eq(driveDocument.uploadState, "cleanup"),
						),
					);
			} catch (error) {
				logger.warn(
					{ documentId: claim.id, errorClass: errorClass(error) },
					"Intake cleanup will retry",
				);
			}
		}),
	);
}
