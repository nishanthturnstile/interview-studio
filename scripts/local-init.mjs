import { randomBytes } from "node:crypto";
import {
	appendFile,
	mkdir,
	open,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { parseEnv } from "node:util";

const token = (size) => randomBytes(size).toString("hex");
const path = new URL("../.env", import.meta.url);
const auth = {
	STUDIO_INTERVIEW_SECRET: token(32),
	STUDIO_AUTH_SECRET: token(32),
	STUDIO_STAFF_DOMAINS: "studio.test",
	STUDIO_DIRECTOR_EMAIL: "director@studio.test",
	STUDIO_MAILPIT_PORT: "8025",
};
const initial = {
	STUDIO_PORT: "3000",
	STUDIO_BUCKET: "studio-private",
	STUDIO_DB_PASSWORD: token(24),
	STUDIO_APP_S3_KEY: token(10),
	STUDIO_APP_S3_SECRET: token(24),
	STUDIO_WORKER_S3_KEY: token(10),
	STUDIO_WORKER_S3_SECRET: token(24),
	...auth,
};

const serialize = (entries) =>
	entries.map(([key, value]) => `${key}=${value}\n`).join("");

const local = new URL("../.local/", import.meta.url);
const lockPath = new URL("local-init.lock", local);
await mkdir(local, { recursive: true, mode: 0o700 });

async function acquireLock() {
	const deadline = Date.now() + 2_000;
	while (true) {
		try {
			return await open(lockPath, "wx", 0o600);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(
					"Local initialization is locked by .local/local-init.lock.",
				);
			}
			await setTimeout(50);
		}
	}
}

const lock = await acquireLock();
try {
	try {
		await writeFile(path, serialize(Object.entries(initial)), {
			flag: "wx",
			mode: 0o600,
		});
		console.log("Created .env with local credentials.");
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const existing = await readFile(path, "utf8");
		const settings = parseEnv(existing);
		const missing = Object.entries(auth).filter(
			([key]) => !Object.hasOwn(settings, key),
		);
		if (missing.length) {
			await appendFile(path, `\n${serialize(missing)}`);
			console.log("Added missing application settings to the existing .env.");
		} else {
			console.log("Using existing .env.");
		}
	}
} finally {
	await lock.close();
	await unlink(lockPath);
}
