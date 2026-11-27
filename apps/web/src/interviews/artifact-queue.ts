import {
	type ArtifactHead,
	type ArtifactKind,
	type ArtifactPayload,
	artifactHeadSchema,
	artifactSnapshotSchema,
	emptyArtifactHead,
	workspacePayloadSchemas,
} from "@studio/contracts";
import { InterviewRequestError } from "./api";

type Snapshot<K extends ArtifactKind> = ArtifactHead & {
	payload: ArtifactPayload[K];
};
type Save<K extends ArtifactKind> = {
	commandId: string;
	baseSequence: number;
	payload: ArtifactPayload[K];
};
export type ArtifactStatus =
	| "Saved"
	| "Saving"
	| "Reconnecting"
	| "Unsaved changes";
export type ArtifactState<K extends ArtifactKind> = {
	draft?: ArtifactPayload[K];
	preview?: Snapshot<K>;
	status: ArtifactStatus;
	error?: unknown;
	conflict: boolean;
	dirty: boolean;
};
type Access<K extends ArtifactKind> = {
	read: () => Promise<Snapshot<K>>;
	save: (input: Save<K>) => Promise<ArtifactHead>;
	onTerminal: (error: unknown) => void;
};

export const isTransientWorkspaceError = (error: unknown) =>
	!(error instanceof InterviewRequestError) ||
	[408, 429].includes(error.status) ||
	error.status >= 500;

export const parseArtifactHead = artifactHeadSchema.parse;
export function parseArtifactSnapshot<K extends ArtifactKind>(
	kind: K,
	value: unknown,
): Snapshot<K> {
	return artifactSnapshotSchema(kind).parse(value) as Snapshot<K>;
}

