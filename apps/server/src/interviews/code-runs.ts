import {
	type CodeRunOutput,
	type CodeRunRequest,
	type CodeRunSummary,
	codeRunPending,
} from "@studio/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { InterviewProblem } from "./problem.ts";
import { interviewRound, interviewCodeRun as run } from "./schema.ts";
import { type Database, hash, type Transaction } from "./store.ts";

export const codeRunQueue = "interview-code-run";

const summary = {
	id: run.id,
	language: run.language,
	digest: run.digest,
	inputDigest: run.inputDigest,
	state: run.state,
};

export async function latestCodeRun(tx: Transaction, roundId: string) {
	const [latest] = await tx
		.select(summary)
		.from(run)
		.where(eq(run.roundId, roundId))
		.orderBy(desc(run.createdAt), desc(run.id))
		.limit(1);
	return latest;
}

export async function readCodeRun(
	tx: Transaction,
	roundId: string,
	runId: string,
) {
	const [output] = await tx
		.select({ ...summary, stdout: run.stdout, stderr: run.stderr })
		.from(run)
		.where(and(eq(run.id, runId), eq(run.roundId, roundId)));
	if (!output) throw new InterviewProblem(409, "code_run_unavailable");
	return output;
}

export async function queueCodeRun(
	tx: Transaction,
	boss: Pick<PgBoss, "send">,
	roundId: string,
	enabled: boolean,
	command: CodeRunRequest,
): Promise<CodeRunSummary> {
	const { commandId, language, source, input } = command;
	const digest = hash(source);
	const inputDigest = hash(input);
	const [previous] = await tx
		.select(summary)
		.from(run)
		.where(and(eq(run.roundId, roundId), eq(run.commandId, commandId)));
	if (previous) {
		if (
			previous.language !== language ||
			previous.digest !== digest ||
			previous.inputDigest !== inputDigest
		)
			throw new InterviewProblem(409, "idempotency_conflict");
		return previous;
	}
	if (!enabled) throw new InterviewProblem(409, "code_run_disabled");
	const [queued] = await tx
		.insert(run)
		.values({
			roundId,
			commandId,
			language,
			source,
			input,
			digest,
			inputDigest,
		})
		.onConflictDoNothing()
		.returning(summary);
	if (!queued) throw new InterviewProblem(409, "code_run_pending");
	const job = await boss.send(
		codeRunQueue,
		{ runId: queued.id, roundId },
		{ id: queued.id, db: fromDrizzle(tx, sql) },
	);
	if (!job) throw new InterviewProblem(503, "code_run_unavailable");
	return queued;
}

export type CodeRunResult = Pick<CodeRunOutput, "stdout" | "stderr"> & {
	state: Exclude<CodeRunSummary["state"], "queued" | "running">;
};
export type CodeRunner = (
	program: Pick<CodeRunRequest, "language" | "source" | "input">,
) => Promise<CodeRunResult>;
export const interruptedRun = {
	state: "interrupted",
	stdout: "",
	stderr: "",
} satisfies CodeRunResult;

export async function processCodeRun(
	db: Database,
	roundId: string,
	runId: string,
	execute: CodeRunner | undefined,
) {
	const program = await db.transaction(async (tx) => {
		const [round] = await tx
			.select({
				state: interviewRound.state,
				enabled: interviewRound.codeExecutionEnabled,
			})
			.from(interviewRound)
			.where(eq(interviewRound.id, roundId))
			.for("update");
		const [saved] = await tx
			.select({
				language: run.language,
				source: run.source,
				input: run.input,
				state: run.state,
			})
			.from(run)
			.where(and(eq(run.id, runId), eq(run.roundId, roundId)))
			.for("update");
		if (!saved || !codeRunPending(saved.state)) return;
		if (
			saved.state === "running" ||
			round?.state !== "active" ||
			!round.enabled ||
			!execute
		) {
			await tx.update(run).set(interruptedRun).where(eq(run.id, runId));
			return;
		}
		await tx
			.update(run)
			.set({ state: "running", startedAt: sql`clock_timestamp()` })
			.where(eq(run.id, runId));
		return saved;
	});
	if (!program || !execute) return;

	const result = await execute(program).catch(() => interruptedRun);
	await db
		.update(run)
		.set(result)
		.where(and(eq(run.id, runId), eq(run.state, "running")));
}

export async function expireCodeRuns(db: Database) {
	await db
		.update(run)
		.set(interruptedRun)
		.where(
			and(
				inArray(run.state, ["queued", "running"]),
				sql`case when ${run.state} = 'running' then ${run.startedAt} < now() - interval '1 minute'
			else ${run.createdAt} < now() - interval '2 minutes' end`,
			),
		);
}
