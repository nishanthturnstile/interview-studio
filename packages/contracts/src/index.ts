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
