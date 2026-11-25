import { PgBoss } from "pg-boss";
import { databaseUrl } from "./database.ts";
import { errorClass, logger } from "./logger.ts";

export const probeQueue = "local-storage-probe";

export function createQueueClient(migrate = false) {
	const boss = new PgBoss({
		connectionString: databaseUrl,
		migrate,
		schedule: false,
	});
	boss.on("error", (error) =>
		logger.error({ errorClass: errorClass(error) }, "Queue error"),
	);
	return boss;
}
