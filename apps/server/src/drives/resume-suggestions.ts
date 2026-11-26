import {
	type CandidateFields,
	candidateEmailSchema,
	candidateFieldsSchema,
} from "@studio/contracts";

const emailPattern =
	/(?<![\w.!#$%&'*+/=?^`{|}~-])[\w.!#$%&'*+/=?^`{|}~-]{1,64}@[a-z\d](?:[a-z\d-]{0,62}\.)+(?:[a-z]{2,63})(?![\w-])/gi;
const referenceHeading =
	/^(?:professional\s+)?(?:references?|referees)(?=$|\s*[:\-–—])/i;
const resumeHeading =
	/^(?:(?:professional\s+)?(?:experience|summary)|(?:employment|work|career)\s+history|(?:contact|personal)\s+details|education|certifications|skills|projects|publications|awards)(?:\s*[:\-–—])?$/i;
const documentTitle = /^(?:curriculum vitae|c\.?v\.?|r[eé]sum[eé])$/i;
const nameLabel =
	/^(?:(?:(?:candidate|full|legal|preferred)\s+name)(?=\s|[:\-–—]|$)\s*[:\-–—]?|name(?:\s*[:\-–—]|$))\s*(.*)$/iu;
const candidateContact =
	/^(?:candidate|personal|primary)\s+(?:e-?mail(?:\s+(?:address|id))?)\s*[:\-–—]?/i;
const emailLabel = /^(?:e-?mail(?:\s+(?:address|id))?)\s*[:\-–—]?/i;
const outsideContact =
	/\b(?:refer(?:ence|ee)|recruiter|supervisor|employer|manager)(?:['’]s)?\s+(?:e-?mail|contact)\b/i;
const nameWords =
	/\b(?:curriculum|vitae|resume|profile|summary|experience|education|contact|details|developer|engineer|engineering|designer|software|manager|specialist|consultant|architect|analyst|senior|skills|certified|references|portfolio|technologies|professional)\b/i;
const nameParticle = /^(?:al|bin|da|de|del|der|di|dos|du|el|la|le|van|von)$/i;
const vulgarFractions: Record<string, number> = {
	"¼": 0.25,
	"½": 0.5,
	"¾": 0.75,
};

function usableLines(text: string) {
	let inReferences = false;
	const lines = [];
	for (const raw of text
		.replace(
			/(?:([0-9０-９]+)[ \t]*)?([¼½¾])/gu,
			(_, whole: string | undefined, fraction: string) =>
				String(
					Number(whole?.normalize("NFKC") ?? 0) + vulgarFractions[fraction],
				),
		)
		.normalize("NFKC")
		.replace(/[\u00ad\u200b\ufeff]/g, "")
		.split(/\r?\n/)) {
		const line = raw
			.trim()
			.replace(/^[•▪]\s*/, "")
			.replace(/\s+/g, " ");
		if (!line) continue;
		if (referenceHeading.test(line)) inReferences = true;
		else if (resumeHeading.test(line)) inReferences = false;
		if (!inReferences) lines.push(line);
	}
	return lines;
}

type ResumeField = keyof CandidateFields;

function only<T>(
	values: Set<T>,
	field: ResumeField,
	ambiguous: Set<ResumeField>,
) {
	if (values.size > 1) ambiguous.add(field);
	return values.size === 1 ? values.values().next().value : undefined;
}

function emailsIn(line: string) {
	if (!line.includes("@")) return [];
	return [...line.matchAll(emailPattern)].flatMap(([value]) => {
		const email = candidateEmailSchema.safeParse(value);
		return email.success ? [email.data] : [];
	});
}

function suggestedEmail(lines: string[], ambiguous: Set<ResumeField>) {
	const primary = new Set<string>();
	const labelled = new Set<string>();
	const others = new Set<string>();
	for (const [index, line] of lines.entries()) {
		for (const part of line.split(/\s*[|•;]\s*/)) {
			if (outsideContact.test(part)) continue;
			const label = candidateContact.test(part)
				? candidateContact
				: emailLabel.test(part)
					? emailLabel
					: undefined;
			let emails = emailsIn(part);
			if (
				!emails.length &&
				label &&
				!part.replace(label, "").trim() &&
				lines[index + 1]
			) {
				emails = emailsIn(lines[index + 1]);
			}
			for (const email of emails) {
				others.add(email);
				if (label) (label === candidateContact ? primary : labelled).add(email);
			}
		}
	}
	return only(
		primary.size ? primary : labelled.size ? labelled : others,
		"email",
		ambiguous,
	);
}

function cleanName(value: string) {
	if (
		value.length > 120 ||
		!/^\p{L}(?:\u200c|\u200d|[\p{L}\p{M}.’' ,\p{Pd}])*$/u.test(value)
	)
		return undefined;
	if (value.split(",").length > 2) return undefined;
	return value.trim();
}

function headerName(line: string, emailNearby: boolean) {
	const value = cleanName(line);
	if (!value || nameWords.test(value) || documentTitle.test(value))
		return undefined;
	if (emailNearby && /^\p{Script=Han}{2,6}$/u.test(value)) return value;
	const words = value.split(/[ ,]+/).filter(Boolean);
	if (words.length < 2 || words.length > 6) return undefined;
	if (
		words.some(
			(word) =>
				!nameParticle.test(word) &&
				word[0] === word[0].toLowerCase() &&
				word[0] !== word[0].toUpperCase(),
		)
	) {
		return undefined;
	}
	return value;
}

function suggestedName(
	lines: string[],
	email: string | undefined,
	ambiguous: Set<ResumeField>,
) {
	const named = new Map<string, string>();
	for (const [index, line] of lines.entries()) {
		for (const part of line.split(/\s*[|•;]\s*/)) {
			const match = nameLabel.exec(part);
			if (!match) continue;
			const name = cleanName(match[1] || lines[index + 1] || "");
			if (name && !resumeHeading.test(name) && !documentTitle.test(name))
				named.set(name.toLowerCase(), name);
		}
	}
	if (named.size) return only(new Set(named.values()), "name", ambiguous);
	const header = lines.slice(0, 5);
	if (header[0] && documentTitle.test(header[0])) header.shift();
	const contact = email
		? header.findIndex((line) => emailsIn(line).includes(email))
		: -1;
	// A bare name is accepted only as the opening heading. Contact details
	// help corroborate ambiguous single-token headers.
	const first = header[0]?.split(/\s*[|•]\s*/, 1)[0];
	const candidateHeading =
		contact >= 0 || (header[1] && nameWords.test(header[1]));
	return first && candidateHeading
		? headerName(first, contact >= 0)
		: undefined;
}

const numberWords: Record<string, number> = {
	zero: 0,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
	twenty: 20,
	thirty: 30,
	forty: 40,
	fifty: 50,
	sixty: 60,
	seventy: 70,
	eighty: 80,
	ninety: 90,
};
const spelledNumber = `(?:a|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](?:one|two|three|four|five|six|seven|eight|nine)|${Object.keys(numberWords).join("|")})`;
const spelledDuration = new RegExp(
	String.raw`\b(${spelledNumber})\b(?=(?:\s*(?:to\b|or\b|[-–—/])\s*(?:${spelledNumber}|\d+)|\s*(?:-plus|plus|\+))?\s+(?:years?|yrs?|months?|mos?)\b)`,
	"gi",
);

function normalizeExperience(line: string) {
	return line
		.replace(spelledDuration, (_match, words: string) => {
			const parts = words.toLowerCase().split(/[ -]/);
			const value =
				parts[0] === "a"
					? 1
					: (numberWords[parts[0]] ?? 0) + (numberWords[parts[1]] ?? 0);
			return String(value);
		})
		.replace(/\b(\d+)\s*(?:-plus|plus)\s+(?=years?\b|yrs?\b)/gi, "$1+ ")
		.replace(
			/(?<![\d./⁄])(?:(\d{1,2}) +)?(1\/2|1\/4|3\/4)(?=\s+(?:years?|yrs?)\b)/gi,
			(_, whole: string | undefined, part: string) =>
				String(Number(whole ?? 0) + Number(part[0]) / Number(part[2])),
		)
		.replace(
			/\b(?:a|one) decade(?=\s+(?:of\s+)?(?:professional\s+)?experience)/gi,
			"10 years",
		)
		.replace(/(\d),(\d{1,2})(?=\s*(?:years?|yrs?)\b)/gi, "$1.$2");
}

const number = String.raw`\d{1,2}(?:\.\d{1,2})?`;
const yearUnit = String.raw`(?:years?|yrs?\.?|y)`;
const monthUnit = String.raw`(?:months?|mos?\.?|m)`;
const monthJoin = String.raw`\s*(?:(?:,|and|\+)\s*)?`;
const duration = String.raw`(?:${number}\s*${yearUnit}(?:${monthJoin}\d{1,2}\s*${monthUnit})?|\d{1,3}\s*${monthUnit})`;
const yearParts = new RegExp(
	String.raw`^(?:(${number})\s*${yearUnit}(?:${monthJoin}(\d{1,2})\s*${monthUnit})?|(\d{1,3})\s*${monthUnit})$`,
	"i",
);
const experienceWord = String.raw`(?:of\s+)?(?:(?:overall|total|professional|work|industry|relevant)\s+)?experience`;
const proseYears = new RegExp(
	String.raw`(?<![\p{L}\d./⁄])(?:(${duration})\s*['’]?\s+${experienceWord}|(${number})\s*yoe)\b`,
	"giu",
);
const yearsLabel =
	/^(?:(total|overall|cumulative)\s+)?(?:(?:years?\s+(?:of\s+)?)?(?:(?:professional|work|industry|it)\s+)?(?:experience|exp\.?)(?:\s*\((?:years?|yrs?)\))?|yoe)(?=\s|[:=\-–—]|$)\s*[:=\-–—]?\s*(.*)$/i;
const qualifier = String.raw`(?:[~<>≤≥]|\b(?:at least|at most|over|under|more than|less than|about|almost|around|nearly|roughly|approximately|approx\.?|minimum(?: of)?|maximum(?: of)?|requires?|required)(?![a-z]))`;
const nonExactPrefix = new RegExp(
	String.raw`(?:${qualifier}|\d+(?:\.\d+)?(?:\s*${yearUnit})?\s*(?:[-–—/⁄]|to|or|and))\s*$`,
	"i",
);
const generalDomain =
	/^(?:in|across|with)\s+(?:software (?:engineering|development|services)|the (?:software|tech) industry|technology|information technology|various industries)\b/i;

const approximateStart = new RegExp(String.raw`^${qualifier}\s*\d`, "i");
const rangeOrPlus = /^\d+(?:\.\d+)?\s*(?:\+|(?:[-–—/]|to|or)\s*\d)/i;
const nonExactTail =
	/^(?:[+~]|[-–—/]\s*\d|(?:to|or)\s+\d|or\s+(?:more|less)|and\s+counting|plus\b)/i;
const approximateProse = new RegExp(
	String.raw`(?<![\d.])${number}\s*(?:(?:\+|(?:${yearUnit}\s*)?(?:[-–—/⁄]|to\b|or\b)\s*${number})\s*(?:${yearUnit}\s+${experienceWord}|yoe)|${yearUnit}\s*(?:\+|or\s+(?:more|less)\b|plus\b)\s*${experienceWord})\b`,
	"i",
);

function exactYears(value: string) {
	const normalized = value
		.trim()
		.replace(/[.;]$/, "")
		.replace(/^(\d{1,2}),(\d{1,2})$/, "$1.$2");
	if (/^\d{1,2}(?:\.\d{1,2})?$/.test(normalized)) {
		const years = Number(normalized);
		return years <= 80 ? Math.round(years * 10) / 10 : undefined;
	}
	const match = yearParts.exec(normalized);
	if (!match) return undefined;
	const years = Number(match[1] ?? 0);
	const months = Number(match[2] ?? match[3] ?? 0);
	if (match[2] && (months >= 12 || !Number.isInteger(years))) return undefined;
	const total = years + months / 12;
	return total <= 80 ? Math.round(total * 10) / 10 : undefined;
}

const leadingDuration = new RegExp(`^(${duration})(?![a-z])`, "i");

function labelledYears(value: string, overall: boolean) {
	const exact = exactYears(value);
	if (exact !== undefined) return exact;
	const match = leadingDuration.exec(value);
	if (!match) return undefined;
	const context = value.slice(match[0].length).replace(/^[,; ]+/, "");
	if (
		generalDomain.test(context) ||
		(overall && /^(?:in|working|including|across)\b/i.test(context))
	) {
		return exactYears(match[1]);
	}
	return undefined;
}

function isApproximate(value: string) {
	if (approximateStart.test(value) || rangeOrPlus.test(value)) return true;
	const match = leadingDuration.exec(value);
	return Boolean(
		match && nonExactTail.test(value.slice(match[0].length).trim()),
	);
}

function suggestedYears(rawLines: string[], ambiguous: Set<ResumeField>) {
	const lines = rawLines.map(normalizeExperience);
	const totals = new Set<number>();
	const labelled = new Set<number>();
	const descriptions = new Set<number>();
	let uncertainTotal = false;
	let uncertainLabel = false;
	let uncertainProse = false;
	for (const [index, line] of lines.entries()) {
		for (const part of line.split(/\s*[|•;]\s*/)) {
			const label = yearsLabel.exec(part);
			if (!label) continue;
			const value = label[2] || lines[index + 1] || "";
			const years = labelledYears(value, Boolean(label[1]));
			if (years !== undefined) {
				(label[1] ? totals : labelled).add(years);
			} else if (isApproximate(value)) {
				if (label[1]) uncertainTotal = true;
				else uncertainLabel = true;
			}
		}
		// Prose may wrap onto the next line in the source document.
		const window = `${line} ${lines[index + 1] ?? ""}`;
		uncertainProse ||= approximateProse.test(window);
		for (const match of window.matchAll(proseYears)) {
			if (match.index >= line.length) break;
			const prefix = `${lines[index - 1] ?? ""} ${window.slice(0, match.index)}`;
			const suffix = window.slice(match.index + match[0].length).trim();
			if (nonExactPrefix.test(prefix.slice(-60)) || nonExactTail.test(suffix)) {
				uncertainProse = true;
				continue;
			}
			if (
				/^(?:in|with|using|on)\b/i.test(suffix) &&
				!generalDomain.test(suffix)
			)
				continue;
			const years = exactYears(match[1] ?? match[2]);
			if (years !== undefined) descriptions.add(years);
		}
	}
	if (
		uncertainTotal ||
		(!totals.size && uncertainLabel) ||
		(!totals.size && !labelled.size && uncertainProse)
	) {
		ambiguous.add("years");
		return undefined;
	}
	return only(
		totals.size ? totals : labelled.size ? labelled : descriptions,
		"years",
		ambiguous,
	);
}

const suggestionFields = candidateFieldsSchema.partial();

export function analyzeResumeFields(text: string) {
	const lines = usableLines(text);
	const ambiguous = new Set<ResumeField>();
	const email = suggestedEmail(lines, ambiguous);
	const name = suggestedName(lines, email, ambiguous);
	const years = suggestedYears(lines, ambiguous);
	const suggestions = suggestionFields.parse({
		...(name !== undefined && { name }),
		...(email !== undefined && { email }),
		...(years !== undefined && { years }),
	});
	return { suggestions, ambiguous };
}

export function suggestResumeFields(text: string): Partial<CandidateFields> {
	return analyzeResumeFields(text).suggestions;
}

export function analyzeOcrPages(pages: string[]) {
	const analysis = analyzeResumeFields(pages.join("\n\n"));
	if (pages.length < 2) return analysis;

	// A labelled name on one page can outrank an unlabelled heading on another.
	// Check each page's identity before trusting suggestions spanning pages.
	const individual = pages.map(analyzeResumeFields);
	for (const field of ["name", "email"] as const) {
		const values = new Set<string>();
		for (const page of individual) {
			const value = page.suggestions[field];
			if (value) values.add(value.toLowerCase());
		}
		const value = analysis.suggestions[field];
		if (value) values.add(value.toLowerCase());
		if (
			values.size > 1 ||
			individual.some(({ ambiguous }) => ambiguous.has(field))
		) {
			return {
				suggestions: {},
				ambiguous: new Set<ResumeField>([...analysis.ambiguous, field]),
			};
		}
	}
	return analysis;
}

export function mergeResumeSuggestions(
	native: ReturnType<typeof analyzeResumeFields>,
	ocr: ReturnType<typeof analyzeResumeFields>,
) {
	const suggestions = { ...native.suggestions };
	const conflictingIdentity = (["name", "email"] as const).some((field) => {
		const original = suggestions[field];
		const recognized = ocr.suggestions[field];
		return (
			native.ambiguous.has(field) ||
			ocr.ambiguous.has(field) ||
			(original &&
				recognized &&
				original.toLowerCase() !== recognized.toLowerCase())
		);
	});
	let added = false;
	if (!conflictingIdentity) {
		for (const field of ["name", "email", "years"] as const) {
			if (
				suggestions[field] === undefined &&
				!native.ambiguous.has(field) &&
				ocr.suggestions[field] !== undefined
			) {
				Object.assign(suggestions, { [field]: ocr.suggestions[field] });
				added = true;
			}
		}
	}
	return { suggestions, added };
}
