import { z } from "zod";

export const healthSchema = z.object({
	status: z.enum(["ready", "degraded"]),
	services: z.object({
		database: z.boolean(),
		worker: z.boolean(),
		storage: z.boolean(),
	}),
});

export type Health = z.infer<typeof healthSchema>;

export const probeJobSchema = z.object({
	requestId: z.uuid(),
});

export * from "./assessments.ts";
export * from "./director-reports.ts";
export * from "./drives.ts";
export * from "./feedback-reviews.ts";
export * from "./interview-artifacts.ts";
export * from "./interview-concerns.ts";
export * from "./interview-execution.ts";
export * from "./interviews.ts";
export * from "./staff.ts";
