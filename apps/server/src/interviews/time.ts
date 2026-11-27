import type { InterviewSlot } from "@studio/contracts";
import { InterviewProblem } from "./problem.ts";

// Node 26 supplies Temporal. Describe the subset used here until TypeScript includes it.
interface PlainDateTime {
	toZonedDateTime(
		zone: string,
		options: { disambiguation: "earlier" | "later" },
	): {
		offset: string;
		epochMilliseconds: number;
		toPlainDateTime(): PlainDateTime;
	};
	equals(other: PlainDateTime): boolean;
}
const temporal = (
	globalThis as unknown as {
		Temporal: { PlainDateTime: { from(value: string): PlainDateTime } };
	}
).Temporal;

export function validateTimeZone(zone: string) {
	if (
		!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone) ||
		zone.startsWith("Etc/Unknown")
	) {
		throw new InterviewProblem(422, "invalid_time_zone");
	}
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return zone;
	} catch {
		throw new InterviewProblem(422, "invalid_time_zone");
	}
}

export function resolveSlot(slot: InterviewSlot, timeZone: string) {
	validateTimeZone(timeZone);
	const local = `${slot.date}T${slot.time}`;
	if (
		!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(local) ||
		slot.date.startsWith("0000")
	) {
		throw new InterviewProblem(422, "invalid_slot");
	}
	const plain = temporal.PlainDateTime.from(local);
	const earlier = plain.toZonedDateTime(timeZone, {
		disambiguation: "earlier",
	});
	const later = plain.toZonedDateTime(timeZone, { disambiguation: "later" });
	if (
		!earlier.toPlainDateTime().equals(plain) ||
		!later.toPlainDateTime().equals(plain)
	) {
		throw new InterviewProblem(422, "nonexistent_time");
	}
	const offsets = [...new Set([earlier.offset, later.offset])];
	if (
		(offsets.length > 1 && !slot.offset) ||
		(slot.offset && !offsets.includes(slot.offset))
	) {
		throw new InterviewProblem(422, "ambiguous_time", { offsets });
	}
	const start = new Date(
		slot.offset === later.offset
			? later.epochMilliseconds
			: earlier.epochMilliseconds,
	);
	const end = new Date(start.getTime() + slot.duration * 60_000);
	if (end.getUTCFullYear() > 9999 || start.getUTCFullYear() < 1) {
		throw new InterviewProblem(422, "invalid_slot");
	}
	return { start, end, timeZone, duration: slot.duration, offsets };
}

export const entryLeadMs = 600_000;
export const presenceTtlMs = 30_000;

export const entryOpensAt = (start: Date) =>
	new Date(start.getTime() - entryLeadMs);

export function requireEntryWindow(
	round: { start: Date; end: Date },
	now: Date,
) {
	const opens = entryOpensAt(round.start);
	if (now < opens)
		throw new InterviewProblem(409, "too_early", {
			opensAt: opens.toISOString(),
		});
	if (now >= round.end) throw new InterviewProblem(409, "entry_closed");
}

export const presenceFresh = (lastSeen: Date | null | undefined, now: Date) =>
	lastSeen != null && now.getTime() - lastSeen.getTime() <= presenceTtlMs;
