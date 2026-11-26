import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { wordMediaType } from "@studio/contracts";
import { DriveProblem } from "./errors.ts";
import type { Database } from "./queries.ts";
import { withStagedFile, writeStagedFile } from "./staging.ts";
import { original } from "./uploads.ts";

const exec = promisify(execFile);
const converter = fileURLToPath(
	new URL("./word-preview-child.ts", import.meta.url),
);
let active = 0;

export async function wordPreview(
	database: Database,
	driveId: string,
	documentId: string,
	requestSignal: AbortSignal,
) {
	if (active >= 2) throw new DriveProblem(429, "preview_busy", {}, 2);
	active++;
	try {
		const signal = AbortSignal.any([
			requestSignal,
			AbortSignal.timeout(15_000),
		]);
		const source = await original(
			database,
			driveId,
			documentId,
			signal,
			wordMediaType,
		);
		if (!source.body) throw new DriveProblem(503, "original_missing");
		const body = source.body;
		return await withStagedFile(async (path) => {
			try {
				await writeStagedFile(body, path, signal);
				const { stdout } = await exec(
					process.execPath,
					["--max-old-space-size=160", converter, path],
					{
						env: {},
						signal,
						timeout: 7_000,
						killSignal: "SIGKILL",
						maxBuffer: 12 * 1024 * 1024,
					},
				);
				return new Response(stdout, {
					headers: {
						"Content-Type": "text/plain; charset=utf-8",
						"X-Content-Type-Options": "nosniff",
						"Cache-Control": "private, no-store",
					},
				});
			} catch {
				throw new DriveProblem(422, "preview_unavailable");
			}
		});
	} finally {
		active--;
	}
}
