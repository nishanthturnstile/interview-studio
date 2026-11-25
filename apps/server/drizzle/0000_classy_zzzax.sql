CREATE TABLE "smoke_fixture" (
	"key" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"name" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
