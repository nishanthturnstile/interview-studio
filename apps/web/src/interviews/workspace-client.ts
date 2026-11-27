import {
	type ArtifactKind,
	type CodeRunRequest,
	codeRunOutputSchema,
	codeRunPending,
	codeRunSummarySchema,
	type WorkspaceDescriptor,
	type WorkspaceHeadIds,
	workspaceDescriptorSchema,
	workspaceEventSchema,
} from "@studio/contracts";
import { accessDenied, InterviewRequestError, interviewRequest } from "./api";
import {
	ArtifactQueue,
	parseArtifactHead,
	parseArtifactSnapshot,
} from "./artifact-queue";

export const artifactLabel = { code: "Code", board: "Whiteboard" } as const;

const descriptorPath = (path: string) => `${path}/workspace`;

export type WorkspaceView = {
	descriptor?: WorkspaceDescriptor;
	error?: unknown;
	terminal?: unknown;
	connected: boolean;
	hidden: boolean;
};
const initialState: WorkspaceView = { connected: false, hidden: false };

export class WorkspaceClient {
	private readonly abort = new AbortController();
	private readonly subscribers = new Set<() => void>();
	private state = initialState;
	private readonly path: string;
	private binding?: string;
	private socket?: WebSocket;
	private timer?: ReturnType<typeof setTimeout>;
	private noticeTimer?: ReturnType<typeof setTimeout>;
	private reconnectDelay = 500;
	private poll?: ReturnType<typeof setInterval>;
	private runPoll?: ReturnType<typeof setTimeout>;
	private runRevision = 0;
	private checking?: Promise<WorkspaceDescriptor>;
	private checkAgain = false;
	private stopped = false;
	private needsFreshAccess = false;
	private accessEpoch = 0;
	private pageSuspended = false;
	readonly code: ArtifactQueue<"code">;
	readonly board: ArtifactQueue<"board">;

	constructor(path: string) {
		this.path = path;
		this.code = this.makeQueue("code");
		this.board = this.makeQueue("board");
	}
	private makeQueue<K extends ArtifactKind>(kind: K) {
		const endpoint = `${descriptorPath(this.path)}/${kind}`;
		return new ArtifactQueue<K>(kind, {
			read: () =>
				interviewRequest(
					endpoint,
					{ parse: (value: unknown) => parseArtifactSnapshot(kind, value) },
					this.options(),
				),
			save: (data) =>
				interviewRequest(
					endpoint,
					{ parse: parseArtifactHead },
					{ ...this.options(), data },
				),
			onTerminal: this.terminateIfDenied,
		});
	}
	private options() {
		return { signal: this.abort.signal, binding: this.binding };
	}
	readRun = (id: string, signal: AbortSignal) =>
		interviewRequest(
			`${descriptorPath(this.path)}/runs/${id}`,
			codeRunOutputSchema,
			{
				...this.options(),
				signal: AbortSignal.any([this.abort.signal, signal]),
			},
		).catch((error: unknown) => {
			this.terminateIfDenied(error);
			throw error;
		});

