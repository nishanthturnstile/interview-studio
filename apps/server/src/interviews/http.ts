import type { Context } from "hono";
import { z } from "zod";
import { InterviewProblem } from "./problem.ts";

export async function readBody<T extends z.ZodType>(
	c: Context,
	schema: T,
): Promise<z.output<T>> {
	if (
		!c.req.header("content-type")?.toLowerCase().startsWith("application/json")
	) {
		throw new InterviewProblem(400, "invalid_input");
	}
	const body = schema.safeParse(await c.req.json().catch(() => null));
	if (!body.success)
		throw new InterviewProblem(400, "invalid_input", {
			field: body.error.issues[0]?.path.join("."),
		});
	return body.data;
}

export function uuidParam(value: string) {
	const id = z.uuid().safeParse(value);
	if (!id.success) throw new InterviewProblem(404, "not_found");
	return id.data.toLowerCase();
}
