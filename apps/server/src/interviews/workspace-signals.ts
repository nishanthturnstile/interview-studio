import type { ArtifactKind } from "@studio/contracts";
import { sql } from "drizzle-orm";
import type { Transaction } from "./store.ts";

export const workspaceChannel = "studio_interview_workspace";

export type WorkspaceSignal =
	| { roundId: string; kind: ArtifactKind; sequence: number }
	| { roundId: string }
	| { staffId: string };

export async function notifyWorkspace(
	tx: Transaction,
	signal: WorkspaceSignal,
) {
	await tx.execute(
		sql`select pg_notify(${workspaceChannel}, ${JSON.stringify(signal)})`,
	);
}
