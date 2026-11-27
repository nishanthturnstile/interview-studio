CREATE TYPE "public"."interview_code_language" AS ENUM('javascript', 'python', 'java');--> statement-breakpoint
CREATE TYPE "public"."interview_code_run_state" AS ENUM('queued', 'running', 'succeeded', 'compile_error', 'runtime_error', 'timed_out', 'limit_exceeded', 'interrupted');--> statement-breakpoint
CREATE TABLE "interview_code_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"language" "interview_code_language" NOT NULL,
	"source" text NOT NULL,
	"input" text NOT NULL,
	"digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"state" "interview_code_run_state" DEFAULT 'queued' NOT NULL,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"started_at" timestamp with time zone,
	CONSTRAINT "interview_code_run_command" UNIQUE("round_id","command_id")
);
--> statement-breakpoint
ALTER TABLE "interview_round" ADD COLUMN "code_execution_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_code_run" ADD CONSTRAINT "interview_code_run_round_id_interview_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_code_run_unfinished" ON "interview_code_run" USING btree ("round_id") WHERE "interview_code_run"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "interview_code_run_latest" ON "interview_code_run" USING btree ("round_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);