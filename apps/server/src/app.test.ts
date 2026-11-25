import { healthSchema, probeJobSchema } from "@studio/contracts";
import pino from "pino";
import { describe, expect, test } from "vite-plus/test";
import { createApp } from "./app.ts";

describe("local health API", () => {
	const logger = pino({ enabled: false });

	test("reports readiness with a valid request ID", async () => {
		const app = createApp(
			async () => ({ database: true, worker: true, storage: true }),
			logger,
		);
		const response = await app.request("/api/health");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(healthSchema.parse(await response.json()).status).toBe("ready");
		expect(
			probeJobSchema.safeParse({
				requestId: response.headers.get("x-request-id"),
			}).success,
		).toBe(true);
	});

	test("distinguishes a running process from a degraded stack", async () => {
		const app = createApp(
			async () => ({ database: true, worker: false, storage: true }),
			logger,
		);
		const response = await app.request("/api/health");
		expect(response.status).toBe(503);
		expect(healthSchema.parse(await response.json())).toEqual({
			status: "degraded",
			services: { database: true, worker: false, storage: true },
		});
		expect((await app.request("/api/health/live")).status).toBe(200);
		expect((await app.request("/api/missing")).status).toBe(404);
	});
});
