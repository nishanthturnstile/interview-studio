import { z } from "zod";
import { isWorkspaceText } from "./interview-text.ts";

const concernText = z
	.string()
	.trim()
	.min(1)
	.max(2_000)
	.refine(
		(value) =>
			isWorkspaceText(value) &&
			(value.length <= 1_000 || Array.from(value).length <= 1_000),
	);
export const saveConcernSchema = z.strictObject({
	commandId: z.uuid(),
	observation: concernText,
	context: concernText,
});
export const concernEntrySchema = saveConcernSchema.extend({
	id: z.uuid(),
	createdAt: z.iso.datetime(),
});
export const concernViewSchema = z.object({
	canAdd: z.boolean(),
	entries: z.array(concernEntrySchema).max(50),
});
export type SaveConcern = z.infer<typeof saveConcernSchema>;
