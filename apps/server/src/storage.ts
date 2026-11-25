import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

export const storage = z
	.object({
		endpoint: z.url(),
		bucket: z.string().min(1),
		accessKeyId: z.string().min(1),
		secretAccessKey: z.string().min(1),
	})
	.parse({
		endpoint: process.env.STUDIO_S3_ENDPOINT,
		bucket: process.env.STUDIO_BUCKET,
		accessKeyId: process.env.STUDIO_S3_KEY,
		secretAccessKey: process.env.STUDIO_S3_SECRET,
	});

export const s3 = new S3Client({
	endpoint: storage.endpoint,
	region: "us-east-1",
	forcePathStyle: true,
	maxAttempts: 1,
	credentials: {
		accessKeyId: storage.accessKeyId,
		secretAccessKey: storage.secretAccessKey,
	},
});
