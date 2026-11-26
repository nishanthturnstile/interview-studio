import { createTransport } from "nodemailer";
import { z } from "zod";
import { errorClass, logger } from "../logger.ts";

export function createStaffMailer(env: NodeJS.ProcessEnv) {
	const host = z.string().min(1).parse(env.STUDIO_SMTP_HOST);
	const port = z.coerce
		.number()
		.int()
		.min(1)
		.max(65535)
		.parse(env.STUDIO_SMTP_PORT);
	const from = z.email().parse(env.STUDIO_SMTP_FROM);
	const transport = createTransport({
		host,
		port,
		connectionTimeout: 5_000,
		greetingTimeout: 5_000,
		socketTimeout: 10_000,
	});

	return (to: string, subject: string, text: string) => {
		void transport
			.sendMail({ from, to, subject, text })
			.catch((error: unknown) => {
				logger.warn(
					{ errorClass: errorClass(error) },
					"Staff email delivery failed",
				);
			});
	};
}
