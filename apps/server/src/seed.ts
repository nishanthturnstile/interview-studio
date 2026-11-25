import { PutObjectCommand } from "@aws-sdk/client-s3";
import { db, pool } from "./database.ts";
import { fixtureContents, fixtureKey, sha256 } from "./fixture.ts";
import { errorClass, logger } from "./logger.ts";
import { smokeFixture } from "./schema.ts";
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
} catch (error) {
	logger.error({ errorClass: errorClass(error) }, "Synthetic seed failed");
	process.exitCode = 1;
} finally {
	s3.destroy();
	await pool.end();
}
