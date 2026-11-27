import { candidateToken } from "./candidate-access.ts";
import { InterviewProblem } from "./problem.ts";

export function createWorkspaceSaveGate() {
	const inFlight = new Map<string, number>();
	const recent = new Map<string, number>();
	let total = 0;
	return async function withSaveSlot<T>(
		token: string | undefined,
		scope: string,
		save: () => Promise<T>,
	) {
		const identity = candidateToken(token);
		const key = `${identity}:${scope}`;
		const now = performance.now();
		const pending = inFlight.get(identity) ?? 0;
		if (
			total >= 16 ||
			pending >= 2 ||
			(recent.get(key) ?? -Infinity) + 150 > now
		)
			throw new InterviewProblem(429, "rate_limited", { retryAfter: 1 });
		inFlight.set(identity, pending + 1);
		total++;
		try {
			const result = await save();
			recent.delete(key);
			recent.set(key, performance.now());
			if (recent.size > 512) {
				const oldest = recent.keys().next();
				if (!oldest.done) recent.delete(oldest.value);
			}
			return result;
		} finally {
			const current = inFlight.get(identity) ?? 1;
			if (current === 1) inFlight.delete(identity);
			else inFlight.set(identity, current - 1);
			total--;
		}
	};
}
