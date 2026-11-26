import { createHash } from "node:crypto";
import type { BookInterview } from "@studio/contracts";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { drive, driveCandidate, driveDocument } from "../drives/schema.ts";
import { account, user } from "../staff/auth-schema.ts";
import { staffGrant } from "../staff/role-schema.ts";
import { bookInterview } from "./scheduling.ts";
import { interviewRound } from "./schema.ts";
import {
	type Database,
	type InterviewConfig,
	readPreferences,
	type Transaction,
} from "./store.ts";

const fixtureId = (number: number) =>
	`00000000-0000-4000-8400-${number.toString().padStart(12, "0")}`;
export const interviewFixture = {
	hr: { id: fixtureId(1), name: "Maya Patel", email: "slice4-hr@studio.test" },
	panelist: {
		id: fixtureId(2),
		name: "Jordan Lee",
		email: "slice4-panelist@studio.test",
	},
	other: {
		id: fixtureId(3),
		name: "Jordan Lee",
		email: "slice4-other@studio.test",
	},
	unverified: {
		id: fixtureId(4),
		name: "Unverified Panelist",
		email: "slice4-unverified@studio.test",
	},
	drive: { id: fixtureId(11), name: "Platform Engineering" },
	otherDrive: { id: fixtureId(12), name: "Infrastructure Hiring" },
	candidate: {
		id: fixtureId(21),
		name: "Avery Morgan",
		email: "slice4-candidate@example.test",
	},
	otherCandidate: {
		id: fixtureId(22),
		name: "Avery M. Morgan",
		email: "slice4-candidate@example.test",
	},
	draft: {
		id: fixtureId(23),
		name: "Sam Rivera",
		email: "slice4-draft@example.test",
	},
	duplicate: {
		id: fixtureId(24),
		name: "Avery Morgan (duplicate)",
		email: "slice4-candidate@example.test",
	},
};

export async function fixtureCandidacy(
	database: Transaction,
	createdBy: string,
	scope: {
		driveId: string;
		id: string;
		name: string;
		email: string;
		years?: number;
		state?: "draft" | "confirmed" | "duplicate";
		duplicateOf?: string;
	},
) {
	const sourceId = uuidFor(scope.id, "fixture-source");
	await database
		.insert(driveDocument)
		.values({
			id: sourceId,
			driveId: scope.driveId,
			kind: "resume",
			uploadedBy: createdBy,
			clientKey: sourceId,
			filename: "synthetic-resume.pdf",
			mediaType: "application/pdf",
			size: 1,
			sha256: "0".repeat(64),
			objectKey: `drive-uploads/fixture/${sourceId}`,
			deadline: new Date(),
			uploadState: "stored",
			parseState: "succeeded",
			cleanupDeletedAt: new Date(),
		})
		.onConflictDoNothing({ target: driveDocument.id });
	await database
		.insert(driveCandidate)
		.values({
			id: scope.id,
			driveId: scope.driveId,
			sourceId,
			name: scope.name,
			email: scope.email,
			reviewState: scope.state ?? "confirmed",
			duplicateOf: scope.duplicateOf,
			experienceTenths:
				scope.years === undefined ? null : Math.round(scope.years * 10),
		})
		.onConflictDoNothing({ target: driveCandidate.id });
}

function uuidFor(id: string, purpose: string) {
	const value = createHash("sha256").update(`${purpose}:${id}`).digest("hex");
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export async function seedInterviewFixture(
	database: Database,
	config: InterviewConfig,
	password: string,
) {
	if (
		!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.origin) ||
		!config.domains.has("studio.test") ||
		password.length < 12
	) {
		throw new Error(
			"Interview fixtures require loopback, studio.test, and an explicit synthetic password",
		);
	}
	const data = interviewFixture;
	const hashed = await hashPassword(password);
	await database.transaction(async (tx) => {
		for (const staff of [data.hr, data.panelist, data.other, data.unverified]) {
			await tx
				.insert(user)
				.values({
					...staff,
					phone: "+1 202 555 0111",
					emailVerified: staff.id !== data.unverified.id,
				})
				.onConflictDoNothing({ target: user.id });
			const accountId = uuidFor(staff.id, "fixture-account");
			await tx
				.insert(account)
				.values({
					id: accountId,
					accountId: staff.id,
					userId: staff.id,
					providerId: "credential",
					password: hashed,
				})
				.onConflictDoNothing({ target: account.id });
		}
		await tx
			.insert(staffGrant)
			.values({ userId: data.hr.id, role: "hr" })
			.onConflictDoNothing();
		for (const item of [data.drive, data.otherDrive]) {
			await tx
				.insert(drive)
				.values({ ...item, createdBy: data.hr.id, clientKey: item.id })
				.onConflictDoNothing({ target: drive.id });
		}
		await fixtureCandidacy(tx, data.hr.id, {
			...data.candidate,
			driveId: data.drive.id,
			years: 5.5,
		});
		await fixtureCandidacy(tx, data.hr.id, {
			...data.otherCandidate,
			driveId: data.otherDrive.id,
			years: 5.5,
		});
		await fixtureCandidacy(tx, data.hr.id, {
			...data.draft,
			driveId: data.drive.id,
			state: "draft",
		});
		await fixtureCandidacy(tx, data.hr.id, {
			...data.duplicate,
			driveId: data.drive.id,
			state: "duplicate",
			duplicateOf: data.candidate.id,
		});
	});
	// Preserve the seeded attempt after rescheduling or closure.
	const [alreadyBooked] = await database
		.select({ id: interviewRound.id })
		.from(interviewRound)
		.where(eq(interviewRound.candidateId, data.otherCandidate.id))
		.limit(1);
	if (alreadyBooked) return alreadyBooked;
	const [candidate] = await database
		.select({ revision: driveCandidate.revision })
		.from(driveCandidate)
		.where(eq(driveCandidate.id, data.otherCandidate.id));
	const settings = await readPreferences(database, data.hr.id);
	const days = new Date(Date.now() + 24 * 60 * 60_000);
	const localDate = new Intl.DateTimeFormat("sv-SE", {
		timeZone: settings.timeZone,
		dateStyle: "short",
	}).format(days);
	const input: BookInterview = {
		commandId: fixtureId(31),
		driveId: data.otherDrive.id,
		candidateId: data.otherCandidate.id,
		candidateRevision: candidate.revision,
		panelistId: data.panelist.id,
		level: "l1",
		slot: { date: localDate, time: "11:00", duration: settings.duration },
		preferenceRevision: settings.revision,
		meeting: { mode: "virtual", teamsUrl: null },
	};
	return bookInterview(database, config, data.hr.id, input);
}
