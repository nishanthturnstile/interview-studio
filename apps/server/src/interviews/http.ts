import {
	type ArtifactKind,
	artifactKindSchema,
	artifactRequestLimits,
} from "@studio/contracts";
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

export function artifactKind(value: string) {
	const kind = artifactKindSchema.safeParse(value);
	if (!kind.success) throw new InterviewProblem(404, "not_found");
	return kind.data;
}

export async function readArtifactBody(
	c: Context,
	kind: ArtifactKind,
	limit = artifactRequestLimits[kind],
): Promise<unknown> {
	const tooLarge = () =>
		new InterviewProblem(413, "workspace_too_large", { kind });
	const invalid = () =>
		new InterviewProblem(400, "workspace_invalid", { kind });
	if (Number(c.req.header("content-length")) > limit) throw tooLarge();
	if (
		c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !==
		"application/json"
	)
		throw invalid();
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw invalid();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let body = "";
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		void reader.cancel().catch(() => {});
	}, 8_000);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (timedOut)
				throw new InterviewProblem(408, "workspace_timeout", { kind });
			if (done) return JSON.parse(body + decoder.decode());
			bytes += value.byteLength;
			if (bytes > limit) throw tooLarge();
			body += decoder.decode(value, { stream: true });
		}
	} catch (error) {
		void reader.cancel().catch(() => {});
		if (error instanceof InterviewProblem) throw error;
		throw invalid();
	} finally {
		clearTimeout(deadline);
		reader.releaseLock();
	}
}
