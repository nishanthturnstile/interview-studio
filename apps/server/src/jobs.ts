import { PgBoss } from "pg-boss";
import { databaseUrl } from "./database.ts";
import { errorClass, logger } from "./logger.ts";

export const intakeQueue = "document-intake";
export const probeQueue = "local-storage-probe";

export function createQueueClient({ migrate = false, supervise = false } = {}) {
	const boss = new PgBoss({
		connectionString: databaseUrl,
		migrate,
		schedule: false,
		supervise,
		superviseIntervalSeconds: 5,
		monitorIntervalSeconds: 5,
	});
	boss.on("error", (error) =>
		logger.error({ errorClass: errorClass(error) }, "Queue error"),
	);
	return boss;
}
