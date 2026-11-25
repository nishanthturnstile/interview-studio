import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { healthSchema, probeJobSchema } from "@studio/contracts";
import type { JobWithMetadata } from "pg-boss";
import { pool } from "./database.ts";
import { fixtureKey, verifyFixture } from "./fixture.ts";
import { createQueueClient, probeQueue } from "./jobs.ts";
import { s3, storage } from "./storage.ts";

async function checkFixture() {
	await verifyFixture();
	const bucketUrl = new URL(
		encodeURIComponent(storage.bucket),
		storage.endpoint,
	);
	const fixtureUrl = new URL(fixtureKey, `${bucketUrl}/`);

	for (const [url, method] of [
		[fixtureUrl, "GET"],
		[new URL("?list-type=2", bucketUrl), "GET"],
		[new URL("smoke/anonymous-probe.txt", `${bucketUrl}/`), "PUT"],
	] as const) {
		const response = await fetch(url, {
			method,
			body: method === "PUT" ? "anonymous smoke probe" : undefined,
			signal: AbortSignal.timeout(4_000),
		});
		await response.body?.cancel();
		assert.equal(response.status, 403, `Anonymous S3 ${method} must be denied`);
	}

	console.log(
		"Verified fixture checksum and anonymous read, list, and write denial.",
	);
}

async function checkWorker() {
	const response = await fetch(
		new URL("/api/health", process.env.STUDIO_INTERNAL_ORIGIN),
		{
			signal: AbortSignal.timeout(4_000),
		},
	);
	assert.equal(response.status, 200, "The API must be ready");
	assert.equal(healthSchema.parse(await response.json()).status, "ready");
	const data = probeJobSchema.parse({
		requestId: response.headers.get("x-request-id"),
	});
	const boss = createQueueClient();

	try {
		await boss.start();
		const jobId = await boss.send(probeQueue, data, { retryLimit: 0 });
		assert.ok(jobId, "The probe job must enqueue");
		const deadline = performance.now() + 20_000;
		while (performance.now() < deadline) {
			const job: JobWithMetadata<unknown> | null = await boss.getJobById(
				probeQueue,
				jobId,
			);
			if (job?.state === "completed") {
				assert.deepEqual(job.output, { verified: true });
				console.log(
					`Worker verified the fixture. Request ${data.requestId}, job ${jobId}.`,
				);
				return;
			}
			assert.ok(
				job?.state !== "failed",
				"Worker probe failed. Check the worker log.",
			);
			await setTimeout(250);
		}
		throw new Error("Timed out waiting for the worker probe");
	} finally {
		await boss.stop();
	}
}

try {
	const mode = process.argv[2] ?? "all";
	assert.ok(
		["all", "fixture", "worker"].includes(mode),
		"Use all, fixture, or worker",
	);
	if (mode !== "worker") await checkFixture();
	if (mode !== "fixture") await checkWorker();
} finally {
	s3.destroy();
	await pool.end();
}
