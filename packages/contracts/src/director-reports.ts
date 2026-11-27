import { z } from "zod";
import { assessmentDecisionSchema } from "./assessments.ts";
import { roundSchema } from "./drives.ts";
import { interviewPageNumberSchema } from "./interviews.ts";

export const directorResultStatusSchema = z.enum([
	"in_progress",
	"pending_review",
	"selected",
	"not_selected",
	"do_not_proceed",
	"withdrawn",
]);

export const directorReportQuerySchema = z
	.object({
		driveId: z.uuid().optional(),
		round: roundSchema.optional(),
		outcome: directorResultStatusSchema.optional(),
		from: z.iso.date().optional(),
		to: z.iso.date().optional(),
		page: interviewPageNumberSchema.default(1),
	})
	.refine(({ from, to }) => !from || !to || from <= to);
export type DirectorReportQuery = z.infer<typeof directorReportQuerySchema>;

const driveSummary = z.object({ id: z.uuid(), title: z.string() });
const resultCounts = z.record(
	directorResultStatusSchema,
	z.number().int().min(0),
);
const directorResult = z.object({
	id: z.uuid(),
	drive: driveSummary,
	name: z.string().min(1).max(120),
	round: roundSchema.nullable(),
	status: directorResultStatusSchema,
	activityDate: z.iso.date(),
	hasScorecards: z.boolean(),
});
export type DirectorResult = z.infer<typeof directorResult>;

export const directorReportSchema = z.object({
	drives: z.array(driveSummary),
	progress: z.array(z.object({ drive: driveSummary, counts: resultCounts })),
	totals: resultCounts,
	cancelled: z.number().int().min(0),
	noShows: z.number().int().min(0),
	page: z.number(),
	pageSize: z.number(),
	items: z.array(directorResult),
});

export const directorScorecardsSchema = z.object({
	page: z.number(),
	hasNext: z.boolean(),
	items: z.array(
		z.object({
			roundId: z.uuid(),
			round: roundSchema,
			attempt: z.number().int().positive(),
			versionId: z.uuid(),
			decision: assessmentDecisionSchema,
			submittedAt: z.iso.datetime(),
		}),
	),
});
