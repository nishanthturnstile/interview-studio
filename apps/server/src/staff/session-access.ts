import { and, eq, sql } from "drizzle-orm";
import { InterviewProblem } from "../interviews/problem.ts";
import type { Transaction } from "../interviews/store.ts";
import { session } from "./auth-schema.ts";

export type StaffSessionIdentity = { userId: string; sessionId: string };

const sessionScope = ({ userId, sessionId }: StaffSessionIdentity) =>
	and(eq(session.id, sessionId), eq(session.userId, userId));
export const staffSessionUnexpired = sql`${session.expiresAt} > clock_timestamp() at time zone 'UTC'`;

export async function lockStaffSession(
	tx: Transaction,
	identity: StaffSessionIdentity,
) {
	const [row] = await tx
		.select({ id: session.id })
		.from(session)
		.where(sessionScope(identity))
		.for("share");
	if (!row) throw new InterviewProblem(401, "unauthenticated");
}

export async function requireStaffSession(
	tx: Transaction,
	identity: StaffSessionIdentity,
) {
	const [row] = await tx
		.select({ id: session.id })
		.from(session)
		.where(and(sessionScope(identity), staffSessionUnexpired));
	if (!row) throw new InterviewProblem(401, "unauthenticated");
}
