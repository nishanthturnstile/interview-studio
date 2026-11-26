import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as openRequest } from "node:http";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";

const exec = promisify(execFile);
const pdf = "application/pdf";

export async function checkIntakeRecovery(
	project: string,
	hr: Page,
	origin: string,
	content: Buffer,
) {
	if (!/^studio-[a-z0-9-]+-test$/.test(project))
		throw new Error("Use a dedicated studio-*-test Compose project");
	const compose = async (...args: string[]) =>
		(
			await exec("docker", ["compose", "-p", project, ...args], {
				timeout: 25_000,
			})
		).stdout.trim();
	const sql = (query: string) =>
		compose(
			"exec",
			"-T",
			"db",
			"psql",
			"-X",
			"-v",
			"ON_ERROR_STOP=1",
			"-U",
			"studio",
			"-d",
			"studio",
			"-Atc",
			query,
		);
	const node = (source: string, ...args: string[]) =>
		compose(
			"exec",
			"-T",
			"app",
			"node",
			"--input-type=module",
			"-e",
			source,
			...args,
		);
	const worker = await compose("ps", "-aq", "worker");
	const startWorker = async () => {
		await exec("docker", ["start", worker], { timeout: 15_000 });
	};
	const configuredOrigin = await node(
		"console.log(process.env.STUDIO_AUTH_ORIGIN)",
	);
	if (configuredOrigin !== origin)
		throw new Error("The recovery project must host the browser test origin");

	const { email, id: owner } = await (
		await hr.request.get("/api/staff/me")
	).json();
	if (!/^[a-zA-Z0-9_-]+$/.test(owner))
		throw new Error("Invalid synthetic staff ID");
	for (let run = 0; run < 2; run++) {
		await compose(
			"exec",
			"-T",
			"-e",
			`STUDIO_SEED_DRIVE_HR=${email}`,
			"app",
			"node",
			"apps/server/src/seed.ts",
		);
	}
	expect(
		await sql(
			`select count(*) from drive where name = 'Synthetic hiring drive' and created_by = '${owner}'`,
		),
	).toBe("1");
	await compose("exec", "-T", "app", "node", "apps/server/src/smoke.ts");

	const root = "/api/staff/drives";
	const baseHeaders = { origin };
	const created = await hr.request.post(root, {
		headers: { ...baseHeaders, "Idempotency-Key": randomUUID() },
		data: { name: "Synthetic recovery drill" },
	});
	expect(created.status()).toBe(201);
	const { id: driveId } = await created.json();
	const api = `${root}/${driveId}`;
	const uploadHeaders = (name: string, key: string) => ({
		...baseHeaders,
		"X-Upload-Filename": name,
		"Content-Type": pdf,
		"Idempotency-Key": key,
	});
	const upload = (name: string, key = randomUUID()) =>
		hr.request.post(`${api}/documents?kind=resume`, {
			headers: uploadHeaders(name, key),
			data: content,
			timeout: 25_000,
		});
	const status = async (id: string) =>
		(await (await hr.request.get(`${api}/documents?ids=${id}`)).json())
			.items[0];
	const original = (id: string) =>
		hr.request.get(`${api}/documents/${id}/original`);
	const sweep = () =>
		node(`
		import { db,pool } from './apps/server/src/database.ts';
		import { sweepOriginals } from './apps/server/src/drives/cleanup.ts';
		import { s3 } from './apps/server/src/storage.ts';
		try { await sweepOriginals(db,AbortSignal.timeout(10_000)); }
		finally { s3.destroy(); await pool.end(); }
	`);
	const object = (action: "put" | "head" | "delete", key: string) =>
		node(
			`
		import { createRequire } from 'node:module';
		import { s3,storage } from './apps/server/src/storage.ts';
		const {HeadObjectCommand,PutObjectCommand,DeleteObjectCommand} = createRequire('/studio/apps/server/package.json')('@aws-sdk/client-s3');
		const [action,Key,body] = process.argv.slice(1);
		const input={Bucket:storage.bucket,Key};
		try {
			if (action === 'head') {
				await s3.send(new HeadObjectCommand(input));
				console.log('present');
			} else if (action === 'delete') {
				await s3.send(new DeleteObjectCommand(input));
			} else {
				await s3.send(new PutObjectCommand({...input,Body:Buffer.from(body,'base64'),ContentType:'application/pdf'}));
			}
		} catch (error) {
			if (action !== 'head' || error.$metadata?.httpStatusCode !== 404) throw error;
			console.log('missing');
		} finally { s3.destroy(); }
	`,
			action,
			key,
			content.toString("base64"),
		);
	const keyFor = (id: string) =>
		sql(`select object_key from drive_document where id = '${id}'`);
	const terminal = (id: string, expected: string) =>
		expect
			.poll(async () => (await status(id)).parseState, {
				intervals: [300, 600, 1000],
				timeout: 35_000,
			})
			.toBe(expected);

	await compose("stop", "worker");
	try {
		await compose("stop", "storage");
		const storageKey = randomUUID();
		try {
			const failure = await upload("storage.pdf", storageKey);
			expect(failure.status()).toBe(503);
			expect((await failure.json()).error).toBe("storage_unavailable");
		} finally {
			await compose("start", "storage");
		}
		await expect
			.poll(
				async () => {
					const health = await hr.request.get("/api/health");
					return (await health.json()).services.storage;
				},
				{ timeout: 15_000 },
			)
			.toBe(true);
		expect((await upload("storage.pdf", storageKey)).status()).toBe(409);

		await sql(`
			create function reject_intake_test_enqueue() returns trigger language plpgsql as $$
			begin raise exception 'synthetic queue failure'; end $$;
			create trigger reject_intake_test_enqueue before insert on pgboss.job
				for each row when (new.name = 'document-intake') execute function reject_intake_test_enqueue();
		`);
		const enqueueKey = randomUUID();
		try {
			const failure = await upload("queue.pdf", enqueueKey);
			expect(failure.status()).toBe(503);
			expect((await failure.json()).error).toBe("queue_unavailable");
		} finally {
			await sql(
				"drop trigger reject_intake_test_enqueue on pgboss.job; drop function reject_intake_test_enqueue()",
			);
		}
		expect((await upload("queue.pdf", enqueueKey)).status()).toBe(409);
		expect(
			await sql(
				`select count(*) from drive_candidate where drive_id = '${driveId}'`,
			),
		).toBe("0");

		const expiredKey = randomUUID();
		await sql(`
			create function expire_intake_test_attempt() returns trigger language plpgsql as $$
			begin
				new.deadline := clock_timestamp() - interval '1 second';
				new.cleanup_after := new.deadline;
				return new;
			end $$;
			create trigger expire_intake_test_attempt before insert on drive_document
				for each row when (new.client_key = '${expiredKey}') execute function expire_intake_test_attempt();
		`);
		try {
			const expired = await upload("expired.pdf", expiredKey);
			expect(expired.status()).toBe(409);
			expect((await expired.json()).error).toBe("upload_retry_required");
		} finally {
			await sql(
				"drop trigger expire_intake_test_attempt on drive_document; drop function expire_intake_test_attempt()",
			);
		}
		const expiredId = await sql(
			`select id from drive_document where client_key = '${expiredKey}'`,
		);
		const expiredObject = await keyFor(expiredId);
		await sweep();
		expect((await status(expiredId)).uploadState).toBe("cleanup");
		expect(await object("head", expiredObject)).toBe("missing");
		await object("put", expiredObject);
		expect(await object("head", expiredObject)).toBe("present");
		await sql(
			`update drive_document set cleanup_after=clock_timestamp() where id = '${expiredId}'`,
		);
		await sweep();
		expect(await object("head", expiredObject)).toBe("missing");

		const success = await upload("delayed.pdf");
		expect(success.status()).toBe(201);
		const delayed = await success.json();
		const draft = `${api}/candidates/${delayed.candidateId}`;
		expect(
			(
				await hr.request.patch(draft, {
					headers: baseHeaders,
					data: { revision: 0, name: "Synthetic Manual Edit" },
				})
			).status(),
		).toBe(200);
		await sql(`update pgboss.job set start_after=clock_timestamp()+interval '6 seconds'
			where id=(select job_id from drive_document where id='${delayed.id}')`);

		const missingFile = await upload("retry.pdf");
		expect(missingFile.status()).toBe(201);
		const retry = await missingFile.json();
		const retryObject = await keyFor(retry.id);
		await object("delete", retryObject);
		const missing = await original(retry.id);
		expect(missing.status()).toBe(503);
		expect((await missing.json()).error).toBe("original_missing");

		const staleResult = await upload("stale.pdf");
		expect(staleResult.status()).toBe(201);
		const stale = await staleResult.json();
		await sql(
			`update drive_document set generation=generation+1 where id='${stale.id}'`,
		);

		await startWorker();
		expect((await status(delayed.id)).parseState).toBe("queued");
		await expect
			.poll(async () => (await status(retry.id)).parseAttempts, {
				intervals: [100, 200],
				timeout: 15_000,
			})
			.toBeGreaterThan(0);
		await object("put", retryObject);
		await terminal(retry.id, "succeeded");
		expect((await status(retry.id)).parseAttempts).toBeGreaterThan(1);
		await terminal(delayed.id, "succeeded");
		await terminal(stale.id, "needs_manual_review");
		expect((await status(stale.id)).parseFailure).toBe(
			"infrastructure_exhausted",
		);
		const after = await (
			await hr.request.get(`${api}/candidates?ids=${delayed.candidateId}`)
		).json();
		expect(after.items[0]).toMatchObject({
			name: "Synthetic Manual Edit",
			revision: 1,
			suggestions: { name: "Synthetic Applicant" },
		});
		await sweep();
		expect((await original(delayed.id)).status()).toBe(200);
	} finally {
		await startWorker();
	}

	await compose("stop", "worker");
	try {
		const active = await upload("interrupted.pdf");
		expect(active.status()).toBe(201);
		const interrupted = await active.json();
		await sql(`update pgboss.job set expire_seconds=6
			where id=(select job_id from drive_document where id='${interrupted.id}')`);
		await compose("pause", "storage");
		try {
			await startWorker();
			await expect
				.poll(async () => (await status(interrupted.id)).parseState, {
					intervals: [100, 200],
					timeout: 12_000,
				})
				.toBe("processing");
			await compose("kill", "-s", "SIGKILL", "worker");
		} finally {
			await compose("unpause", "storage");
		}
		await startWorker();
		await terminal(interrupted.id, "succeeded");
		expect((await status(interrupted.id)).parseAttempts).toBeGreaterThan(1);
	} finally {
		await startWorker();
	}

	// Give the admission tests their own rate window after the recovery requests.
	const app = await compose("ps", "-aq", "app");
	await exec("docker", ["restart", app], { timeout: 25_000 });
	await expect
		.poll(
			async () => {
				try {
					return (await hr.request.get("/api/health")).status();
				} catch {
					return 0;
				}
			},
			{ timeout: 15_000 },
		)
		.toBe(200);

	const cookie = (await hr.context().cookies())
		.map(({ name, value }) => `${name}=${value}`)
		.join("; ");
	const openUpload = (name: string) => {
		const client = openRequest(`${origin}${api}/documents?kind=resume`, {
			method: "POST",
			headers: { ...uploadHeaders(name, randomUUID()), cookie },
			signal: AbortSignal.timeout(15_000),
		});
		const done = new Promise<number | undefined>((resolve, reject) => {
			client.once("error", reject);
			client.once("response", (response) => {
				response.resume();
				resolve(response.statusCode);
			});
		});
		client.write(content.subarray(0, 8));
		return { done, finish: () => client.end(content.subarray(8)) };
	};
	const slow = [openUpload("concurrent-1.pdf"), openUpload("concurrent-2.pdf")];
	try {
		await expect
			.poll(
				async () => {
					const response = await upload("competing.pdf");
					if (response.status() !== 429) return null;
					return {
						retryAfter: response.headers()["retry-after"],
						error: (await response.json()).error,
					};
				},
				{ intervals: [200], timeout: 4000 },
			)
			.toEqual({ retryAfter: "2", error: "upload_busy" });
	} finally {
		for (const request of slow) request.finish();
	}
	expect(await Promise.all(slow.map(({ done }) => done))).toEqual([201, 201]);
	await compose("stop", "worker");
	try {
		await sql(`
			insert into drive_document (drive_id, kind, uploaded_by, client_key, filename, media_type, size, sha256, object_key, deadline)
			select drive.id, 'resume', created_by, gen_random_uuid(), 'capacity-held.pdf', 'application/pdf', 1,
				repeat('0',64), 'drive-uploads/' || gen_random_uuid(), clock_timestamp() + interval '1 minute'
			from drive cross join generate_series(1, (99 - (
				select count(*) from drive_document
				where (upload_state = 'pending' and deadline > clock_timestamp())
					or (upload_state = 'stored' and parse_state in ('queued','processing'))
			))::int)
			where drive.id='${driveId}';
		`);
		const capacity = await Promise.all([
			upload("capacity-1.pdf"),
			upload("capacity-2.pdf"),
		]);
		expect(capacity.map((response) => response.status()).sort()).toEqual([
			201, 429,
		]);
		const limited = capacity.find((response) => response.status() === 429);
		if (!limited) throw new Error("No intake capacity rejection");
		expect((await limited.json()).error).toBe("intake_full");
		expect(limited.headers()["retry-after"]).toBe("10");
	} finally {
		await sql(
			`delete from drive_document where drive_id='${driveId}' and filename='capacity-held.pdf'`,
		);
		await startWorker();
	}

	let rateLimited = false;
	for (let i = 0; i < 30 && !rateLimited; i++) {
		const response = await hr.request.post(`${api}/documents?kind=resume`, {
			headers: baseHeaders,
		});
		if (response.status() === 429) {
			expect((await response.json()).error).toBe("upload_rate_limit");
			expect(Number(response.headers()["retry-after"])).toBeGreaterThan(0);
			rateLimited = true;
		}
	}
	expect(rateLimited).toBe(true);
}
