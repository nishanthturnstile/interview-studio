import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { and, eq, gt, sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { db, pool } from "./database.ts";
import { probeQueue } from "./jobs.ts";
import { errorClass, logger } from "./logger.ts";
import { workerHeartbeat } from "./schema.ts";
import { s3, storage } from "./storage.ts";

pool.on("error", (error) =>
	logger.error(
		{ errorClass: errorClass(error) },
		"Idle database connection lost",
	),
);

const app = createApp(async () => {
	const [database, heartbeat, bucket] = await Promise.allSettled([
		db.execute(sql`select 1`),
		db
			.select({ name: workerHeartbeat.name })
			.from(workerHeartbeat)
			.where(
				and(
					eq(workerHeartbeat.name, probeQueue),
					gt(workerHeartbeat.seenAt, sql`now() - interval '12 seconds'`),
				),
			),
		s3.send(new HeadBucketCommand({ Bucket: storage.bucket }), {
			abortSignal: AbortSignal.timeout(2_000),
		}),
	]);
	return {
		database: database.status === "fulfilled",
		worker: heartbeat.status === "fulfilled" && heartbeat.value.length > 0,
		storage: bucket.status === "fulfilled",
	};
}, logger);

app.get("*", serveStatic({ root: "./apps/web/dist" }));
const server = serve({ fetch: app.fetch, port: 3000 }, ({ port }) => {
	logger.info({ port }, "Interview Studio listening");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		server.close(async () => {
			s3.destroy();
			await pool.end();
		});
	});
}
