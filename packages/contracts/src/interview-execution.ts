import { z } from "zod";
import { isWorkspaceText } from "./interview-text.ts";

export const codeLanguageSchema = z.enum(["javascript", "python", "java"]);
export type CodeLanguage = z.infer<typeof codeLanguageSchema>;
export const codeLanguages = {
	javascript: {
		label: "JavaScript",
		starter: 'console.log("Hello, world!");\n',
	},
	python: { label: "Python", starter: 'print("Hello, world!")\n' },
	java: {
		label: "Java",
		starter:
			'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, world!");\n    }\n}\n',
	},
} as const;
function programText(maxBytes: number) {
	return z
		.string()
		.max(maxBytes)
		.refine(isWorkspaceText)
		.refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes);
}
export const codeSourceSchema = programText(65_536);
export const codeProgramSchema = z.strictObject({
	language: codeLanguageSchema,
	source: codeSourceSchema,
});
export const codeInputLimit = 8_192;
export const codeOutputLimit = 8_192;
export const codeRunRequestSchema = codeProgramSchema.extend({
	commandId: z.uuid(),
	input: programText(codeInputLimit),
});
export type CodeRunRequest = z.infer<typeof codeRunRequestSchema>;
export const codeRunStateSchema = z.enum([
	"queued",
	"running",
	"succeeded",
	"compile_error",
	"runtime_error",
	"timed_out",
	"limit_exceeded",
	"interrupted",
]);
export const codeRunSummarySchema = z.object({
	id: z.uuid(),
	language: codeLanguageSchema,
	digest: z.string().regex(/^[0-9a-f]{64}$/),
	inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
	state: codeRunStateSchema,
});
export type CodeRunSummary = z.infer<typeof codeRunSummarySchema>;
export const codeRunOutputSchema = codeRunSummarySchema.extend({
	stdout: z.string().max(codeOutputLimit),
	stderr: z.string().max(codeOutputLimit),
});
export type CodeRunOutput = z.infer<typeof codeRunOutputSchema>;
export function codeRunPending(state: CodeRunSummary["state"] | undefined) {
	return state === "queued" || state === "running";
}
