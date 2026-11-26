import { randomUUID } from "node:crypto";
import type { Health } from "@studio/contracts";
import { Hono } from "hono";
import type { Logger } from "pino";
import { DriveProblem } from "./drives/errors.ts";
import type { interviewCandidateRoutes } from "./interviews/candidate-routes.ts";
import { InterviewProblem } from "./interviews/problem.ts";
import { errorClass } from "./logger.ts";
import type { staffRoutes } from "./staff/routes.ts";

export function createApp(
	checkHealth: () => Promise<Health["services"]>,
	logger: Logger,
	staff?: ReturnType<typeof staffRoutes>,
	candidate?: ReturnType<typeof interviewCandidateRoutes>,
) {
	const app = new Hono();
	app.onError((error, c) => {
		if (error instanceof InterviewProblem) {
			if (error.body.retryAfter)
				c.header("Retry-After", String(error.body.retryAfter));
			return c.json(error.body, error.status);
		}
		if (error instanceof DriveProblem) {
			if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
			return c.json(error.body, error.status);
		}
		logger.error({ errorClass: errorClass(error) }, "HTTP request failed");
		return c.json({ error: "internal_error" }, 500);
	});
	app.use("*", async (c, next) => {
		const requestId = randomUUID();
		const start = performance.now();
		c.header("X-Request-Id", requestId);
		await next();
		logger.info(
			{
				requestId,
				method: c.req.method,
				status: c.res.status,
				durationMs: Math.round(performance.now() - start),
			},
			"HTTP request",
		);
	});

	app.get("/api/health/live", (c) => c.json({ status: "alive" }));
	app.get("/api/health", async (c) => {
		c.header("Cache-Control", "no-store");
		const services = await checkHealth();
		const ready = services.database && services.worker && services.storage;
		const body: Health = { status: ready ? "ready" : "degraded", services };
		return c.json(body, ready ? 200 : 503);
	});
	if (staff) app.route("/", staff);
	if (candidate) app.route("/api/interviews", candidate);
	app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

	return app;
}
