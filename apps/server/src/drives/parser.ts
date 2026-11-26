import { readFile } from "node:fs/promises";
import {
	type DocumentKind,
	type DocumentMedia,
	wordMediaType,
} from "@studio/contracts";
import mammoth from "mammoth";
import type { TextItem } from "pdfjs-dist/types/src/display/api.d.ts";
import { inspectDocx, ParseLimit } from "./archive.ts";
import { recognizeResume } from "./ocr.ts";
import { maxText } from "./parse-result.ts";
import {
	analyzeOcrPages,
	analyzeResumeFields,
	mergeResumeSuggestions,
} from "./resume-suggestions.ts";

function pdfSeparator(previous: TextItem, next: TextItem) {
	if (previous.dir !== "ltr" || next.dir !== "ltr") return " ";
	// PDF.js can split one visible word across separate text runs. Use
	// position and advance width to keep adjacent runs together.
	const size = Math.max(1, Math.min(previous.height, next.height));
	const baselineChange = Math.abs(next.transform[5] - previous.transform[5]);
	const gap = next.transform[4] - (previous.transform[4] + previous.width);
	if (baselineChange > size * 0.45 || gap > size * 2.5 || gap < -size) {
		return "\n";
	}
	if (/\s$/.test(previous.str) || /^\s/.test(next.str)) return "";
	return gap < size * 0.12 ? "" : " ";
}

async function pdfText(path: string) {
	const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = getDocument({
		data: new Uint8Array(await readFile(path)),
		useSystemFonts: true,
		useWasm: false,
		disableFontFace: true,
		disableAutoFetch: true,
		stopAtErrors: true,
		verbosity: 0,
	});
	try {
		const pdf = await task.promise;
		if (pdf.numPages > 50) throw new ParseLimit();
		const pages: string[] = [];
		let total = 0;
		for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
			let text = "";
			const page = await pdf.getPage(pageIndex);
			const reader = page.streamTextContent().getReader();
			let previous: TextItem | undefined;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					for (const item of chunk.value.items) {
						if (!("str" in item)) continue;
						if (item.str) {
							text += (previous ? pdfSeparator(previous, item) : "") + item.str;
							previous = item;
						}
						if (item.hasEOL) {
							text += "\n";
							previous = undefined;
						}
						if (total + text.length > maxText) throw new ParseLimit();
					}
				}
			} finally {
				await reader.cancel();
				page.cleanup();
			}
			pages.push(text);
			total += text.length + 1;
		}
		return pages;
	} finally {
		await task.destroy();
	}
}

function normalizeText(raw: string) {
	return raw
		.normalize("NFC")
		.replace(/\r\n?/g, "\n")
		.replace(/\p{Cc}/gu, (character) =>
			character === "\n" || character === "\t" ? character : "",
		)
		.trim();
}

export async function extractDocument(
	path: string,
	media: DocumentMedia,
	kind: DocumentKind = "resume",
) {
	// Leave time to serialize the result before the worker kills the parser.
	const deadline = performance.now() + 13_000;
	try {
		let raw = "";
		let pages: string[] | undefined;
		if (media === "application/pdf") {
			pages = (await pdfText(path)).map(normalizeText);
			raw = pages.join("\n");
		} else if (media === wordMediaType) {
			await inspectDocx(path, true);
			// Raw-text extraction uses Mammoth’s default of disabled external file access.
			raw = (await mammoth.extractRawText({ buffer: await readFile(path) }))
				.value;
		}
		if (raw.length > maxText) throw new ParseLimit();
		const text = normalizeText(raw);
		if (text.length > maxText) throw new ParseLimit();
		const native = analyzeResumeFields(text);
		const suggestions = native.suggestions;
		let limited = false;
		if (
			kind === "resume" &&
			(suggestions.name === undefined ||
				suggestions.email === undefined ||
				suggestions.years === undefined)
		) {
			const result = await recognizeResume(path, media, pages, deadline).catch(
				() => ({
					pages: [],
					limited: false,
					recoveredScanText: false,
				}),
			);
			limited = result.limited;
			const separator = text ? "\n\nOCR text\n\n" : "";
			let remaining = maxText - text.length - separator.length;
			const recognized: string[] = [];
			for (const page of result.pages) {
				if (remaining <= 0) break;
				const recovered = normalizeText(page).slice(0, remaining);
				if (!recovered) continue;
				recognized.push(recovered);
				remaining -= recovered.length + 2;
			}
			if (recognized.length) {
				const ocr = analyzeOcrPages(recognized);
				const merged = text
					? mergeResumeSuggestions(native, ocr)
					: { suggestions: ocr.suggestions, added: true };
				if (merged.added || result.recoveredScanText) {
					return {
						status: "succeeded",
						text: text + separator + recognized.join("\n\n"),
						suggestions: merged.suggestions,
						usedOcr: true,
					} as const;
				}
			}
		}
		if (!text)
			return {
				status: "needs_manual_review",
				reason: limited ? "resource_limit" : "scan_only",
			} as const;
		return {
			status: "succeeded",
			text,
			suggestions,
			usedOcr: false,
		} as const;
	} catch (error) {
		return {
			status: "needs_manual_review",
			reason:
				error instanceof ParseLimit ? "resource_limit" : "invalid_document",
		} as const;
	}
}
