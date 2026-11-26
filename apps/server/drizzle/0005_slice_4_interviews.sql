CREATE TYPE "public"."interview_challenge_phase" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."interview_state" AS ENUM('scheduled', 'active', 'awaiting_feedback', 'cancelled', 'no_show', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."interview_absent_party" AS ENUM('candidate', 'panelist', 'both');--> statement-breakpoint
CREATE TABLE "interview_attendance" (
	"round_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"experience_tenths" integer,
	"confirmed_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interview_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invitation_id" uuid NOT NULL,
	"code_digest" text NOT NULL,
	"phase" "interview_challenge_phase" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 5 NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "interview_challenge_attempts" CHECK ("interview_challenge"."attempts" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "interview_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"round_id" uuid,
	"actor" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_invitation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"round_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "interview_invitation_generation" UNIQUE("round_id","generation"),
	CONSTRAINT "interview_invitation_scope" UNIQUE("round_id","id")
);
--> statement-breakpoint
CREATE TABLE "interview_preference" (
	"staff_id" text PRIMARY KEY NOT NULL,
	"time_zone" text NOT NULL,
	"duration" integer NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "interview_preference_duration" CHECK ("interview_preference"."duration" between 5 and 480)
);
--> statement-breakpoint
CREATE TABLE "interview_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_receipt" (
	"actor" text NOT NULL,
	"actor_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_receipt_actor_actor_id_command_id_pk" PRIMARY KEY("actor","actor_id","command_id")
);
--> statement-breakpoint
CREATE TABLE "interview_round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"level" "drive_round" NOT NULL,
	"attempt" integer NOT NULL,
	"panelist_id" text NOT NULL,
	"invited_email" text NOT NULL,
	"candidate_name" text NOT NULL,
	"experience_tenths" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"duration" integer NOT NULL,
	"meeting" jsonb NOT NULL,
	"state" "interview_state" DEFAULT 'scheduled' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_by" text,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"reason" text,
	"absent" "interview_absent_party",
	CONSTRAINT "interview_round_attempt" UNIQUE("drive_id","candidate_id","level","attempt"),
	CONSTRAINT "interview_round_slot" CHECK ("interview_round"."duration" between 5 and 480 and "interview_round"."ends_at" = "interview_round"."starts_at" + "interview_round"."duration" * interval '1 minute'),
	CONSTRAINT "interview_round_attempt_positive" CHECK ("interview_round"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "interview_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "interview_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "interview_withdrawal" (
	"drive_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"staff_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "interview_withdrawal_drive_id_candidate_id_pk" PRIMARY KEY("drive_id","candidate_id")
);
--> statement-breakpoint
ALTER TABLE "interview_attendance" ADD CONSTRAINT "interview_attendance_round_id_interview_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_challenge" ADD CONSTRAINT "interview_challenge_invitation_id_interview_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."interview_invitation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_event" ADD CONSTRAINT "interview_event_round_id_interview_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_event" ADD CONSTRAINT "interview_event_candidacy_fk" FOREIGN KEY ("drive_id","candidate_id") REFERENCES "public"."drive_candidate"("drive_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_invitation" ADD CONSTRAINT "interview_invitation_round_id_interview_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_preference" ADD CONSTRAINT "interview_preference_staff_id_user_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_round" ADD CONSTRAINT "interview_round_panelist_id_user_id_fk" FOREIGN KEY ("panelist_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_round" ADD CONSTRAINT "interview_round_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_round" ADD CONSTRAINT "interview_round_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_round" ADD CONSTRAINT "interview_round_candidacy_fk" FOREIGN KEY ("drive_id","candidate_id") REFERENCES "public"."drive_candidate"("drive_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_invitation_fk" FOREIGN KEY ("round_id","invitation_id") REFERENCES "public"."interview_invitation"("round_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_withdrawal" ADD CONSTRAINT "interview_withdrawal_staff_id_user_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_withdrawal" ADD CONSTRAINT "interview_withdrawal_candidacy_fk" FOREIGN KEY ("drive_id","candidate_id") REFERENCES "public"."drive_candidate"("drive_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_challenge_budget" ON "interview_challenge" USING btree ("invitation_id","created_at");--> statement-breakpoint
CREATE INDEX "interview_challenge_expiry" ON "interview_challenge" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_challenge_current" ON "interview_challenge" USING btree ("invitation_id") WHERE "interview_challenge"."revoked_at" is null and "interview_challenge"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "interview_event_round" ON "interview_event" USING btree ("round_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_invitation_current" ON "interview_invitation" USING btree ("round_id") WHERE "interview_invitation"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_round_unresolved" ON "interview_round" USING btree ("drive_id","candidate_id","level") WHERE "interview_round"."state" in ('scheduled', 'active', 'awaiting_feedback');--> statement-breakpoint
CREATE INDEX "interview_round_panelist_time" ON "interview_round" USING btree ("panelist_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "interview_round_email_time" ON "interview_round" USING btree ("invited_email","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_session_current" ON "interview_session" USING btree ("round_id") WHERE "interview_session"."revoked_at" is null;