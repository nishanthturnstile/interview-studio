import { setTimeout as delay } from "node:timers/promises";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { and, eq, gt, sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { db, pool } from "./database.ts";
import { sweepOriginals } from "./drives/cleanup.ts";
import { driveRoutes } from "./drives/routes.ts";
import { sweepStaging } from "./drives/staging.ts";
import { createQueueClient, intakeQueue, probeQueue } from "./jobs.ts";
import { errorClass, logger } from "./logger.ts";
import { workerHeartbeat } from "./schema.ts";
import { createStaffAuth } from "./staff/auth.ts";
import { createStaffMailer } from "./staff/mailer.ts";
import { staffRoutes } from "./staff/routes.ts";
import { readStaffSettings } from "./staff/settings.ts";
import { s3, storage } from "./storage.ts";

pool.on("error", (error) =>
	logger.error(
		{ errorClass: errorClass(error) },
		"Idle database connection lost",
	),
);

const staffSettings = readStaffSettings(process.env);
const auth = createStaffAuth(db, staffSettings, createStaffMailer(process.env));
const boss = createQueueClient();
try {
	await boss.start();
	if (!(await boss.getQueue(intakeQueue)))
		throw new Error("Intake queue unavailable");
	await sweepStaging();
} catch (error) {
	logger.error(
		{ errorClass: errorClass(error) },
		"Intake producer startup failed",
	);
	await boss.stop();
	s3.destroy();
	await pool.end();
	process.exit(1);
}
const cleanup = new AbortController();
async function sweep() {
	do {
		try {
			await sweepOriginals(db, cleanup.signal);
			await sweepStaging();
		} catch (error) {
			logger.warn({ errorClass: errorClass(error) }, "Intake sweep failed");
		}
		await delay(15_000, undefined, { signal: cleanup.signal }).catch(
			() => undefined,
		);
	} while (!cleanup.signal.aborted);
}
const sweeping = sweep();
const staff = staffRoutes(db, staffSettings, auth, driveRoutes(db, boss));

const app = createApp(
	async () => {
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
	},
	logger,
	staff,
);

const serveWebApp = serveStatic({ path: "./apps/web/dist/index.html" });
for (const path of [
	"/sign-in",
	"/sign-up",
	"/verify-email",
	"/forgot-password",
	"/reset-password",
	"/staff",
	"/staff/access",
	"/staff/account",
	"/staff/drives",
	"/staff/drives/:driveId",
	"/staff/settings",
]) {
	app.get(path, async (c, next) => {
		c.header("Referrer-Policy", "no-referrer");
		c.header("Cache-Control", "no-store");
		return serveWebApp(c, next);
	});
}
const servePdfAssets = serveStatic({
	root: "./apps/server/node_modules/pdfjs-dist",
	rewriteRequestPath: (path) => path.slice("/pdf-assets/".length),
});
app.get("/pdf-assets/*", async (c, next) => {
	if (
		!/^\/pdf-assets\/(?:cmaps|standard_fonts|iccs|wasm)\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(
			c.req.path,
		)
	) {
		return c.notFound();
	}
	return servePdfAssets(c, next);
});
app.get("*", serveStatic({ root: "./apps/web/dist" }));
const server = serve({ fetch: app.fetch, port: 3000 }, ({ port }) => {
	logger.info({ port }, "Interview Studio listening");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		cleanup.abort();
		server.close(async () => {
			await sweeping;
			await boss.stop();
			s3.destroy();
			await pool.end();
		});
	});
}
