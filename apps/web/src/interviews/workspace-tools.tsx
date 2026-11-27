import type { ArtifactKind, ArtifactPayload } from "@studio/contracts";
import { Code2, Maximize2, Minimize2, PenTool } from "lucide-react";
import {
	Component,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InterviewRequestError } from "./api";
import type { ArtifactQueue, ArtifactState } from "./artifact-queue";
import { AssessmentNavigation } from "./assessment-navigation";
import { InterviewAlert } from "./display";
import { loadWorkspaceBoard } from "./workspace-board-entry";
import {
	artifactLabel,
	type WorkspaceClient,
	type WorkspaceView,
} from "./workspace-client";
import type { WorkspaceExecution } from "./workspace-code-run";

const codeLoader = () =>
	import("./workspace-code").then((module) => ({
		default: module.WorkspaceCode,
	}));

class ToolErrorBoundary extends Component<
	{ children: ReactNode; onRetry: () => void },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? (
			<div className="flex flex-col items-start gap-2 px-4 py-5">
				<p role="alert">Couldn’t load this tool.</p>
				<Button variant="outline" size="sm" onClick={this.props.onRetry}>
					Retry tool
				</Button>
			</div>
		) : (
			this.props.children
		);
	}
}

function ArtifactPanel<K extends ArtifactKind>({
	kind,
	queue,
	state,
	candidate,
	frozen,
	reviewUnfinished = false,
	finalPending,
	load,
	renderPreview,
	execution,
}: {
	kind: K;
	queue: ArtifactQueue<K>;
	state: ArtifactState<K>;
	candidate: boolean;
	frozen: boolean;
	reviewUnfinished?: boolean;
	finalPending: boolean;
	execution?: WorkspaceExecution;
	load: () => Promise<{
		default: (props: {
			value: ArtifactPayload[K];
			readOnly: boolean;
			onChange: (value: ArtifactPayload[K], invalid?: unknown) => void;
			execution?: WorkspaceExecution;
		}) => ReactNode;
	}>;
	renderPreview: (payload: ArtifactPayload[K]) => ReactNode;
}) {
	const [Tool, setTool] = useState(() => lazy(load));
	const [retry, setRetry] = useState(0);
	const [inspectError, setInspectError] = useState<unknown>();
	const [recovering, setRecovering] = useState(false);
	const [discard, setDiscard] = useState(false);
	const label = artifactLabel[kind];
	useEffect(() => {
		void queue.start();
	}, [queue]);

	async function recover(action: "inspect" | "discard") {
		if (recovering) return;
		setInspectError(undefined);
		setRecovering(true);
		try {
			if (action === "inspect") await queue.inspect();
			else {
				await queue.discardDraft();
				setDiscard(false);
			}
		} catch (error) {
			setInspectError(error);
		} finally {
			setRecovering(false);
		}
	}
	const problem =
		state.error instanceof InterviewRequestError
			? state.error.problem
			: undefined;

	return (
		<>
			{state.error !== undefined &&
				(problem?.error !== "workspace_incomplete" || reviewUnfinished) && (
					<div className="flex flex-col gap-3 border-b p-3">
						<InterviewAlert error={state.error} />
						{problem?.field && kind === "board" && (
							<p className="text-sm text-muted-foreground">
								{label} field <code>{problem.field}</code>
							</p>
						)}
						<div className="flex flex-wrap items-center gap-2">
							{state.conflict && (
								<Button
									size="sm"
									variant="outline"
									disabled={recovering}
									onClick={() => void recover("inspect")}
								>
									Inspect saved {label.toLowerCase()}
								</Button>
							)}
							{state.dirty &&
								!discard &&
								problem?.error !== "workspace_timeout" && (
									<Button
										size="sm"
										variant="outline"
										disabled={frozen || state.status === "Reconnecting"}
										onClick={() => setDiscard(true)}
									>
										Discard unsaved changes
									</Button>
								)}
							{!state.dirty && (
								<Button
									size="sm"
									variant="outline"
									onClick={() => void queue.refresh()}
								>
									Retry {label.toLowerCase()}
								</Button>
							)}
							{discard && (
								<>
									<Button
										size="sm"
										variant="destructive"
										disabled={recovering || frozen}
										onClick={() => void recover("discard")}
									>
										Discard and load saved {label.toLowerCase()}
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => setDiscard(false)}
									>
										Keep editing
									</Button>
								</>
							)}
						</div>
						{inspectError !== undefined && (
							<InterviewAlert error={inspectError} />
						)}
						{state.preview && (
							<div className="min-w-0 rounded-md border bg-background p-3">
								<p className="text-sm font-medium">
									Current saved {label.toLowerCase()}
								</p>
								{kind === "board" ? (
									<Suspense
										fallback={
											<p className="text-sm">Loading saved whiteboard…</p>
										}
									>
										<Tool
											value={state.preview.payload}
											onChange={() => {}}
											readOnly
										/>
									</Suspense>
								) : (
									renderPreview(state.preview.payload)
								)}
							</div>
						)}
					</div>
				)}
			{state.draft && !finalPending ? (
				<ToolErrorBoundary
					key={retry}
					onRetry={() => {
						setTool(lazy(load));
						setRetry((value) => value + 1);
					}}
				>
					<Suspense
						fallback={
							<p role="status" className="p-4 text-sm text-muted-foreground">
								Loading {label.toLowerCase()}…
							</p>
						}
					>
						<Tool
							value={state.draft}
							onChange={(value, invalid) => queue.edit(value, invalid)}
							readOnly={!candidate || frozen}
							execution={execution}
						/>
					</Suspense>
				</ToolErrorBoundary>
			) : state.error === undefined ? (
				<p role="status" className="p-4 text-sm text-muted-foreground">
					Loading saved {label.toLowerCase()}…
				</p>
			) : null}
		</>
	);
}

