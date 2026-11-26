import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const workerHeartbeat = pgTable("worker_heartbeat", {
	name: text().primaryKey(),
	seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
});

export const smokeFixture = pgTable("smoke_fixture", {
	key: text().primaryKey(),
	sha256: text().notNull(),
});

export * from "./drives/schema.ts";
export * from "./staff/auth-schema.ts";
export * from "./staff/role-schema.ts";
