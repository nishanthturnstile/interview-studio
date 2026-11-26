import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { documentBytes } from "@studio/contracts";

const stagingRoot = join(tmpdir(), "interview-studio-intake");

export class SizeLimit extends Error {}

export async function withStagedFile<T>(use: (path: string) => Promise<T>) {
	await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(stagingRoot, "file-"));
	try {
		return await use(join(directory, "original"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function sweepStaging() {
	await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
	const entries = await readdir(stagingRoot, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("file-")) continue;
		const path = join(stagingRoot, entry.name);
		const details = await stat(path).catch(() => undefined);
		if (details && details.mtimeMs < Date.now() - 10 * 60_000) {
			await rm(path, { recursive: true, force: true });
		}
	}
}

export async function writeStagedFile(
	body: ReadableStream<Uint8Array>,
	path: string,
	signal: AbortSignal,
) {
	let size = 0;
	const digest = createHash("sha256");
	const count = new Transform({
		transform(chunk: Buffer, _encoding, next) {
			size += chunk.length;
			if (size > documentBytes) return next(new SizeLimit());
			digest.update(chunk);
			next(null, chunk);
		},
	});
	await pipeline(
		Readable.fromWeb(
			body as import("node:stream/web").ReadableStream<Uint8Array>,
		),
		count,
		createWriteStream(path, { mode: 0o600, flags: "wx" }),
		{ signal },
	);
	return { size, sha256: digest.digest("hex") };
}