export function WorkspaceTools({
	client,
	view,
	candidate,
	frozen = false,
	kind: controlledKind,
	onKindChange,
	reviewUnfinished,
}: {
	client: WorkspaceClient;
	view: WorkspaceView;
	candidate: boolean;
	frozen?: boolean;
	kind?: ArtifactKind;
	onKindChange?: (kind: ArtifactKind) => void;
	reviewUnfinished?: boolean;
}) {
	const code = useSyncExternalStore(
		client.code.subscribe,
		client.code.getSnapshot,
	);
	const board = useSyncExternalStore(
		client.board.subscribe,
		client.board.getSnapshot,
	);
	const [selectedKind, setSelectedKind] = useState<ArtifactKind>("code");
	const [expanded, setExpanded] = useState(false);
	const workspace = useRef<HTMLDialogElement>(null);
	const expandButton = useRef<HTMLButtonElement>(null);
	const kind = controlledKind ?? selectedKind;
	const [visited, setVisited] = useState({ code: true, board: false });
	const state = kind === "code" ? code : board;
	const ready = Boolean(view.descriptor);
	const finalPending = (tool: ArtifactKind) =>
		!candidate &&
		view.descriptor?.active === false &&
		(!(tool === "code" ? code : board).draft ||
			client[tool].head.sequence < view.descriptor.heads[tool].sequence);
	useEffect(() => {
		setVisited((previous) =>
			previous[kind] ? previous : { ...previous, [kind]: true },
		);
	}, [kind]);

	function openWorkspace() {
		const dialog = workspace.current;
		if (!dialog) return;
		dialog.close();
		dialog.showModal();
		setExpanded(true);
		expandButton.current?.focus();
	}

	function closeWorkspace() {
		const dialog = workspace.current;
		if (!dialog) return;
		dialog.close();
		dialog.show();
		setExpanded(false);
		expandButton.current?.focus({ preventScroll: true });
	}

	if (view.terminal) return <InterviewAlert error={view.terminal} />;
	const status =
		!ready || view.hidden
			? view.error
				? "Reconnecting"
				: "Opening workspace…"
			: candidate
				? state.status === "Saved" && !view.connected
					? "Saved · Reconnecting"
					: state.status
				: finalPending(kind)
					? "Loading final saved work…"
					: view.descriptor?.active === false
						? "Final saved work · Read only"
						: view.connected
							? "Live · Read only"
							: "Reconnecting · Read only";

	return (
		<dialog
			ref={workspace}
			open
			data-interview-workspace
			aria-label={expanded ? "Interview workspace" : undefined}
			className="relative inset-auto m-0 w-full min-w-0 max-w-none overflow-hidden rounded-xl border bg-card text-card-foreground"
			onCancel={(event) => {
				event.preventDefault();
				closeWorkspace();
			}}
		>
			{candidate && (
				<AssessmentNavigation
					dirty={code.dirty || board.dirty}
					saving={false}
				/>
			)}
			<section aria-label={expanded ? undefined : "Interview workspace"}>
				<Tabs
					value={kind}
					onValueChange={(value) => {
						if (value !== "code" && value !== "board") return;
						if (onKindChange) onKindChange(value);
						else setSelectedKind(value);
					}}
					className="gap-0"
				>
					<div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-3 py-2">
						<TabsList aria-label="Interview tools">
							<TabsTrigger value="code" className="px-2">
								<Code2 aria-hidden="true" />
								Code
							</TabsTrigger>
							<TabsTrigger value="board" className="px-2">
								<PenTool aria-hidden="true" />
								Whiteboard
							</TabsTrigger>
						</TabsList>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<p role="status" className="text-xs text-muted-foreground">
								{status}
							</p>
							<Button
								ref={expandButton}
								variant="ghost"
								size="sm"
								onClick={expanded ? closeWorkspace : openWorkspace}
							>
								{expanded ? <Minimize2 /> : <Maximize2 />}
								{expanded ? "Exit full screen" : "Full screen"}
							</Button>
						</div>
					</div>
					{view.error !== undefined && !ready && (
						<div className="flex flex-col items-start gap-2 p-4">
							<InterviewAlert error={view.error} />
							<Button variant="outline" size="sm" onClick={client.retry}>
								Retry workspace
							</Button>
						</div>
					)}
					{ready && (
						<>
							<TabsContent
								value="code"
								keepMounted
								className="min-w-0"
								inert={view.hidden}
								data-workspace-content
							>
								{(visited.code || kind === "code") && (
									<ArtifactPanel
										kind="code"
										candidate={candidate}
										frozen={frozen || view.hidden}
										queue={client.code}
										state={code}
										finalPending={finalPending("code")}
										load={codeLoader}
										execution={{
											client,
											enabled: view.descriptor?.executionEnabled === true,
											latest: view.descriptor?.latestRun,
										}}
										renderPreview={(payload) => (
											<pre className="mt-2 max-h-48 overflow-auto text-xs">
												{payload.source}
											</pre>
										)}
									/>
								)}
							</TabsContent>
							<TabsContent
								value="board"
								keepMounted
								className="min-w-0"
								inert={view.hidden}
								data-workspace-content
							>
								{(visited.board || kind === "board") && (
									<ArtifactPanel
										kind="board"
										reviewUnfinished={reviewUnfinished}
										candidate={candidate}
										frozen={frozen || view.hidden}
										queue={client.board}
										state={board}
										finalPending={finalPending("board")}
										load={loadWorkspaceBoard}
										renderPreview={() => null}
									/>
								)}
							</TabsContent>
						</>
					)}
				</Tabs>
			</section>
		</dialog>
	);
}
