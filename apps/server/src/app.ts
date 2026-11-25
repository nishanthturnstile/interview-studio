import { randomUUID } from "node:crypto";
import type { Health } from "@studio/contracts";
import { Hono } from "hono";
import type { Logger } from "pino";

export function createApp(
	checkHealth: () => Promise<Health["services"]>,
	logger: Logger,
) {
	const app = new Hono();
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
	app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

	return app;
}
