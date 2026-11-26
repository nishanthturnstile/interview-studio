import { candidateFieldsSchema } from "@studio/contracts";
import { z } from "zod";

export const maxText = 150_000;
export const parserOutputSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("succeeded"),
		text: z.string().max(maxText),
		suggestions: candidateFieldsSchema.partial(),
		usedOcr: z.boolean(),
	}),
	z.object({
		status: z.literal("needs_manual_review"),
		reason: z.enum(["scan_only", "invalid_document", "resource_limit"]),
	}),
]);
