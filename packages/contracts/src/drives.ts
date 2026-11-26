import { z } from "zod";
import type { StaffRole } from "./staff.ts";

export function canViewDrives(role: StaffRole) {
	return role === "hr" || role === "director";
}

export const documentBytes = 10 * 1024 * 1024;
export const selectionLimit = 20;
export const statusLookupLimit = 50;
export const documentKindSchema = z.enum(["job_description", "resume"]);
export type DocumentKind = z.infer<typeof documentKindSchema>;
export const wordMediaType =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const mediaTypeSchema = z.enum([
	"application/pdf",
	wordMediaType,
	"image/png",
	"image/jpeg",
]);
export type DocumentMedia = z.infer<typeof mediaTypeSchema>;

const documentExtensions = {
	".pdf": "application/pdf",
	".docx": wordMediaType,
} as const;
const resumeExtensions = {
	...documentExtensions,
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
} as const;

export function documentUploadTypes(kind: DocumentKind) {
	return kind === "resume" ? resumeExtensions : documentExtensions;
}

export function documentMediaForFilename(
	filename: string,
	kind: DocumentKind,
): DocumentMedia | undefined {
	const dot = filename.lastIndexOf(".");
	if (dot < 1) return undefined;
	const extension = filename.slice(dot).toLowerCase();
	return Object.entries(documentUploadTypes(kind)).find(
		([suffix]) => suffix === extension,
	)?.[1];
}
export const uploadStateSchema = z.enum([
	"pending",
	"stored",
	"failed",
	"retired",
	"cleanup",
]);
export const parseStateSchema = z.enum([
	"queued",
	"processing",
	"succeeded",
	"needs_manual_review",
]);
export const parseFailureSchema = z.enum([
	"scan_only",
	"invalid_document",
	"resource_limit",
	"infrastructure_exhausted",
]);
export type ParseFailure = z.infer<typeof parseFailureSchema>;
export const reviewStateSchema = z.enum(["draft", "confirmed", "duplicate"]);
export const roundSchema = z.enum(["l1", "l2"]);
export type Round = z.infer<typeof roundSchema>;
export const revisionSchema = z.number().int().min(0).max(2_147_483_647);
export const idempotencyKeySchema = z.uuid();
const nameSchema = z
	.string()
	.trim()
	.max(120)
	.refine((name) => !/\p{Cc}/u.test(name));
export const driveCreateSchema = z
	.object({
		name: z
			.string()
			.trim()
			.transform((name) => name.replace(/\s+/g, " "))
			.pipe(nameSchema.refine((name) => name.length > 0)),
	})
	.strict();
export const candidateEmailSchema = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.email().max(254));
export const candidateFieldsSchema = z.object({
	name: nameSchema,
	email: z.union([
		z
			.string()
			.trim()
			.length(0)
			.transform(() => null),
		candidateEmailSchema,
		z.null(),
	]),
	years: z.number().min(0).max(80).multipleOf(0.1).nullable(),
});
export const candidatePatchSchema = candidateFieldsSchema
	.partial()
	.extend({ revision: revisionSchema })
	.strict();
export const reviewActionSchema = z
	.object({ revision: revisionSchema })
	.strict();
export const duplicateActionSchema = reviewActionSchema.extend({
	targetId: z.uuid().transform((value) => value.toLowerCase()),
	targetRevision: revisionSchema,
});
const skillNameSchema = nameSchema.refine((name) => name.length > 0);
const skillSchema = z.object({ id: z.uuid(), name: skillNameSchema });
export const skillSaveSchema = reviewActionSchema.extend({
	skills: z
		.array(skillSchema.partial({ id: true }))
		.max(50)
		.superRefine((skills, ctx) => {
			const names = new Set<string>();
			const ids = new Set<string>();
			for (const [index, skill] of skills.entries()) {
				const name = skill.name.toLowerCase();
				if (names.has(name) || (skill.id && ids.has(skill.id))) {
					ctx.addIssue({
						code: "custom",
						path: [index],
						message: "Each skill must be unique within its round.",
					});
				}
				names.add(name);
				if (skill.id) ids.add(skill.id);
			}
		}),
});
export type Skill = z.infer<typeof skillSchema>;
export const skillSetSchema = z.object({
	round: roundSchema,
	skills: z.array(skillSchema),
	revision: revisionSchema,
	reviewedAt: z.iso.datetime().nullable(),
});
export type SkillSet = z.infer<typeof skillSetSchema>;
export const driveOverviewSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	createdAt: z.iso.datetime(),
	counts: z.object({
		resumes: z.number(),
		drafts: z.number(),
		confirmed: z.number(),
		duplicates: z.number(),
	}),
	skills: z.array(skillSetSchema),
});
export type DriveOverview = z.infer<typeof driveOverviewSchema>;
export const driveIntakeSchema = z.object({
	jdRevision: revisionSchema,
	activeJdId: z.uuid().nullable(),
});
export type DriveIntake = z.infer<typeof driveIntakeSchema>;
export const jobDescriptionLimit = 150_000;
const jobDescriptionText = z
	.string()
	.max(jobDescriptionLimit)
	.refine((text) => !text.includes(String.fromCharCode(0)));
