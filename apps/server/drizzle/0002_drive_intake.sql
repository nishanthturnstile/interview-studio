CREATE TYPE "public"."drive_document_kind" AS ENUM('job_description', 'resume');--> statement-breakpoint
CREATE TYPE "public"."drive_parse_failure" AS ENUM('scan_only', 'invalid_document', 'resource_limit', 'infrastructure_exhausted');--> statement-breakpoint
CREATE TYPE "public"."drive_parse_state" AS ENUM('queued', 'processing', 'succeeded', 'needs_manual_review');--> statement-breakpoint
CREATE TYPE "public"."drive_candidate_review" AS ENUM('draft', 'confirmed', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."drive_round" AS ENUM('l1', 'l2');--> statement-breakpoint
CREATE TYPE "public"."drive_upload_state" AS ENUM('pending', 'stored', 'failed', 'retired', 'cleanup');--> statement-breakpoint
CREATE TABLE "drive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"client_key" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"jd_revision" integer DEFAULT 0 NOT NULL,
	"active_jd_id" uuid,
	CONSTRAINT "drive_creator_client_key" UNIQUE("created_by","client_key")
);
--> statement-breakpoint
CREATE TABLE "drive_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text,
	"experience_tenths" integer,
	"review_state" "drive_candidate_review" DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"duplicate_of" uuid,
	CONSTRAINT "drive_candidate_source_id_unique" UNIQUE("source_id"),
	CONSTRAINT "drive_candidate_scope" UNIQUE("drive_id","id"),
	CONSTRAINT "drive_candidate_email_normalized" CHECK ("drive_candidate"."email" = lower(btrim("drive_candidate"."email"))),
	CONSTRAINT "drive_candidate_confirmed_required" CHECK ("drive_candidate"."review_state" <> 'confirmed' or ("drive_candidate"."email" is not null and length(btrim("drive_candidate"."name")) > 0)),
	CONSTRAINT "drive_candidate_duplicate_required" CHECK (("drive_candidate"."review_state" = 'duplicate') = ("drive_candidate"."duplicate_of" is not null) and "drive_candidate"."duplicate_of" is distinct from "drive_candidate"."id"),
	CONSTRAINT "drive_candidate_years" CHECK ("drive_candidate"."experience_tenths" between 0 and 800)
);
--> statement-breakpoint
CREATE TABLE "drive_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"kind" "drive_document_kind" NOT NULL,
	"uploaded_by" text NOT NULL,
	"client_key" uuid NOT NULL,
	"filename" text NOT NULL,
	"declared_type" text,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"attempt" uuid DEFAULT gen_random_uuid() NOT NULL,
	"jd_revision" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deadline" timestamp (3) with time zone NOT NULL,
	"upload_state" "drive_upload_state" DEFAULT 'pending' NOT NULL,
	"cleanup_after" timestamp (3) with time zone,
	"cleanup_deleted_at" timestamp (3) with time zone,
	"parse_state" "drive_parse_state",
	"generation" integer DEFAULT 1 NOT NULL,
	"job_id" uuid,
	"parse_claim" uuid,
	"parse_attempts" integer DEFAULT 0 NOT NULL,
	"parse_failure" "drive_parse_failure",
	"parse_after" timestamp (3) with time zone,
	"suggestions" jsonb,
	"extracted_text" text,
	CONSTRAINT "drive_document_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "drive_document_scope" UNIQUE("drive_id","id"),
	CONSTRAINT "drive_document_client_key" UNIQUE("uploaded_by","drive_id","kind","client_key"),
	CONSTRAINT "drive_document_size" CHECK ("drive_document"."size" between 1 and 10485760),
	CONSTRAINT "drive_document_key_prefix" CHECK ("drive_document"."object_key" like 'drive-uploads/%')
);
--> statement-breakpoint
CREATE TABLE "drive_skills" (
	"drive_id" uuid NOT NULL,
	"round" "drive_round" NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"reviewed_at" timestamp (3) with time zone,
	"reviewed_by" text,
	CONSTRAINT "drive_skills_drive_id_round_pk" PRIMARY KEY("drive_id","round")
);
--> statement-breakpoint
ALTER TABLE "drive" ADD CONSTRAINT "drive_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive" ADD CONSTRAINT "drive_active_jd_fk" FOREIGN KEY ("id","active_jd_id") REFERENCES "public"."drive_document"("drive_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_candidate" ADD CONSTRAINT "drive_candidate_drive_id_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_candidate" ADD CONSTRAINT "drive_candidate_source_fk" FOREIGN KEY ("drive_id","source_id") REFERENCES "public"."drive_document"("drive_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_candidate" ADD CONSTRAINT "drive_candidate_duplicate_fk" FOREIGN KEY ("drive_id","duplicate_of") REFERENCES "public"."drive_candidate"("drive_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_document" ADD CONSTRAINT "drive_document_drive_id_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_document" ADD CONSTRAINT "drive_document_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_skills" ADD CONSTRAINT "drive_skills_drive_id_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_skills" ADD CONSTRAINT "drive_skills_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_order" ON "drive" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "drive_candidate_order" ON "drive_candidate" USING btree ("drive_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_candidate_confirmed_email" ON "drive_candidate" USING btree ("drive_id","email") WHERE "drive_candidate"."review_state" = 'confirmed';--> statement-breakpoint
CREATE INDEX "drive_document_order" ON "drive_document" USING btree ("drive_id","created_at","id");--> statement-breakpoint
CREATE INDEX "drive_document_pending" ON "drive_document" USING btree ("upload_state","parse_state","deadline");--> statement-breakpoint
CREATE INDEX "drive_document_cleanup" ON "drive_document" USING btree ("cleanup_after") WHERE "drive_document"."cleanup_after" is not null;--> statement-breakpoint
CREATE INDEX "drive_document_reconcile" ON "drive_document" USING btree ("parse_after") WHERE "drive_document"."parse_after" is not null;