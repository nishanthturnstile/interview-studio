CREATE TABLE "interview_concern" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"observation" text NOT NULL,
	"context" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_concern_command_unique" UNIQUE("round_id","author_id","command_id")
);
--> statement-breakpoint
ALTER TABLE "interview_concern" ADD CONSTRAINT "interview_concern_round_id_interview_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."interview_round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_concern" ADD CONSTRAINT "interview_concern_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;