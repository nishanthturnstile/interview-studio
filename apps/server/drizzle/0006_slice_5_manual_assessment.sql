ALTER TYPE "public"."interview_state" ADD VALUE 'feedback_submitted' BEFORE 'cancelled';--> statement-breakpoint
CREATE TABLE "interview_assessment" (
	"round_id" uuid PRIMARY KEY NOT NULL,
	"criteria" jsonb NOT NULL,
	"draft" jsonb DEFAULT '{"questions":[],"notes":"","ratings":[],"decision":null,"rationale":""}'::jsonb NOT NULL,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"draft_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interview_assessment_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"previous_version_id" uuid,
	"decision" text NOT NULL,
	"ratings" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"correction_reason" text,
	"author_id" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "interview_assessment_version_number" UNIQUE("round_id","version"),
	CONSTRAINT "interview_assessment_version_scope" UNIQUE("round_id","id"),
	CONSTRAINT "interview_assessment_version_chain" CHECK (("interview_assessment_version"."version" = 1 and "interview_assessment_version"."previous_version_id" is null and "interview_assessment_version"."correction_reason" is null) or ("interview_assessment_version"."version" > 1 and "interview_assessment_version"."previous_version_id" is not null and length(btrim("interview_assessment_version"."correction_reason")) > 0 and "interview_assessment_version"."correction_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "interview_progress" (
	"drive_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"l1_version_id" uuid,
	"revision" integer NOT NULL,
	CONSTRAINT "interview_progress_drive_id_candidate_id_pk" PRIMARY KEY("drive_id","candidate_id")
);
--> statement-breakpoint
ALTER TABLE "interview_round" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interview_round" ADD COLUMN "cancellation_code" text;--> statement-breakpoint
ALTER TABLE "interview_round" ADD COLUMN "legacy_assessment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_assessment" ADD CONSTRAINT "interview_assessment_round_id_interview_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_assessment_version" ADD CONSTRAINT "interview_assessment_version_round_id_interview_assessment_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_assessment"("round_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_assessment_version" ADD CONSTRAINT "interview_assessment_version_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_assessment_version" ADD CONSTRAINT "interview_assessment_previous_version_fk" FOREIGN KEY ("round_id","previous_version_id") REFERENCES "public"."interview_assessment_version"("round_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_progress" ADD CONSTRAINT "interview_progress_l1_version_id_interview_assessment_version_id_fk" FOREIGN KEY ("l1_version_id") REFERENCES "public"."interview_assessment_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_progress" ADD CONSTRAINT "interview_progress_candidacy_fk" FOREIGN KEY ("drive_id","candidate_id") REFERENCES "public"."drive_candidate"("drive_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "interview_round"
SET "legacy_assessment" = true
WHERE "level" = 'l1' AND "state" IN ('scheduled', 'active', 'awaiting_feedback');--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "interview_round"
		WHERE "state" IN ('scheduled', 'active', 'awaiting_feedback')
		GROUP BY "drive_id", "candidate_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Cannot upgrade interviews with multiple unresolved rounds per candidacy';
	END IF;
END $$;--> statement-breakpoint
DROP INDEX "interview_round_unresolved";--> statement-breakpoint
CREATE UNIQUE INDEX "interview_round_unresolved" ON "interview_round" USING btree ("drive_id","candidate_id") WHERE "interview_round"."state" in ('scheduled', 'active', 'awaiting_feedback');
