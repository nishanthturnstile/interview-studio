import { setTimeout } from "node:timers/promises";
import { probeJobSchema } from "@studio/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "./database.ts";
import { sweepStaging } from "./drives/staging.ts";
import { processDocument, reconcileIntake } from "./drives/worker.ts";
import { verifyFixture } from "./fixture.ts";
import {
	configuredCodeRunner,
	RunnerRequestError,
} from "./interviews/code-runner.ts";
import {
	codeRunQueue,
	expireCodeRuns,
	processCodeRun,
} from "./interviews/code-runs.ts";
import { createQueueClient, intakeQueue, probeQueue } from "./jobs.ts";
import { errorClass, logger } from "./logger.ts";
import { workerHeartbeat } from "./schema.ts";
import { s3 } from "./storage.ts";

const boss = createQueueClient({ supervise: true });
const controller = new AbortController();
const runProgram = configuredCodeRunner(process.env);
if (process.env.STUDIO_CODE_EXECUTION_ENABLED === "true" && !runProgram)
	logger.warn(
		"Code execution is enabled but worker runner configuration is invalid",
	);
const codeJob = z.object({ runId: z.uuid(), roundId: z.uuid() });
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
	await boss.work(
		codeRunQueue,
		{ batchSize: 1, localConcurrency: 1 },
		async ([job]) => {
			const { runId, roundId } = codeJob.parse(job.data);
			await processCodeRun(
				db,
				roundId,
				runId,
				runProgram &&
					((program) =>
						runProgram(program).catch((error: unknown) => {
							logger.warn(
								{
									runId,
									errorClass: errorClass(error),
									status:
										error instanceof RunnerRequestError
											? error.status
											: undefined,
								},
								"Code runner request failed",
							);
							throw error;
						})),
			);
		},
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
		try {
			await expireCodeRuns(db);
		} catch (error) {
			logger.warn(
				{ errorClass: errorClass(error) },
				"Code run reconciliation failed",
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
