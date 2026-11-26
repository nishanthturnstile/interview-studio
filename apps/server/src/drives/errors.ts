import type { DriveError } from "@studio/contracts";

export class DriveProblem extends Error {
	readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 429 | 503;
	readonly body: DriveError;
	readonly retryAfter?: number;

	constructor(
		status: DriveProblem["status"],
		error: DriveError["error"],
		details: Omit<DriveError, "error"> = {},
		retryAfter?: number,
	) {
		super(error);
		this.status = status;
		this.body = { error, ...details };
		this.retryAfter = retryAfter;
	}
}
