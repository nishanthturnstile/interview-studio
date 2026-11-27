import { z } from "zod";
import {
	assessmentReasonSchema,
	assessmentVersionMetadataSchema,
} from "./assessments.ts";

export const feedbackReviewKindSchema = z.enum([
	"pass_reversed",
	"handoff_updated",
]);
export const feedbackResolutionActionSchema = z.enum([
	"apply_l1",
	"reinstate_l2",
	"rebook_l2",
]);
export type FeedbackResolutionAction = z.infer<
	typeof feedbackResolutionActionSchema
>;
const resolutionOutcomeSchema = z.enum([
	"do_not_proceed",
	"schedule_l1",
	"schedule_l2",
	"selected",
	"not_selected",
]);
export type FeedbackResolutionOutcome = z.infer<typeof resolutionOutcomeSchema>;
const person = z.object({ id: z.string(), name: z.string() });
const id = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(0).max(2_147_483_647);
const instant = z.iso.datetime();

export const feedbackReviewSummarySchema = z.object({
	id,
	kind: feedbackReviewKindSchema,
	createdAt: instant,
	candidate: z.object({ id, name: z.string() }),
	drive: z.object({ id, title: z.string() }),
});
export const feedbackReviewListSchema = z.object({
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	total: z.number().int().min(0),
	items: z.array(feedbackReviewSummarySchema),
});
export const feedbackReviewDetailSchema = feedbackReviewSummarySchema.extend({
	revision,
	l1RoundId: id,
	l2: z.object({ id, attempt: z.number().int().positive() }),
	previousL1: assessmentVersionMetadataSchema,
	triggerL1: assessmentVersionMetadataSchema,
	latestL1: assessmentVersionMetadataSchema,
	l2Version: assessmentVersionMetadataSchema.nullable(),
	availableResolution: z
		.object({
			action: feedbackResolutionActionSchema,
			outcome: resolutionOutcomeSchema,
		})
		.nullable(),
	resolution: z
		.object({
			action: feedbackResolutionActionSchema,
			outcome: resolutionOutcomeSchema,
			resolvedAt: instant,
			resolvedBy: person,
			reason: assessmentReasonSchema,
			appliedL1VersionId: id,
			reinstatedL2VersionId: id.nullable(),
		})
		.nullable(),
	acknowledgment: z.object({ readAt: instant, readBy: person }).nullable(),
});
export type FeedbackReviewDetail = z.infer<typeof feedbackReviewDetailSchema>;

export const resolveFeedbackReviewSchema = z.object({
	commandId: id,
	expectedRevision: revision,
	expectedL1VersionId: id,
	action: feedbackResolutionActionSchema,
	reason: assessmentReasonSchema,
});
export const acknowledgeFeedbackReviewSchema = z.object({ commandId: id });