	async runCode(data: CodeRunRequest) {
		try {
			const run = await interviewRequest(
				`${descriptorPath(this.path)}/runs`,
				codeRunSummarySchema,
				{ ...this.options(), data },
			);
			const descriptor = this.state.descriptor;
			if (descriptor) {
				this.runRevision++;
				const current = descriptor.latestRun;
				this.update({
					descriptor: {
						...descriptor,
						latestRun:
							current?.id === run.id && !codeRunPending(current.state)
								? current
								: run,
					},
				});
			}
		} catch (error) {
			this.terminateIfDenied(error);
			throw error;
		} finally {
			this.reconcileSoon();
		}
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	};
	private update(patch: Partial<WorkspaceView>) {
		if (this.stopped) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.subscribers) listener();
	}
	start() {
		this.poll = setInterval(() => this.reconcileSoon(), 8_000);
		window.addEventListener("focus", this.reconcileSoon);
		window.addEventListener("online", this.reconcileSoon);
		document.addEventListener("visibilitychange", this.visible);
		window.addEventListener("pagehide", this.hidePage);
		window.addEventListener("pageshow", this.restore);
		this.reconcileSoon();
	}
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.abort.abort();
		this.closeSocket();
		clearTimeout(this.noticeTimer);
		clearInterval(this.poll);
		clearTimeout(this.runPoll);
		window.removeEventListener("focus", this.reconcileSoon);
		window.removeEventListener("online", this.reconcileSoon);
		document.removeEventListener("visibilitychange", this.visible);
		window.removeEventListener("pagehide", this.hidePage);
		window.removeEventListener("pageshow", this.restore);
		document.documentElement.removeAttribute("data-interview-workspace-hidden");
		this.code.clear();
		this.board.clear();
	}
	terminateIfDenied = (error: unknown) => {
		if (!accessDenied(error) || this.stopped) return;
		this.update({
			terminal: error,
			hidden: true,
			descriptor: undefined,
			connected: false,
		});
		this.stop();
	};
	private visible = () => {
		if (document.visibilityState === "visible") this.reconcileSoon();
	};
	private hidePage = () => {
		this.pageSuspended = true;
		this.hide();
	};
	private hide() {
		this.accessEpoch++;
		this.needsFreshAccess = true;
		document.documentElement.setAttribute(
			"data-interview-workspace-hidden",
			"",
		);
		this.update({ hidden: true });
	}
	private restore = (event: PageTransitionEvent) => {
		this.pageSuspended = false;
		if (event.persisted) {
			this.accessEpoch++;
			this.reconcileSoon();
		}
	};
	retry = () => this.reconcileSoon();
	private reconcileSoon = () => {
		if (this.stopped || this.pageSuspended) return;
		if (this.checking) {
			this.checkAgain = true;
			return;
		}
		void this.reconcile().catch(() => {});
	};
	private reconcile() {
		if (this.checking) return this.checking;
		const accessEpoch = this.accessEpoch;
		const runRevision = this.runRevision;
		const fresh = this.needsFreshAccess;
		this.checking = interviewRequest(
			descriptorPath(this.path),
			workspaceDescriptorSchema,
			this.options(),
		)
			.then((descriptor) => {
				if (this.stopped) return descriptor;
				this.binding = descriptor.binding;
				if (this.pageSuspended || accessEpoch !== this.accessEpoch)
					return descriptor;
				if (fresh) {
					this.needsFreshAccess = false;
					document.documentElement.removeAttribute(
						"data-interview-workspace-hidden",
					);
				}
				this.code.observe(descriptor.heads.code);
				this.board.observe(descriptor.heads.board);
				void this.code.refresh();
				void this.board.refresh();
				this.update({
					descriptor:
						runRevision === this.runRevision
							? descriptor
							: { ...descriptor, latestRun: this.state.descriptor?.latestRun },
					error: undefined,
					hidden: this.needsFreshAccess,
				});
				if (descriptor.active) this.connect();
				else this.closeSocket();
				return descriptor;
			})
			.catch((error: unknown) => {
				this.terminateIfDenied(error);
				this.update({ error });
				throw error;
			})
			.finally(() => {
				this.checking = undefined;
				clearTimeout(this.runPoll);
				if (
					!this.stopped &&
					codeRunPending(this.state.descriptor?.latestRun?.state)
				)
					this.runPoll = setTimeout(this.reconcileSoon, 1_000);
				if (this.checkAgain) {
					this.checkAgain = false;
					this.reconcileSoon();
				}
			});
		return this.checking;
	}
	private connect() {
		if (this.stopped || this.socket || this.timer || !this.binding) return;
		const url = new URL(`/api${this.path}/live`, window.location.origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(url);
		const binding = this.binding;
		this.socket = socket;
		socket.onopen = () => {
			if (this.socket === socket)
				socket.send(JSON.stringify({ type: "bind", binding }));
		};
		socket.onmessage = ({ data }) => {
			if (this.socket !== socket || typeof data !== "string") return;
			let decoded: unknown;
			try {
				decoded = JSON.parse(data);
			} catch {
				return;
			}
			const event = workspaceEventSchema.safeParse(decoded);
			if (!event.success) return;
			if (event.data.type === "ready") {
				this.reconnectDelay = 500;
				this.update({ connected: true });
				this.reconcileSoon();
			} else if (event.data.type === "access-ended") {
				this.hide();
				this.reconcileSoon();
			} else if (
				event.data.sequence >
				(this.state.descriptor?.heads[event.data.kind].sequence ?? 0)
			) {
				this.noticeTimer ??= setTimeout(() => {
					this.noticeTimer = undefined;
					this.reconcileSoon();
				}, 40);
			}
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.update({ connected: false });
			const wait = this.reconnectDelay;
			this.reconnectDelay = Math.min(10_000, wait * 2);
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.reconcileSoon();
			}, wait);
		};
	}
	private closeSocket() {
		clearTimeout(this.timer);
		this.timer = undefined;
		const previous = this.socket;
		this.socket = undefined;
		previous?.close();
		if (this.state.connected) this.update({ connected: false });
	}
	freeze(value: boolean) {
		this.code.pause(value);
		this.board.pause(value);
	}
	async prepareClose() {
		// An initial descriptor is required even when both tools are empty.
		if (!this.binding) await this.reconcile();
		await Promise.all([
			this.code.flush().catch((error: unknown) => {
				throw new WorkspaceFlushError("code", error);
			}),
			this.board.flush().catch((error: unknown) => {
				throw new WorkspaceFlushError("board", error);
			}),
		]);
		const code = this.code.head.revisionId;
		const board = this.board.head.revisionId;
		if (this.checking) await this.checking;
		const descriptor = await this.reconcile();
		const expectedHeads: WorkspaceHeadIds = { code, board };
		for (const kind of ["code", "board"] as const) {
			if (descriptor.heads[kind].revisionId !== expectedHeads[kind])
				throw new WorkspaceFlushError(
					kind,
					new InterviewRequestError(409, { error: "workspace_conflict", kind }),
				);
		}
		return { binding: descriptor.binding, expectedHeads };
	}
}

export class WorkspaceFlushError extends Error {
	readonly kind: ArtifactKind;
	readonly problem: unknown;
	constructor(kind: ArtifactKind, problem: unknown) {
		super("Workspace could not be saved");
		this.kind = kind;
		this.problem = problem;
	}
}
