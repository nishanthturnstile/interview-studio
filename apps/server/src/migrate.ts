import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./database.ts";
import { createQueueClient, intakeQueue, probeQueue } from "./jobs.ts";
import { errorClass, logger } from "./logger.ts";

const boss = createQueueClient({ migrate: true });
try {
	await migrate(db, {
		migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
	});
	await boss.start();
	await boss.createQueue(probeQueue);
	await boss.createQueue(intakeQueue, {
		expireInSeconds: 40,
		retryLimit: 2,
		retryDelay: 2,
		retryBackoff: true,
		retryDelayMax: 8,
	});
	logger.info("Database and queue migrations complete");
} catch (error) {
	logger.error({ errorClass: errorClass(error) }, "Migration failed");
	process.exitCode = 1;
} finally {
	await boss.stop();
	await pool.end();
}
