import { setTimeout as delay } from "node:timers/promises";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { and, eq, gt, sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { databaseUrl, db, pool } from "./database.ts";
import { sweepOriginals } from "./drives/cleanup.ts";
import { driveRoutes } from "./drives/routes.ts";
import { sweepStaging } from "./drives/staging.ts";
import { sweepAdmission } from "./interviews/admission.ts";
import { interviewCandidateRoutes } from "./interviews/candidate-routes.ts";
import { interviewStaffRoutes } from "./interviews/staff-routes.ts";
import { readInterviewConfig } from "./interviews/store.ts";
import { WorkspaceLive } from "./interviews/workspace-live.ts";
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
const interviewConfig = readInterviewConfig(process.env, staffSettings);
const mailer = createStaffMailer(process.env);
const auth = createStaffAuth(db, staffSettings, mailer.send);
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
		try {
			await sweepAdmission(db, new Date());
		} catch (error) {
			logger.warn(
				{ errorClass: errorClass(error) },
				"Interview admission sweep failed",
			);
		}
		await delay(15_000, undefined, { signal: cleanup.signal }).catch(
			() => undefined,
		);
	} while (!cleanup.signal.aborted);
}
const sweeping = sweep();
const live = new WorkspaceLive(databaseUrl);
const staff = staffRoutes(
	db,
	staffSettings,
	auth,
	driveRoutes(db, boss),
	interviewStaffRoutes(db, interviewConfig, {
		live,
		trustedOrigins: staffSettings.trustedOrigins,
	}),
);

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
	interviewCandidateRoutes(
		db,
		interviewConfig,
		staffSettings,
		mailer.deliver,
		live,
		boss,
	),
);

app.use("*", async (c, next) => {
	await next();
	if (c.res.headers.get("Content-Type")?.startsWith("text/html"))
		c.header("Content-Security-Policy", "font-src 'self' data:");
});
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
	"/staff/interviews",
	"/staff/my-interviews",
	"/staff/my-interviews/:roundId",
	"/staff/my-interviews/invitations/:invitationId",
	"/join/:invitationId",
	"/interview/:roundId",
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
const server = serve(
	{ fetch: app.fetch, port: 3000, websocket: { server: live.server } },
	({ port }) => {
		logger.info({ port }, "Interview Studio listening");
	},
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		cleanup.abort();
		const stopLive = live.stop();
		server.close(async () => {
			await stopLive;
			await sweeping;
			await boss.stop();
			s3.destroy();
			await pool.end();
		});
	});
}
