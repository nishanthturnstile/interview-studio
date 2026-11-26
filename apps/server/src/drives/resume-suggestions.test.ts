import { describe, expect, it } from "vite-plus/test";
import {
	analyzeOcrPages,
	analyzeResumeFields,
	mergeResumeSuggestions,
	suggestResumeFields,
} from "./resume-suggestions.ts";

describe("resume suggestions", () => {
	it("recognizes an unlabeled name and a total in prose", () => {
		expect(
			suggestResumeFields(`
			CURRICULUM VITAE
			Amélie D'Costa
			Senior Software Engineer
			amelie.d@example.test
			Backend engineer with 9 years and 6 months of
			professional experience building reliable services.
		`),
		).toEqual({
			name: "Amélie D'Costa",
			email: "amelie.d@example.test",
			years: 9.5,
		});
	});

	it("finds contact and experience fields outside the header", () => {
		expect(
			suggestResumeFields(`
			Technical Profile
			Skills
			Java, Azure and Docker
			Contact details
			Full Name
			María de la Cruz
			Primary email:
			MARIA.Example@Example.test
			Total work experience — １０ yrs
			References
			Name: A Reference
			Email: other@example.test
		`),
		).toEqual({
			name: "María de la Cruz",
			email: "maria.example@example.test",
			years: 10,
		});
	});

	it("recognizes inline labels and prioritizes explicit overall experience", () => {
		expect(
			suggestResumeFields(`
			Full name: Noor Ahmed | Email: noor@example.test
			Overall Exp. 10.5 yrs
			Experience: 3 years
			Worked in Azure for 2 years.
		`),
		).toEqual({ name: "Noor Ahmed", email: "noor@example.test", years: 10.5 });
	});

	it("supports names from uncased scripts and accepts repeated matching values", () => {
		expect(
			suggestResumeFields(`
			张伟
			Software Engineer
			zhang@example.test
			Years of experience: 8 years
			Experience: 8
			zhang@example.test
		`),
		).toEqual({ name: "张伟", email: "zhang@example.test", years: 8 });
	});

	it("leaves conflicting names, contact details, and totals for the reviewer", () => {
		expect(
			suggestResumeFields(`
			Name: Jane Doe | Email: jane@example.test
			Name: Jane Smith | Email: smith@example.test
			Total experience: 8 years
			Total experience: 11 years
		`),
		).toEqual({});
	});

	it("handles a trailing comma in a name without dropping other fields", () => {
		expect(
			suggestResumeFields("Maya Rao,\nmaya@example.test\nYoE: 10"),
		).toMatchObject({
			email: "maya@example.test",
			years: 10,
		});
	});

	it("distinguishes qualified overall experience from skill-specific experience", () => {
		expect(
			suggestResumeFields(
				"Total IT experience: 8 years 6 months, including Azure",
			).years,
		).toBe(8.5);
		expect(
			suggestResumeFields(
				"Professional experience: 8 years in software engineering",
			).years,
		).toBe(8);
		expect(
			suggestResumeFields("Experience: 8 years in Java").years,
		).toBeUndefined();
	});

	it("does not pick a referee's details", () => {
		expect(
			suggestResumeFields(`
			Professional Summary
			Built microservices.
			Professional References:
			Name: Jamie Doe
			Email: jamie@example.test
			12 years of experience in publishing
		`),
		).toEqual({});
	});

	it.each([
		["Experience (years): 10", 10],
		["Cumulative experience: 8y6m", 8.5],
		["Overall experience: 8 years + 6 months", 8.5],
		["Total experience: Eight years and six months", 8.5],
		["Years of professional experience: 10,5", 10.5],
		["Industry experience: 144 months", 12],
		["Backend engineer with 8.5 YOE", 8.5],
		["Backend engineer with 8½ years of experience", 8.5],
		["Backend engineer with 8 1/2 years of experience", 8.5],
		["A decade of professional experience in software development", 10],
	])("recognizes %s", (value, years) => {
		expect(suggestResumeFields(value).years).toBe(years);
	});

	it.each([
		"Experience: 8+ years",
		"Over 8 years of experience",
		"8 to 12 years of experience",
		"8–12 years of experience",
		"At least 8 years of experience",
		"6 years of experience in Java",
		"Role requires 8 years of experience",
		"Employment history: Jan 2016 - Dec 2025",
		"4 years of experience and 6 years of experience",
		"Overall experience: 8 years+",
	])("leaves uncertain totals blank for %s", (value) => {
		expect(suggestResumeFields(value).years).toBeUndefined();
	});

	it("marks conflicting and approximate fields so OCR cannot replace them", () => {
		const result = analyzeResumeFields(
			"Candidate Name: Ava Roy\nCandidate Name: Eva Roy\nAva@example.test\nEva@example.test\nTotal experience: 8+ years",
		);
		expect(result.suggestions).toEqual({});
		expect(result.ambiguous).toEqual(new Set(["name", "email", "years"]));
	});

	it.each([
		"I have Eight to Twelve years of experience",
		"Roughly 8 years of experience",
		"Approx. 8 years of experience",
		"Eight-plus years of experience",
		"8+ years of relevant experience",
		"8 yrs+ experience",
		"8 years or more of experience",
		"Experience: 8 years to 12 years",
		"8/12 years of experience",
	])("preserves the uncertainty of %s", (value) => {
		const native = analyzeResumeFields(value);
		expect(native.suggestions.years).toBeUndefined();
		expect(native.ambiguous.has("years")).toBe(true);
		expect(
			mergeResumeSuggestions(native, analyzeResumeFields("Experience: 8"))
				.suggestions.years,
		).toBeUndefined();
	});

	it("fills only missing fields when the native and OCR identities agree", () => {
		const native = analyzeResumeFields("Name: Alex Roy\nExperience: 8");
		const ocr = analyzeResumeFields(
			"Name: ALEX ROY\nEmail: alex@example.test\nExperience: 9",
		);
		expect(mergeResumeSuggestions(native, ocr).suggestions).toEqual({
			name: "Alex Roy",
			email: "alex@example.test",
			years: 8,
		});
	});

	it("does not mix candidate fields when OCR sees a different person", () => {
		const native = analyzeResumeFields("Name: Alex Roy");
		const ocr = analyzeResumeFields(
			"Name: Bailey Roy\nEmail: bailey@example.test\nExperience: 10",
		);
		expect(mergeResumeSuggestions(native, ocr).suggestions).toEqual({
			name: "Alex Roy",
		});
	});

	it("checks each OCR page for overlapping candidate identities", () => {
		const ocr = analyzeOcrPages([
			"Name: Alex Roy\nCandidate summary",
			"LEENA VARMA\nBackend engineer\nEmail: leena@example.test\nExperience: 8.5",
		]);
		expect(ocr.suggestions).toEqual({});
		expect(ocr.ambiguous.has("name")).toBe(true);
		expect(
			mergeResumeSuggestions(analyzeResumeFields("Name: Alex Roy"), ocr)
				.suggestions,
		).toEqual({ name: "Alex Roy" });
	});
});
