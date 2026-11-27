import { upgradeWebSocket } from "@hono/node-server";
import {
	type ArtifactKind,
	artifactKindSchema,
	type WorkspaceDescriptor,
	type WorkspaceEvent,
	workspaceBindMessageSchema,
} from "@studio/contracts";
import type { Context, Next } from "hono";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { errorClass, logger } from "../logger.ts";
import { InterviewProblem } from "./problem.ts";
import { type WorkspaceSignal, workspaceChannel } from "./workspace-signals.ts";

const heartbeatMs = 15_000;
const bindMs = 5_000;
const maxSockets = 128;
const maxIdentitySockets = 4;
const maxBacklog = 32 * 1024;

type Authorize = (binding?: string) => Promise<WorkspaceDescriptor>;
type Peer = {
	socket: WebSocket;
	identity: string;
	roundId: string;
	staffId?: string;
	binding?: string;
	authorize: Authorize;
	bindTimer: ReturnType<typeof setTimeout>;
	pongAt: number;
	checking: boolean;
	recheck: boolean;
	closing: boolean;
	notices: Map<ArtifactKind, number>;
};
const roundSignal = z.object({
	roundId: z.uuid(),
	kind: artifactKindSchema,
	sequence: z.number().int().positive(),
});
const accessSignal = z.union([
	z.strictObject({ roundId: z.uuid() }),
	z.strictObject({ staffId: z.string().min(1) }),
]);

export class WorkspaceLive {
	readonly server = new WebSocketServer({
		noServer: true,
		maxPayload: 1024,
		perMessageDeflate: false,
	});
	private readonly peers = new Set<Peer>();
	private listener?: pg.Client;
	private retry?: ReturnType<typeof setTimeout>;
	private listening = false;
	private stopped = false;
	private upgrading = 0;
	private readonly heartbeat = setInterval(
		() => this.tick(),
		heartbeatMs,
	).unref();

	private readonly databaseUrl: string;

	constructor(databaseUrl: string) {
		this.databaseUrl = databaseUrl;
		void this.listen();
	}

	private async listen() {
		if (this.stopped) return;
		const client = new pg.Client({
			connectionString: this.databaseUrl,
			connectionTimeoutMillis: 2_000,
			query_timeout: 2_000,
			keepAlive: true,
		});
		this.listener = client;
		const lost = (error?: Error) => {
			if (this.listener !== client || this.stopped) return;
			this.listener = undefined;
			this.listening = false;
			if (error)
				logger.warn(
					{ errorClass: errorClass(error) },
					"Workspace listener disconnected",
				);
			for (const peer of this.peers) this.disconnect(peer, 1012);
			void client.end().catch(() => {});
			this.retry = setTimeout(() => void this.listen(), 1_000).unref();
		};
		client.on("error", lost);
		client.on("end", lost);
		client.on("notification", ({ channel, payload }) => {
			if (channel !== workspaceChannel || !payload) return;
			try {
				const signal = z
					.union([roundSignal, accessSignal])
					.safeParse(JSON.parse(payload));
				if (signal.success) this.signal(signal.data);
			} catch {
				logger.warn("Invalid interview workspace signal");
			}
		});
		try {
			await client.connect();
			await client.query(`LISTEN ${workspaceChannel}`);
			if (this.listener === client && !this.stopped) this.listening = true;
		} catch (error) {
			lost(error instanceof Error ? error : undefined);
		}
	}

