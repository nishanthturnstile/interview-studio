import {
	type CandidateFields,
	documentKindSchema,
	mediaTypeSchema,
	parseFailureSchema,
	parseStateSchema,
	reviewStateSchema,
	roundSchema,
	type Skill,
	uploadStateSchema,
} from "@studio/contracts";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../staff/auth-schema.ts";

function enumValues<T extends string>(options: T[]) {
	return options as [T, ...T[]];
}

export const documentKind = pgEnum(
	"drive_document_kind",
	enumValues(documentKindSchema.options),
);
export const uploadState = pgEnum(
	"drive_upload_state",
	enumValues(uploadStateSchema.options),
);
export const parseState = pgEnum(
	"drive_parse_state",
	enumValues(parseStateSchema.options),
);
export const parseFailure = pgEnum(
	"drive_parse_failure",
	enumValues(parseFailureSchema.options),
);
export const reviewState = pgEnum(
	"drive_candidate_review",
	enumValues(reviewStateSchema.options),
);
export const round = pgEnum("drive_round", enumValues(roundSchema.options));
const when = (name: string) =>
	timestamp(name, { withTimezone: true, precision: 3 });

export const drive = pgTable(
	"drive",
	{
		id: uuid().primaryKey().defaultRandom(),
		name: text().notNull(),
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id),
		clientKey: uuid("client_key").notNull(),
		createdAt: when("created_at").notNull().defaultNow(),
		updatedAt: when("updated_at").notNull().defaultNow(),
		jdRevision: integer("jd_revision").notNull().default(0),
		jdText: text("jd_text"),
		activeJdId: uuid("active_jd_id"),
	},
	(t) => [
		unique("drive_creator_client_key").on(t.createdBy, t.clientKey),
		index("drive_order").on(t.createdAt, t.id),
		foreignKey({
			name: "drive_active_jd_fk",
			columns: [t.id, t.activeJdId],
			foreignColumns: [driveDocument.driveId, driveDocument.id],
		}),
	],
);

export const driveDocument = pgTable(
	"drive_document",
	{
		id: uuid().primaryKey().defaultRandom(),
		driveId: uuid("drive_id")
			.notNull()
			.references((): AnyPgColumn => drive.id),
		kind: documentKind().notNull(),
		uploadedBy: text("uploaded_by")
			.notNull()
			.references(() => user.id),
		clientKey: uuid("client_key").notNull(),
		filename: text().notNull(),
		declaredType: text("declared_type"),
		mediaType: text("media_type", {
			enum: enumValues(mediaTypeSchema.options),
		}).notNull(),
		size: integer().notNull(),
		sha256: text().notNull(),
		objectKey: text("object_key").notNull().unique(),
		attempt: uuid().notNull().defaultRandom(),
		jdRevision: integer("jd_revision"),
		createdAt: when("created_at").notNull().defaultNow(),
		deadline: when("deadline").notNull(),
		uploadState: uploadState("upload_state").notNull().default("pending"),
		cleanupAfter: when("cleanup_after"),
		cleanupDeletedAt: when("cleanup_deleted_at"),
		parseState: parseState("parse_state"),
		generation: integer().notNull().default(1),
		jobId: uuid("job_id"),
		parseClaim: uuid("parse_claim"),
		parseAttempts: integer("parse_attempts").notNull().default(0),
		parseFailure: parseFailure("parse_failure"),
		parseAfter: when("parse_after"),
		suggestions: jsonb().$type<Partial<CandidateFields>>(),
		extractedText: text("extracted_text"),
		usedOcr: boolean("used_ocr").notNull().default(false),
	},
	(t) => [
		unique("drive_document_scope").on(t.driveId, t.id),
		unique("drive_document_client_key").on(
			t.uploadedBy,
			t.driveId,
			t.kind,
			t.clientKey,
		),
		index("drive_document_order").on(t.driveId, t.createdAt, t.id),
		index("drive_document_pending").on(t.uploadState, t.parseState, t.deadline),
		index("drive_document_cleanup")
			.on(t.cleanupAfter)
			.where(sql`${t.cleanupAfter} is not null`),
		index("drive_document_reconcile")
			.on(t.parseAfter)
			.where(sql`${t.parseAfter} is not null`),
		check("drive_document_size", sql`${t.size} between 1 and 10485760`),
		check(
			"drive_document_key_prefix",
			sql`${t.objectKey} like 'drive-uploads/%'`,
		),
	],
);

export const driveCandidate = pgTable(
	"drive_candidate",
	{
		id: uuid().primaryKey().defaultRandom(),
		driveId: uuid("drive_id")
			.notNull()
			.references(() => drive.id),
		sourceId: uuid("source_id").notNull().unique(),
		createdAt: when("created_at").notNull().defaultNow(),
		name: text().notNull().default(""),
		email: text(),
		// Tenths of a year keep storage and comparisons exact.
		experienceTenths: integer("experience_tenths"),
		reviewState: reviewState("review_state").notNull().default("draft"),
		revision: integer().notNull().default(0),
		duplicateOf: uuid("duplicate_of"),
	},
	(t) => [
		unique("drive_candidate_scope").on(t.driveId, t.id),
		index("drive_candidate_order").on(t.driveId, t.createdAt, t.id),
		foreignKey({
			name: "drive_candidate_source_fk",
			columns: [t.driveId, t.sourceId],
			foreignColumns: [driveDocument.driveId, driveDocument.id],
		}),
		foreignKey({
			name: "drive_candidate_duplicate_fk",
			columns: [t.driveId, t.duplicateOf],
			foreignColumns: [t.driveId, t.id],
		}),
		uniqueIndex("drive_candidate_confirmed_email")
			.on(t.driveId, t.email)
			.where(sql`${t.reviewState} = 'confirmed'`),
		check(
			"drive_candidate_email_normalized",
			sql`${t.email} = lower(btrim(${t.email}))`,
		),
		check(
			"drive_candidate_confirmed_required",
			sql`${t.reviewState} <> 'confirmed' or (${t.email} is not null and length(btrim(${t.name})) > 0)`,
		),
		check(
			"drive_candidate_duplicate_required",
			sql`(${t.reviewState} = 'duplicate') = (${t.duplicateOf} is not null) and ${t.duplicateOf} is distinct from ${t.id}`,
		),
		check(
			"drive_candidate_years",
			sql`${t.experienceTenths} between 0 and 800`,
		),
	],
);

export const driveSkills = pgTable(
	"drive_skills",
	{
		driveId: uuid("drive_id")
			.notNull()
			.references(() => drive.id),
		round: round().notNull(),
		skills: jsonb().$type<Skill[]>().notNull().default([]),
		revision: integer().notNull().default(0),
		reviewedAt: when("reviewed_at"),
		reviewedBy: text("reviewed_by").references(() => user.id),
	},
	(t) => [primaryKey({ columns: [t.driveId, t.round] })],
);
