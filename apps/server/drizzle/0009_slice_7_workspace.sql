CREATE TYPE "public"."interview_artifact_kind" AS ENUM('code', 'board');--> statement-breakpoint
CREATE TABLE "interview_artifact_head" (
	"round_id" uuid NOT NULL,
	"kind" "interview_artifact_kind" NOT NULL,
	"revision_id" uuid NOT NULL,
	CONSTRAINT "interview_artifact_head_round_id_kind_pk" PRIMARY KEY("round_id","kind")
);
--> statement-breakpoint
CREATE TABLE "interview_artifact_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"kind" "interview_artifact_kind" NOT NULL,
	"sequence" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"author_session_id" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_artifact_sequence_unique" UNIQUE("round_id","kind","sequence"),
	CONSTRAINT "interview_artifact_revision_scope_unique" UNIQUE("round_id","kind","id"),
	CONSTRAINT "interview_artifact_sequence_positive" CHECK ("interview_artifact_revision"."sequence" > 0),
	CONSTRAINT "interview_artifact_schema_positive" CHECK ("interview_artifact_revision"."schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "interview_artifact_head" ADD CONSTRAINT "interview_artifact_head_revision_fk" FOREIGN KEY ("round_id","kind","revision_id") REFERENCES "public"."interview_artifact_revision"("round_id","kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_artifact_revision" ADD CONSTRAINT "interview_artifact_revision_round_id_interview_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_artifact_revision" ADD CONSTRAINT "interview_artifact_revision_author_session_id_interview_session_id_fk" FOREIGN KEY ("author_session_id") REFERENCES "public"."interview_session"("id") ON DELETE no action ON UPDATE no action;