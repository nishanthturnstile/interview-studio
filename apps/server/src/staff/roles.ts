import {
	availableStaffGrants,
	type GrantStaffRole,
	type StaffIdentity,
} from "@studio/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "../database.ts";
import { notifyWorkspace } from "../interviews/workspace-signals.ts";
import { user } from "./auth-schema.ts";
import { staffDirectorBootstrap, staffGrant } from "./role-schema.ts";
import { isApprovedEmail } from "./settings.ts";

export async function bootstrapDirector(database: typeof db, userId: string) {
	await database.transaction(async (tx) => {
		const [claim] = await tx
			.insert(staffDirectorBootstrap)
			.values({ id: 1, userId })
			.onConflictDoNothing()
			.returning({ id: staffDirectorBootstrap.id });
		if (claim) {
			await tx.insert(staffGrant).values({ userId, role: "director" });
		}
	});
}

const staffColumns = {
	id: user.id,
	name: user.name,
	email: user.email,
	role: staffGrant.role,
};

function eligibleStaff(database: typeof db, domains: ReadonlySet<string>) {
	return database
		.select(staffColumns)
		.from(user)
		.leftJoin(staffGrant, eq(user.id, staffGrant.userId))
		.where(
			and(
				eq(user.emailVerified, true),
				inArray(sql<string>`split_part(${user.email}, '@', 2)`, [...domains]),
			),
		);
}

export async function getStaff(
	database: Pick<typeof db, "select">,
	userId: string,
	domains: ReadonlySet<string>,
) {
	const [identity] = await database
		.select(staffColumns)
		.from(user)
		.leftJoin(staffGrant, eq(user.id, staffGrant.userId))
		.where(and(eq(user.id, userId), eq(user.emailVerified, true)));
	if (!identity || !isApprovedEmail(identity.email, domains)) return null;
	return {
		...identity,
		role: identity.role ?? "panelist",
	} satisfies StaffIdentity;
}

export async function listStaff(
	database: typeof db,
	domains: ReadonlySet<string>,
): Promise<StaffIdentity[]> {
	const rows = await eligibleStaff(database, domains).orderBy(
		user.name,
		user.id,
	);
	return rows.map((identity) => ({
		...identity,
		role: identity.role ?? "panelist",
	}));
}

export async function grantStaffRole(
	database: typeof db,
	domains: ReadonlySet<string>,
	actorId: string,
	targetId: string,
	role: GrantStaffRole,
) {
	return database.transaction(async (tx) => {
		const [target] = await tx
			.select({ email: user.email, verified: user.emailVerified })
			.from(user)
			.where(eq(user.id, targetId))
			.for("update");
		if (!target?.verified || !isApprovedEmail(target.email, domains))
			return "not_found";
		const [grant] = await tx
			.select({ role: staffGrant.role })
			.from(staffGrant)
			.where(eq(staffGrant.userId, targetId));
		const currentRole = grant?.role ?? "panelist";
		if (currentRole === role) return "granted";
		if (!availableStaffGrants(currentRole).includes(role))
			return "invalid_transition";

		await tx
			.insert(staffGrant)
			.values({ userId: targetId, role, grantedBy: actorId })
			.onConflictDoUpdate({
				target: staffGrant.userId,
				set: { role, grantedBy: actorId, grantedAt: sql`now()` },
			});
		await notifyWorkspace(tx, { staffId: targetId });
		return "granted";
	});
}
