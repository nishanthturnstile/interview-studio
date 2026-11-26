import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { type DocumentMedia, wordMediaType } from "@studio/contracts";
import { docxScanImages, ParseLimit } from "./archive.ts";
import { maxText } from "./parse-result.ts";

const exec = promisify(execFile);
const imageLimit = 3;
const rasterSize = 2200;

export async function recognizeResume(
	path: string,
	media: DocumentMedia,
	pages: string[] | undefined,
	parserDeadline: number,
) {
	const deadline = Math.min(performance.now() + 9_000, parserDeadline);
	let limited = false;
	let recoveredScanText = false;
	const recognized: { index: number; text: string }[] = [];

	async function run(
		command: string,
		args: string[],
		ms: number,
		maxBuffer: number,
		stdin?: Buffer,
	) {
		const remaining = Math.floor(Math.min(ms, deadline - performance.now()));
		if (remaining <= 0) {
			limited = true;
			return undefined;
		}
		try {
			// These limits also apply if the worker terminates the Node parser.
			const child = exec(
				"/usr/bin/timeout",
				[
					"--signal=KILL",
					`${remaining / 1000}s`,
					"/usr/bin/prlimit",
					"--as=268435456",
					"--",
					command,
					...args,
				],
				{
					encoding: "buffer",
					env: { LANG: "C.UTF-8", OMP_THREAD_LIMIT: "1" },
					killSignal: "SIGKILL",
					maxBuffer,
					timeout: remaining + 250,
				},
			);
			child.child.stdin?.on("error", () => undefined);
			child.child.stdin?.end(stdin);
			return (await child).stdout;
		} catch (error) {
			const failure = error as { code?: string | number; signal?: string };
			limited ||=
				failure.signal === "SIGKILL" ||
				failure.code === 137 ||
				failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
			return undefined;
		}
	}

	async function recognize(image: Buffer, index: number) {
		const bytes = await run(
			"/usr/bin/tesseract",
			["stdin", "stdout", "-l", "eng", "--oem", "1", "--psm", "3"],
			4_000,
			maxText * 4,
			image,
		);
		if (bytes?.length) {
			const text = bytes.toString("utf8");
			recoveredScanText ||=
				(!pages || pages[index].length < 80) && /\p{L}{2}/u.test(text);
			recognized.push({ index, text });
		}
	}

	if (pages) {
		const order = pages
			.map((text, index) => ({ index, sparse: text.length < 80 }))
			.sort((left, right) => Number(right.sparse) - Number(left.sparse));
		for (const { index } of order.slice(0, imageLimit)) {
			const page = String(index + 1);
			const image = await run(
				"/usr/bin/pdftoppm",
				[
					"-f",
					page,
					"-l",
					page,
					"-singlefile",
					"-scale-to",
					String(rasterSize),
					"-gray",
					path,
				],
				2_500,
				5 * 1024 * 1024,
			);
			if (image?.length) await recognize(image, index);
			if (performance.now() >= deadline) break;
		}
	} else if (media === wordMediaType) {
		let index = 0;
		try {
			for await (const image of docxScanImages(path, imageLimit)) {
				await recognize(image, index++);
				if (performance.now() >= deadline) break;
			}
		} catch (error) {
			if (!(error instanceof ParseLimit)) throw error;
			limited = true;
		}
	} else {
		await recognize(await readFile(path), 0);
	}
	recognized.sort((left, right) => left.index - right.index);
	return {
		pages: recognized.map(({ text }) => text),
		limited,
		recoveredScanText,
	};
}