	async open(
		c: Context,
		next: Next,
		trustedOrigins: readonly string[],
		roundId: string,
		authorize: Authorize,
		staffId?: string,
	) {
		if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
			throw new InterviewProblem(404, "not_found");
		if (!trustedOrigins.includes(c.req.header("origin") ?? ""))
			throw new InterviewProblem(403, "untrusted_origin");
		if (!this.listening || this.stopped)
			throw new InterviewProblem(503, "rate_limited", { retryAfter: 1 });
		if (this.upgrading + this.server.clients.size >= maxSockets)
			throw new InterviewProblem(429, "rate_limited", { retryAfter: 1 });
		this.upgrading++;
		try {
			const initial = await authorize();
			if (!initial.active) throw new InterviewProblem(404, "not_found");
			const identity = staffId ?? initial.binding;
			if (
				[...this.peers].filter((peer) => peer.identity === identity).length >=
				maxIdentitySockets
			)
				throw new InterviewProblem(429, "rate_limited", { retryAfter: 1 });
			let peer: Peer | undefined;
			return await upgradeWebSocket(
				() => ({
					onOpen: (_, ws) => {
						const socket = ws.raw;
						if (!(socket instanceof WebSocket)) return ws.close(1011);
						if (
							!this.listening ||
							this.stopped ||
							this.server.clients.size > maxSockets ||
							[...this.peers].filter((item) => item.identity === identity)
								.length >= maxIdentitySockets
						)
							return socket.close(1013);
						const opened: Peer = {
							socket,
							identity,
							staffId,
							roundId,
							authorize,
							checking: false,
							recheck: false,
							closing: false,
							pongAt: Date.now(),
							notices: new Map(),
							bindTimer: setTimeout(
								() => this.disconnect(opened, 1008),
								bindMs,
							).unref(),
						};
						peer = opened;
						this.peers.add(peer);
						socket.on("pong", () => {
							opened.pongAt = Date.now();
						});
					},
					onMessage: ({ data }) => {
						if (!peer || peer.closing) return;
						if (peer.binding || peer.checking || typeof data !== "string")
							return this.disconnect(peer, 1008);
						let parsed: unknown;
						try {
							parsed = JSON.parse(data);
						} catch {
							return this.disconnect(peer, 1008);
						}
						const bind = workspaceBindMessageSchema.safeParse(parsed);
						if (!bind.success || bind.data.binding !== initial.binding)
							return this.disconnect(peer, 1008);
						const current = peer;
						current.checking = true;
						void authorize(bind.data.binding)
							.then((view) => {
								if (current.closing) return;
								if (!view.active || view.binding !== initial.binding)
									return this.endAccess(current);
								current.binding = view.binding;
								clearTimeout(current.bindTimer);
								this.send(current, { type: "ready" });
							})
							.catch((error: unknown) =>
								this.authorizationFailed(current, error),
							)
							.finally(() => {
								current.checking = false;
								if (
									(current.recheck || current.notices.size) &&
									current.binding
								)
									this.check(current);
							});
					},
					onClose: () => {
						if (!peer) return;
						peer.closing = true;
						clearTimeout(peer.bindTimer);
						this.peers.delete(peer);
					},
				}),
				{
					onError: (error) =>
						logger.warn(
							{ errorClass: errorClass(error) },
							"Workspace socket error",
						),
				},
			)(c, next);
		} finally {
			this.upgrading--;
		}
	}

	private signal(signal: WorkspaceSignal) {
		for (const peer of this.peers) {
			const matches =
				"roundId" in signal
					? signal.roundId === peer.roundId
					: signal.staffId === peer.staffId;
			if (!matches || peer.closing) continue;
			if ("kind" in signal) {
				const known = peer.notices.get(signal.kind) ?? 0;
				peer.notices.set(signal.kind, Math.max(known, signal.sequence));
			} else {
				peer.recheck = true;
			}
			this.check(peer);
		}
	}

	private tick() {
		for (const peer of this.peers) {
			if (peer.closing) {
				peer.socket.terminate();
				continue;
			}
			if (Date.now() - peer.pongAt >= heartbeatMs * 2) {
				peer.socket.terminate();
				continue;
			}
			if (peer.socket.readyState === WebSocket.OPEN) peer.socket.ping();
			this.check(peer);
		}
	}

	private check(peer: Peer) {
		if (peer.checking || peer.closing || !peer.binding) return;
		peer.checking = true;
		peer.recheck = false;
		const notices = new Map(peer.notices);
		peer.notices.clear();
		void peer
			.authorize(peer.binding)
			.then((view) => {
				if (peer.closing) return;
				if (peer.recheck) {
					for (const [kind, sequence] of notices)
						peer.notices.set(
							kind,
							Math.max(sequence, peer.notices.get(kind) ?? 0),
						);
					return;
				}
				if (!view.active) return this.endAccess(peer);
				for (const [kind, sequence] of notices) {
					if (view.heads[kind].sequence < sequence) continue;
					this.send(peer, {
						type: "head-changed",
						kind,
						sequence: view.heads[kind].sequence,
					});
				}
			})
			.catch((error: unknown) => this.authorizationFailed(peer, error))
			.finally(() => {
				peer.checking = false;
				if (peer.recheck || peer.notices.size) this.check(peer);
			});
	}

	private authorizationFailed(peer: Peer, error: unknown) {
		if (
			error instanceof InterviewProblem &&
			[401, 403, 404].includes(error.status)
		)
			this.endAccess(peer);
		else this.disconnect(peer, 1012);
	}

	private send(peer: Peer, event: WorkspaceEvent) {
		if (peer.closing || peer.socket.readyState !== WebSocket.OPEN) return;
		const message = JSON.stringify(event);
		if (peer.socket.bufferedAmount + Buffer.byteLength(message) > maxBacklog)
			return this.disconnect(peer, 1013);
		peer.socket.send(message);
	}

	private disconnect(peer: Peer, code: number) {
		if (peer.closing) return;
		peer.closing = true;
		clearTimeout(peer.bindTimer);
		peer.socket.close(code);
	}

	private endAccess(peer: Peer) {
		this.send(peer, { type: "access-ended" });
		this.disconnect(peer, 1008);
	}

	async stop() {
		this.stopped = true;
		this.listening = false;
		clearTimeout(this.retry);
		clearInterval(this.heartbeat);
		for (const socket of this.server.clients) socket.terminate();
		await this.listener?.end().catch(() => {});
	}
}
