import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const token = (size) => randomBytes(size).toString("hex");
const env = [
	"STUDIO_PORT=3000",
	"STUDIO_BUCKET=studio-private",
	`STUDIO_DB_PASSWORD=${token(24)}`,
	`STUDIO_APP_S3_KEY=${token(10)}`,
	`STUDIO_APP_S3_SECRET=${token(24)}`,
	`STUDIO_WORKER_S3_KEY=${token(10)}`,
	`STUDIO_WORKER_S3_SECRET=${token(24)}`,
].join("\n");

try {
	await writeFile(new URL("../.env", import.meta.url), `${env}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	console.log("Created .env with local credentials.");
} catch (error) {
	if (error.code !== "EEXIST") throw error;
	console.log("Using existing .env.");
}
