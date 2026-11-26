import { staffRoles } from "@studio/contracts";
import { sql } from "drizzle-orm";
import {
	check,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";

export const staffRoleEnum = pgEnum("staff_role", staffRoles);

export const staffGrant = pgTable("staff_grant", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id),
	role: staffRoleEnum().notNull(),
	grantedBy: text("granted_by").references(() => user.id),
	grantedAt: timestamp("granted_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const staffDirectorBootstrap = pgTable(
	"staff_director_bootstrap",
	{
		id: integer().primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id),
	},
	(table) => [
		check("staff_director_bootstrap_singleton", sql`${table.id} = 1`),
	],
);
