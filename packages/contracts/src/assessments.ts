import { z } from "zod";
import { type Round, skillSchema } from "./drives.ts";

import { isWorkspaceText } from "./interview-text.ts";

const id = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(0).max(2_147_483_647);
const instant = z.iso.datetime();
const text = (max: number) =>
	z
		.string()
		.max(max * 2)
		.refine(
			(value) =>
				isWorkspaceText(value) &&
				(value.length <= max || Array.from(value).length <= max),
		);

export const assessmentRatingSchema = z.enum([
	"below_expectations",
	"meets_expectations",
	"exceeds_expectations",
	"not_assessed",
]);
export const assessmentDecisionSchema = z.enum([
	"pass",
	"do_not_proceed",
	"incomplete",
	"selected",
	"not_selected",
]);
export const assessmentDecisionsByRound = {
	l1: ["pass", "do_not_proceed", "incomplete"],
	l2: ["selected", "not_selected", "incomplete"],
} as const satisfies Record<
	Round,
	readonly z.infer<typeof assessmentDecisionSchema>[]
>;

const ratingFields = z.object({
	skillId: id,
	rating: assessmentRatingSchema,
	feedback: text(500).default(""),
});
const uniqueSkills = (rows: { skillId: string }[]) =>
	new Set(rows.map(({ skillId }) => skillId)).size === rows.length;
const questions = z
	.array(z.object({ id, text: text(500) }))
	.max(50)
	.refine((rows) => new Set(rows.map(({ id }) => id)).size === rows.length);

export const assessmentScorecardSchema = z.object({
	ratings: z.array(ratingFields).max(50).refine(uniqueSkills),
	decision: assessmentDecisionSchema,
	rationale: text(2_000)
		.refine((value) => value.trim().length > 0)
		.transform((value) => value.trim()),
});
export type AssessmentScorecard = z.infer<typeof assessmentScorecardSchema>;

export const assessmentDraftSchema = assessmentScorecardSchema.extend({
	questions,
	notes: text(16_000),
	ratings: z
		.array(ratingFields.extend({ rating: assessmentRatingSchema.nullable() }))
		.max(50)
		.refine(uniqueSkills),
	decision: assessmentDecisionSchema.nullable().default(null),
	rationale: text(2_000).default(""),
});
export type AssessmentDraft = z.infer<typeof assessmentDraftSchema>;

export const assessmentReasonSchema = text(2_000)
	.refine((value) => value.trim().length > 0)
	.transform((value) => value.trim());

export const assessmentCriteriaSchema = z.object({
	skills: z.array(skillSchema).min(1).max(50),
	skillRevision: revision,
	reviewedAt: instant,
	capturedAt: instant,
	source: z.enum(["booking", "after_booking"]),
});
export type AssessmentCriteria = z.infer<typeof assessmentCriteriaSchema>;

export const submittedAssessmentSchema = assessmentScorecardSchema.extend({
	id,
	version: z.number().int().positive(),
	previousVersionId: id.nullable(),
	correctionReason: text(2_000).nullable(),
	reviewedL1VersionId: id.nullable(),
	author: z.object({ id: z.string(), name: z.string() }),
	submittedAt: instant,
});

const submittedScorecard = z.object({
	criteria: assessmentCriteriaSchema,
	submitted: submittedAssessmentSchema,
});

export const assessmentVersionMetadataSchema = submittedAssessmentSchema.omit({
	ratings: true,
	rationale: true,
});
export type AssessmentVersionMetadata = z.infer<
	typeof assessmentVersionMetadataSchema
>;
export const assessmentVersionListSchema = z.object({
	page: z.number().int().positive(),
	hasNext: z.boolean(),
	items: z.array(assessmentVersionMetadataSchema),
});
export const assessmentVersionDetailSchema = submittedScorecard.extend({
	l1Handoff: submittedScorecard.nullable(),
});

export const assessmentViewSchema = z.object({
	revisionTag: z.string().optional(),
	status: z.enum([
		"available",
		"initialize",
		"skills_need_review",
		"unavailable",
	]),
	attemptRevision: revision,
	criteria: assessmentCriteriaSchema.nullable(),
	draft: z
		.object({
			content: assessmentDraftSchema,
			revision,
			updatedAt: instant.nullable(),
		})
		.nullable(),
	submitted: submittedAssessmentSchema.nullable(),
	l1Handoff: submittedScorecard.nullable(),
	canEdit: z.boolean(),
	canSubmit: z.boolean(),
	canCorrect: z.boolean(),
});
export type AssessmentView = z.infer<typeof assessmentViewSchema>;

export const hrAssessmentSchema = submittedScorecard.extend({
	revisionTag: z.string().optional(),
});

export const initializeAssessmentSchema = z.object({ commandId: id });
export const saveAssessmentDraftSchema = z.object({
	commandId: id,
	draftRevision: revision,
	content: assessmentDraftSchema,
});
export const submitAssessmentSchema = z.object({
	commandId: id,
	draftRevision: revision,
	attemptRevision: revision,
	reviewedL1VersionId: id.optional(),
});

export const correctAssessmentSchema = z.object({
	commandId: id,
	expectedVersionId: id,
	reason: assessmentReasonSchema,
	scorecard: assessmentScorecardSchema,
});
