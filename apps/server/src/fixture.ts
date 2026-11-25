import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db } from "./database.ts";
import { smokeFixture } from "./schema.ts";
import { s3, storage } from "./storage.ts";

export const fixtureKey = "smoke/local-fixture.txt";
export const fixtureContents = "Interview Studio local storage fixture\n";

export function sha256(contents: string | Uint8Array) {
	return createHash("sha256").update(contents).digest("hex");
}

export async function verifyFixture() {
	const [fixture] = await db
		.select()
		.from(smokeFixture)
		.where(eq(smokeFixture.key, fixtureKey));
	if (!fixture) throw new Error("Run the synthetic seed first");

	const object = await s3.send(
		new GetObjectCommand({
			Bucket: storage.bucket,
			Key: fixture.key,
		}),
		{ abortSignal: AbortSignal.timeout(4_000) },
	);
	const contents = await object.Body?.transformToByteArray();
	if (!contents || sha256(contents) !== fixture.sha256) {
		throw new Error("Stored fixture checksum does not match PostgreSQL");
	}
}
