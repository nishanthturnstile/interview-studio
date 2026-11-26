import { setTimeout } from "node:timers/promises";
import { probeJobSchema } from "@studio/contracts";
import { sql } from "drizzle-orm";
import { db, pool } from "./database.ts";
import { sweepStaging } from "./drives/staging.ts";
import { processDocument, reconcileIntake } from "./drives/worker.ts";
import { verifyFixture } from "./fixture.ts";
import { createQueueClient, intakeQueue, probeQueue } from "./jobs.ts";
import { errorClass, logger } from "./logger.ts";
import { workerHeartbeat } from "./schema.ts";
import { s3 } from "./storage.ts";

const boss = createQueueClient({ supervise: true });
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => controller.abort());
}
pool.on("error", (error) =>
	logger.error(
		{ errorClass: errorClass(error) },
		"Idle database connection lost",
	),
);

try {
	await boss.start();
	await sweepStaging();
	await boss.work(
		intakeQueue,
		{ batchSize: 1, localConcurrency: 1 },
		processDocument(db, controller.signal),
	);
	await boss.work(probeQueue, async ([job]) => {
		const { requestId } = probeJobSchema.parse(job.data);
		const log = logger.child({ requestId, jobId: job.id });
		try {
			await verifyFixture();
			log.info("Storage probe completed");
			return { verified: true };
		} catch (error) {
			log.error({ errorClass: errorClass(error) }, "Storage probe failed");
			throw new Error("Storage probe failed");
		}
	});
	logger.info("Worker started");

	while (!controller.signal.aborted) {
		try {
			await db
				.insert(workerHeartbeat)
				.values({ name: probeQueue, seenAt: sql`now()` })
				.onConflictDoUpdate({
					target: workerHeartbeat.name,
					set: { seenAt: sql`now()` },
				});
		} catch (error) {
			logger.error(
				{ errorClass: errorClass(error) },
				"Worker heartbeat failed",
			);
		}
		try {
			await reconcileIntake(db, boss);
		} catch (error) {
			logger.warn(
				{ errorClass: errorClass(error) },
				"Intake reconciliation failed",
			);
		}
		await setTimeout(3_000, undefined, { signal: controller.signal }).catch(
			(error) => {
				if (!controller.signal.aborted) throw error;
			},
		);
	}
} catch (error) {
	logger.error(
		{ errorClass: errorClass(error) },
		"Worker stopped unexpectedly",
	);
	process.exitCode = 1;
} finally {
	await boss.stop({ timeout: 8_000 });
	s3.destroy();
	await pool.end();
}