function samePayload<K extends ArtifactKind>(
	left: ArtifactPayload[K] | undefined,
	right: ArtifactPayload[K] | undefined,
) {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export class ArtifactQueue<K extends ArtifactKind> {
	private readonly kind: K;
	private readonly access: Access<K>;
	private base?: Snapshot<K>;
	private observed: ArtifactHead = emptyArtifactHead;
	private pending?: Save<K>;
	private saving?: Promise<void>;
	private reading?: Promise<void>;
	private reread = false;
	private timer?: ReturnType<typeof setTimeout>;
	private dirtySince?: number;
	private failures = 0;
	private retryAt = 0;
	private invalid?: unknown;
	private paused = false;
	private requested = false;
	private closed = false;
	private readonly subscribers = new Set<() => void>();
	private state: ArtifactState<K> = {
		status: "Saved",
		conflict: false,
		dirty: false,
	};

	constructor(kind: K, access: Access<K>) {
		this.kind = kind;
		this.access = access;
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	};
	private update(patch: Partial<ArtifactState<K>>) {
		if (this.closed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.subscribers) listener();
	}
	get head() {
		return this.base ?? this.observed;
	}

	start() {
		this.requested = true;
		return this.refresh();
	}
	pause(paused: boolean) {
		this.paused = paused;
		clearTimeout(this.timer);
		if (!paused) this.schedule();
	}
	clear() {
		clearTimeout(this.timer);
		this.pending = undefined;
		this.base = undefined;
		this.update({
			draft: undefined,
			preview: undefined,
			dirty: false,
			error: undefined,
			conflict: false,
		});
		this.closed = true;
	}
	observe(head: ArtifactHead) {
		if (this.closed || head.sequence < this.observed.sequence) return;
		this.observed = head;
		if (!this.requested || this.saving || this.pending || !this.base) return;
		if (head.sequence <= this.base.sequence) return;
		if (this.state.dirty) this.conflict();
		else void this.refresh();
	}
	edit(payload: ArtifactPayload[K], invalid?: unknown) {
		if (!this.base || this.closed || this.paused) return;
		if (samePayload(this.state.draft, payload) && invalid === this.invalid)
			return;
		this.invalid = invalid;
		const dirty =
			!!this.pending ||
			invalid !== undefined ||
			!samePayload(this.base.payload, payload);
		this.dirtySince = dirty ? (this.dirtySince ?? Date.now()) : undefined;
		this.update({
			draft: payload,
			dirty,
			status: this.saving ? "Saving" : dirty ? "Unsaved changes" : "Saved",
			...(!this.pending && !this.state.conflict ? { error: invalid } : {}),
		});
		if (dirty && !this.pending && this.observed.sequence > this.base.sequence)
			this.conflict();
		if (!dirty) void this.refresh();
		this.schedule();
	}
	private schedule() {
		clearTimeout(this.timer);
		if (
			this.closed ||
			this.paused ||
			this.saving ||
			!this.state.dirty ||
			this.state.conflict ||
			(!this.pending && this.invalid !== undefined) ||
			(this.state.error !== undefined &&
				!isTransientWorkspaceError(this.state.error))
		)
			return;
		const now = Date.now();
		const elapsed = now - (this.dirtySince ?? now);
		const delay = this.retryAt
			? Math.max(0, this.retryAt - now)
			: Math.max(0, Math.min(750, 5_000 - elapsed));
		this.timer = setTimeout(() => void this.saveOne().catch(() => {}), delay);
	}
	private conflict() {
		clearTimeout(this.timer);
		this.update({
			conflict: true,
			status: "Unsaved changes",
			error: new InterviewRequestError(409, {
				error: "workspace_conflict",
				kind: this.kind,
			}),
		});
	}
	async refresh() {
		if (this.closed || this.state.dirty || !this.requested) return;
		if (this.reading) {
			this.reread = true;
			return this.reading;
		}
		if (
			this.base &&
			this.base.sequence >= this.observed.sequence &&
			this.state.error === undefined
		)
			return;
		this.reading = (async () => {
			try {
				const latest = await this.access.read();
				if (this.closed) return;
				if (latest.sequence >= this.observed.sequence) this.observed = latest;
				if (this.state.dirty) {
					if (
						!this.pending &&
						this.base &&
						latest.sequence > this.base.sequence
					)
						this.conflict();
				} else if (
					latest.sequence >= (this.base?.sequence ?? 0) &&
					latest.sequence >= this.observed.sequence
				) {
					this.base = latest;
					this.update({
						draft: latest.payload,
						status: "Saved",
						error: undefined,
						conflict: false,
						preview: undefined,
					});
				}
			} catch (error) {
				this.access.onTerminal(error);
				if (!this.state.dirty) this.update({ error, status: "Reconnecting" });
			}
		})().finally(() => {
			this.reading = undefined;
			if (this.reread) {
				this.reread = false;
				void this.refresh();
			}
		});
		return this.reading;
	}
	async inspect() {
		try {
			const preview = await this.access.read();
			if (preview.sequence >= this.observed.sequence) this.observed = preview;
			this.update({ preview });
		} catch (error) {
			this.access.onTerminal(error);
			throw error;
		}
	}
	async discardDraft() {
		if (this.saving || this.pending)
			throw this.state.error ?? new Error("Save is in progress");
		if (this.closed) return;
		await this.inspect();
		const snapshot = this.state.preview;
		if (!snapshot || this.closed) return;
		this.base = snapshot;
		this.invalid = undefined;
		this.dirtySince = undefined;
		this.update({
			draft: snapshot.payload,
			preview: undefined,
			dirty: false,
			status: "Saved",
			error: undefined,
			conflict: false,
		});
		void this.refresh();
	}
	private saveOne(): Promise<void> {
		if (this.saving) return this.saving;
		if (this.closed || !this.state.dirty || !this.base || !this.state.draft)
			return Promise.resolve();
		if (this.state.conflict) return Promise.reject(this.state.error);
		if (!this.pending) {
			if (this.invalid !== undefined) return Promise.reject(this.invalid);
			const parsed = workspacePayloadSchemas[this.kind].safeParse(
				this.state.draft,
			);
			if (!parsed.success) {
				const error = new InterviewRequestError(422, {
					error: "workspace_invalid",
					kind: this.kind,
					field: parsed.error.issues[0]?.path.join("."),
				});
				this.update({ error, status: "Unsaved changes" });
				return Promise.reject(error);
			}
			// Parsing validates the draft. Retain its identity to detect edits made during the save.
			this.pending = {
				commandId: crypto.randomUUID(),
				baseSequence: this.base.sequence,
				payload: this.state.draft,
			};
		}
		const command = this.pending;
		this.update({ status: "Saving", error: undefined });
		this.saving = (async () => {
			try {
				const saved = await this.access.save(command);
				if (this.closed) return;
				this.pending = undefined;
				this.base = { ...saved, payload: command.payload };
				if (saved.sequence >= this.observed.sequence) this.observed = saved;
				const dirty =
					this.invalid !== undefined ||
					!samePayload(this.state.draft, command.payload);
				this.dirtySince = dirty ? (this.dirtySince ?? Date.now()) : undefined;
				this.failures = 0;
				this.retryAt = 0;
				this.update({
					status: dirty ? "Unsaved changes" : "Saved",
					dirty,
					error: this.invalid,
				});
				if (dirty && this.observed.sequence > saved.sequence) this.conflict();
				if (!dirty) void this.refresh();
			} catch (error) {
				this.access.onTerminal(error);
				if (this.closed) throw error;
				const transient = isTransientWorkspaceError(error);
				if (transient) {
					this.failures++;
					const serverWait =
						error instanceof InterviewRequestError
							? (error.problem?.retryAfter ?? 0) * 1_000
							: 0;
					this.retryAt =
						Date.now() +
						Math.max(
							serverWait,
							Math.min(10_000, 1_000 * 2 ** Math.min(this.failures - 1, 4)),
						);
				} else {
					this.pending = undefined;
					this.retryAt = 0;
				}
				if (
					error instanceof InterviewRequestError &&
					error.problem?.error === "workspace_conflict"
				) {
					if (
						error.problem.head &&
						error.problem.head.sequence >= this.observed.sequence
					)
						this.observed = error.problem.head;
					this.conflict();
				} else {
					this.update({
						error,
						status: transient ? "Reconnecting" : "Unsaved changes",
					});
				}
				throw error;
			}
		})().finally(() => {
			this.saving = undefined;
			this.schedule();
		});
		return this.saving;
	}
	async flush() {
		clearTimeout(this.timer);
		while (this.state.dirty && !this.closed) {
			await this.saveOne();
		}
	}
}
