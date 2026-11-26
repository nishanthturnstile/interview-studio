import type { InterviewError } from "@studio/contracts";

export class InterviewProblem extends Error {
	constructor(
		status: InterviewProblem["status"],
		error: InterviewError["error"],
		details: Omit<InterviewError, "error"> = {},
	) {
		super(error);
		this.status = status;
		this.body = { error, ...details };
	}

	readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;
	readonly body: InterviewError;
}
