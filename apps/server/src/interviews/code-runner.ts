import { codeOutputLimit } from "@studio/contracts";
import { z } from "zod";
import type { CodeRunner, CodeRunResult } from "./code-runs.ts";

const java = "/usr/local/temurin/bin";
const javaArchive = "program.jar";
const archiveLimit = 512 * 1024;
const env = ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "HOME=/tmp"];
const memory = 256 * 1024 * 1024;
const second = 1_000_000_000;
const collector = (name: string) => ({
	name,
	max: codeOutputLimit,
	pipe: true,
});
const reply = z
	.array(
		z.object({
			status: z.string(),
			files: z
				.object({
					stdout: z.string().optional(),
					stderr: z.string().optional(),
				})
				.optional(),
			fileIds: z
				.object({
					[javaArchive]: z
						.string()
						.regex(/^[\w-]+$/)
						.optional(),
				})
				.optional(),
		}),
	)
	.length(1);
type RunnerReply = z.infer<typeof reply>[number];
type SandboxFile = { content: string } | { fileId: string };

export class RunnerRequestError extends Error {
	readonly name = "RunnerRequestError";
	readonly status: number;
	constructor(status: number) {
		super("Runner request failed");
		this.status = status;
	}
}

function command(
	args: string[],
	input: string,
	copyIn: Record<string, SandboxFile>,
	compile = false,
) {
	return {
		args,
		env,
		files: [{ content: input }, collector("stdout"), collector("stderr")],
		cpuLimit: (compile ? 5 : 2) * second,
		clockLimit: (compile ? 7 : 3) * second,
		memoryLimit: memory,
		procLimit: 32,
		copyIn,
		...(compile && {
			copyOutCached: [`${javaArchive}?`],
			copyOutMax: archiveLimit,
		}),
	};
}

const statuses: Record<string, CodeRunResult["state"]> = {
	Accepted: "succeeded",
	"Time Limit Exceeded": "timed_out",
	"Memory Limit Exceeded": "limit_exceeded",
	"Output Limit Exceeded": "limit_exceeded",
	"Nonzero Exit Status": "runtime_error",
	"Non Zero Exit Status": "runtime_error",
	Signalled: "runtime_error",
	"Dangerous Syscall": "runtime_error",
};

function result(response: RunnerReply, compile = false): CodeRunResult {
	const state = statuses[response.status];
	if (!state) throw new Error("Runner infrastructure failure");
	return {
		state: compile && state === "runtime_error" ? "compile_error" : state,
		stdout: boundedOutput(response.files?.stdout),
		stderr: boundedOutput(response.files?.stderr),
	};
}

function boundedOutput(text = "") {
	const bytes = new TextEncoder().encode(text);
	return new TextDecoder()
		.decode(bytes.subarray(0, codeOutputLimit), { stream: true })
		.replaceAll("\0", "");
}

async function readResponse(response: Response) {
	const reader = response.body?.getReader();
	if (!response.ok || !reader) {
		await reader?.cancel();
		throw new RunnerRequestError(response.status);
	}
	const decoder = new TextDecoder();
	let body = "";
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done)
				return reply.parse(JSON.parse(body + decoder.decode()))[0];
			bytes += chunk.value.byteLength;
			if (bytes > 128 * 1024) throw new Error("Runner response too large");
			body += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function createCodeRunner(endpoint: URL, token: string): CodeRunner {
	const headers = { authorization: `Bearer ${token}` };
	async function dispatch(cmd: ReturnType<typeof command>) {
		return readResponse(
			await fetch(new URL("/run", endpoint), {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ cmd: [cmd] }),
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			}),
		);
	}
	return async ({ language, source, input }) => {
		if (language === "javascript") {
			return result(
				await dispatch(
					command(
						["/usr/local/bin/node", "--max-old-space-size=128", "main.js"],
						input,
						{ "main.js": { content: source } },
					),
				),
			);
		}
		if (language === "python") {
			return result(
				await dispatch(
					command(["/usr/local/bin/python3", "-I", "-B", "main.py"], input, {
						"main.py": { content: source },
					}),
				),
			);
		}
		const compiled = await dispatch(
			command(
				[
					"/bin/sh",
					"-ec",
					`mkdir classes && ${java}/javac -J-Xmx128m -J-XX:ActiveProcessorCount=2 -proc:none -d classes Main.java && ${java}/jar -J-Xmx64m -J-XX:ActiveProcessorCount=2 -c -C classes . > ${javaArchive}`,
				],
				"",
				{ "Main.java": { content: source } },
				true,
			),
		);
		const fileId = compiled.fileIds?.[javaArchive];
		try {
			const compilation = result(compiled, true);
			if (compilation.state !== "succeeded") return compilation;
			if (!fileId) throw new Error("Runner returned no compiled program");
			return result(
				await dispatch(
					command(
						[
							`${java}/java`,
							"-Xmx128m",
							"-XX:ActiveProcessorCount=2",
							"-cp",
							javaArchive,
							"Main",
						],
						input,
						{ [javaArchive]: { fileId } },
					),
				),
			);
		} finally {
			if (fileId) {
				await fetch(new URL(`/file/${fileId}`, endpoint), {
					method: "DELETE",
					headers,
					redirect: "error",
					signal: AbortSignal.timeout(2_000),
				})
					.then((response) => response.body?.cancel())
					.catch(() => {});
			}
		}
	};
}

export function configuredCodeRunner(env: NodeJS.ProcessEnv) {
	if (env.STUDIO_CODE_EXECUTION_ENABLED !== "true") return;
	const endpoint = URL.parse(env.STUDIO_GO_JUDGE_URL ?? "");
	const token = env.STUDIO_GO_JUDGE_TOKEN;
	if (
		!endpoint ||
		!["http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password ||
		!token ||
		token.length < 32
	)
		return;
	return createCodeRunner(endpoint, token);
}
