import { PutObjectCommand } from "@aws-sdk/client-s3";
import { workEmailSchema } from "@studio/contracts";
import { eq } from "drizzle-orm";
import { db, pool } from "./database.ts";
import { createDrive } from "./drives/routes.ts";
import { fixtureContents, fixtureKey, sha256 } from "./fixture.ts";
import { errorClass, logger } from "./logger.ts";
import { smokeFixture } from "./schema.ts";
import { user } from "./staff/auth-schema.ts";
import { getStaff } from "./staff/roles.ts";
import { readStaffSettings } from "./staff/settings.ts";
import { s3, storage } from "./storage.ts";

try {
	await s3.send(
		new PutObjectCommand({
			Bucket: storage.bucket,
			Key: fixtureKey,
			Body: fixtureContents,
			ContentType: "text/plain",
		}),
		{ abortSignal: AbortSignal.timeout(4_000) },
	);

	const checksum = sha256(fixtureContents);
	await db
		.insert(smokeFixture)
		.values({ key: fixtureKey, sha256: checksum })
		.onConflictDoUpdate({
			target: smokeFixture.key,
			set: { sha256: checksum },
		});
	logger.info("Synthetic storage fixture seeded");
	if (process.env.STUDIO_SEED_DRIVE_HR) {
		const email = workEmailSchema.parse(process.env.STUDIO_SEED_DRIVE_HR);
		const settings = readStaffSettings(process.env);
		const [account] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, email));
		const actor = account && (await getStaff(db, account.id, settings.domains));
		if (actor?.role !== "hr")
			throw new Error("Synthetic seed requires a verified HR account");
		const result = await createDrive(
			db,
			actor.id,
			"00000000-0000-4000-8000-000000000003",
			"Synthetic hiring drive",
		);
		logger.info({ driveId: result.id }, "Synthetic drive seeded");
	}
} catch (error) {
	logger.error({ errorClass: errorClass(error) }, "Synthetic seed failed");
	process.exitCode = 1;
} finally {
	s3.destroy();
	await pool.end();
}
