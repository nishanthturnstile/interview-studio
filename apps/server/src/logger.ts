import pino from "pino";

export const logger = pino();

export function errorClass(error: unknown) {
	return error instanceof Error ? error.name : "UnknownError";
}
