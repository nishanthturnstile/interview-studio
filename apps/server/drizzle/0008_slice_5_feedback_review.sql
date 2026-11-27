CREATE TYPE "public"."interview_feedback_resolution_action" AS ENUM('apply_l1', 'reinstate_l2', 'rebook_l2');--> statement-breakpoint
CREATE TYPE "public"."interview_feedback_review_kind" AS ENUM('pass_reversed', 'handoff_updated');--> statement-breakpoint
CREATE TABLE "interview_feedback_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" "interview_feedback_review_kind" NOT NULL,
	"l1_round_id" uuid NOT NULL,
	"previous_l1_version_id" uuid NOT NULL,
	"trigger_l1_version_id" uuid NOT NULL,
	"affected_l2_round_id" uuid NOT NULL,
	"affected_l2_version_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_action" "interview_feedback_resolution_action",
	"resolution_outcome" text,
	"resolution_reason" text,
	"applied_l1_version_id" uuid,
	"reinstated_l2_version_id" uuid,
	"read_at" timestamp with time zone,
	"read_by" text,
	CONSTRAINT "interview_feedback_review_trigger_l1_version_id_unique" UNIQUE("trigger_l1_version_id"),
	CONSTRAINT "feedback_review_resolution_fields" CHECK (
		("interview_feedback_review"."resolved_at" is null and "interview_feedback_review"."resolved_by" is null and "interview_feedback_review"."resolution_action" is null and "interview_feedback_review"."resolution_outcome" is null and "interview_feedback_review"."resolution_reason" is null and "interview_feedback_review"."applied_l1_version_id" is null and "interview_feedback_review"."reinstated_l2_version_id" is null)
		or ("interview_feedback_review"."kind" = 'pass_reversed' and "interview_feedback_review"."resolved_at" is not null and "interview_feedback_review"."resolved_by" is not null and "interview_feedback_review"."resolution_action" is not null and "interview_feedback_review"."resolution_outcome" is not null and "interview_feedback_review"."resolution_reason" is not null and "interview_feedback_review"."applied_l1_version_id" is not null and (("interview_feedback_review"."resolution_action" = 'reinstate_l2') = ("interview_feedback_review"."reinstated_l2_version_id" is not null)))),
	CONSTRAINT "feedback_review_acknowledgment_fields" CHECK (("interview_feedback_review"."read_at" is null and "interview_feedback_review"."read_by" is null) or ("interview_feedback_review"."kind" = 'handoff_updated' and "interview_feedback_review"."read_at" is not null and "interview_feedback_review"."read_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "interview_event" ADD COLUMN "assessment_version_id" uuid;--> statement-breakpoint
ALTER TABLE "interview_event" ADD COLUMN "feedback_review_id" uuid;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "interview_feedback_review_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "interview_feedback_review_read_by_user_id_fk" FOREIGN KEY ("read_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "feedback_review_l1_round_scope_fk" FOREIGN KEY ("drive_id","candidate_id","l1_round_id") REFERENCES "public"."interview_round"("drive_id","candidate_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "feedback_review_l2_round_scope_fk" FOREIGN KEY ("drive_id","candidate_id","affected_l2_round_id") REFERENCES "public"."interview_round"("drive_id","candidate_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "feedback_review_previous_l1_fk" FOREIGN KEY ("l1_round_id","previous_l1_version_id") REFERENCES "public"."interview_assessment_version"("round_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "feedback_review_trigger_l1_fk" FOREIGN KEY ("l1_round_id","trigger_l1_version_id") REFERENCES "public"."interview_assessment_version"("round_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "feedback_review_affected_l2_fk" FOREIGN KEY ("affected_l2_round_id","affected_l2_version_id") REFERENCES "public"."interview_assessment_version"("round_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "feedback_review_applied_l1_fk" FOREIGN KEY ("l1_round_id","applied_l1_version_id") REFERENCES "public"."interview_assessment_version"("round_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback_review" ADD CONSTRAINT "feedback_review_reinstated_l2_fk" FOREIGN KEY ("affected_l2_round_id","reinstated_l2_version_id") REFERENCES "public"."interview_assessment_version"("round_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_review_one_open" ON "interview_feedback_review" USING btree ("drive_id","candidate_id") WHERE "interview_feedback_review"."kind" = 'pass_reversed' and "interview_feedback_review"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "feedback_review_inbox" ON "interview_feedback_review" USING btree ("created_at","id") WHERE ("interview_feedback_review"."kind" = 'pass_reversed' and "interview_feedback_review"."resolved_at" is null) or ("interview_feedback_review"."kind" = 'handoff_updated' and "interview_feedback_review"."read_at" is null);--> statement-breakpoint
ALTER TABLE "interview_event" ADD CONSTRAINT "interview_event_assessment_version_id_interview_assessment_version_id_fk" FOREIGN KEY ("assessment_version_id") REFERENCES "public"."interview_assessment_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_event" ADD CONSTRAINT "interview_event_feedback_review_id_interview_feedback_review_id_fk" FOREIGN KEY ("feedback_review_id") REFERENCES "public"."interview_feedback_review"("id") ON DELETE no action ON UPDATE no action;