export const jobDescriptionSchema = driveIntakeSchema.extend({
	editedText: jobDescriptionText.nullable(),
	extractedText: jobDescriptionText.nullable(),
});
export type JobDescription = z.infer<typeof jobDescriptionSchema>;
export const jobDescriptionSaveSchema = z
	.object({
		revision: revisionSchema,
		text: jobDescriptionText,
	})
	.strict();
export const documentStatusSchema = z.object({
	id: z.uuid(),
	kind: documentKindSchema,
	filename: z.string(),
	mediaType: mediaTypeSchema,
	size: z.number().int().positive(),
	uploadState: uploadStateSchema,
	parseState: parseStateSchema.nullable(),
	parseAttempts: z.number().int().nonnegative(),
	parseFailure: parseFailureSchema.nullable(),
	usedOcr: z.boolean().default(false),
	candidateId: z.uuid().nullable(),
});
export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export const candidateSchema = candidateFieldsSchema.extend({
	id: z.uuid(),
	sourceId: z.uuid(),
	revision: revisionSchema,
	reviewState: reviewStateSchema,
	duplicateOf: z.uuid().nullable(),
	suggestions: candidateFieldsSchema.partial().nullable(),
	extractedText: z.string().nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;
export type CandidateFields = z.infer<typeof candidateFieldsSchema>;
export const candidateSummarySchema = candidateSchema.omit({
	extractedText: true,
});
export type CandidateSummary = z.infer<typeof candidateSummarySchema>;
export const reviewQueueStatusSchema = z.enum([
	"all",
	"draft",
	"confirmed",
	"duplicate",
	"needs_attention",
	"processing",
]);
export type ReviewQueueStatus = z.infer<typeof reviewQueueStatusSchema>;
const reviewQueueItemSchema = z.object({
	document: documentStatusSchema,
	candidate: candidateSummarySchema.nullable(),
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;
export const reviewQueueSchema = z.object({
	items: z.array(reviewQueueItemSchema),
	total: z.number().int().nonnegative(),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	processing: z.number().int().nonnegative(),
});
export function drivePageSchema<T extends z.ZodType>(item: T) {
	return z.object({ items: z.array(item), next: z.uuid().nullable() });
}
export const driveErrorSchema = z.object({
	error: z.enum([
		"unauthenticated",
		"forbidden",
		"untrusted_origin",
		"not_found",
		"internal_error",
		"invalid_input",
		"invalid_file",
		"upload_timeout",
		"file_too_large",
		"unsupported_file",
		"upload_busy",
		"upload_rate_limit",
		"intake_full",
		"idempotency_conflict",
		"upload_retry_required",
		"revision_conflict",
		"duplicate_email",
		"interview_email_in_use",
		"invalid_review",
		"original_missing",
		"preview_unavailable",
		"preview_busy",
		"storage_unavailable",
		"queue_unavailable",
	]),
	field: z.string().optional(),
	current: z.unknown().optional(),
	target: z.object({ id: z.uuid(), revision: revisionSchema }).optional(),
});
export type DriveError = z.infer<typeof driveErrorSchema>;
export const intakeJobSchema = z.object({
	documentId: z.uuid(),
	generation: revisionSchema,
	correlationId: z.uuid(),
});
