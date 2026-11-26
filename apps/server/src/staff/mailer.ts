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

	async function deliver(to: string, subject: string, text: string) {
		try {
			const result = await transport.sendMail({ from, to, subject, text });
			if (!result.accepted.length)
				throw new Error("SMTP did not accept a recipient");
		} catch (error) {
			logger.warn({ errorClass: errorClass(error) }, "Email delivery failed");
			throw error;
		}
	}

	return {
		deliver,
		send(to: string, subject: string, text: string) {
			void deliver(to, subject, text).catch(() => {});
		},
	};
}
