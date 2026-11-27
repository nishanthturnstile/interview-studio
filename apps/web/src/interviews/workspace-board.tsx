import {
	CaptureUpdateAction,
	Excalidraw,
	MainMenu,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
	ExcalidrawImperativeAPI,
	ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import {
	type ArtifactPayload,
	type BoardElement,
	boardElementSchemas,
} from "@studio/contracts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useDarkMode } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { InterviewRequestError } from "./api";
import "@excalidraw/excalidraw/index.css";
import "./workspace-board.css";

type Board = ArtifactPayload["board"];
type BoardChange = NonNullable<ExcalidrawProps["onChange"]>;

const tools = new Set([
	"selection",
	"hand",
	"rectangle",
	"diamond",
	"ellipse",
	"line",
	"arrow",
	"freedraw",
	"text",
	"eraser",
]);
const unfinishedEdit = new InterviewRequestError(422, {
	error: "workspace_incomplete",
	kind: "board",
});
const uiOptions = {
	tools: { image: false },
	canvasActions: {
		changeViewBackgroundColor: false,
		export: false,
		loadScene: false,
		saveToActiveFile: false,
		toggleTheme: false,
		saveAsImage: false,
	},
} satisfies ExcalidrawProps["UIOptions"];

function restoreElements(scene: Board): ExcalidrawElement[] {
	// The saved list defines stacking. Excalidraw assigns fractional indices on load.
	return scene.elements.map((element) => ({
		...structuredClone(element),
		version: 1,
		versionNonce: 0,
		index: null,
		updated: 0,
		isDeleted: false,
		frameId: null,
		link: null,
		...("points" in element ? { lastCommittedPoint: null } : {}),
	})) as ExcalidrawElement[];
}

function unsupported(element: ExcalidrawElement) {
	return (
		!Object.hasOwn(boardElementSchemas, element.type) ||
		element.link ||
		element.frameId
	);
}
function projectElement(element: ExcalidrawElement): BoardElement {
	const allowed =
		boardElementSchemas[element.type as keyof typeof boardElementSchemas];
	return structuredClone(
		Object.fromEntries(
			Object.keys(allowed.shape).map((key) => [
				key,
				element[key as keyof ExcalidrawElement],
			]),
		),
	) as BoardElement;
}
function signature(elements: readonly ExcalidrawElement[]) {
	return elements
		.map(({ id, version, versionNonce }) => `${id}:${version}:${versionNonce}`)
		.join("|");
}

export function BoardSummary({ scene }: { scene: Board }) {
	const text = scene.elements.flatMap((element) =>
		element.type === "text" ? [element] : [],
	);
	return (
		<details className="border-t px-3 py-2 text-sm">
			<summary className="cursor-pointer font-medium">
				Scene summary · {scene.elements.length}{" "}
				{scene.elements.length === 1 ? "element" : "elements"}
			</summary>
			{text.length ? (
				<ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
					{text.map((element) => (
						<li className="whitespace-pre-wrap wrap-anywhere" key={element.id}>
							{element.text}
						</li>
					))}
				</ul>
			) : (
				<p className="mt-2 text-muted-foreground">No text on this board.</p>
			)}
		</details>
	);
}

export function WorkspaceBoard({
	value,
	readOnly,
	onChange,
}: {
	value: Board;
	readOnly: boolean;
	onChange: (value: Board, invalid?: unknown) => void;
}) {
	const dark = useDarkMode();
	const initial = useRef(value);
	const api = useRef<ExcalidrawImperativeAPI | null>(null);
	const applied = useRef(value);
	const version = useRef<string | undefined>(undefined);
	const applying = useRef(false);
	const inProgress = useRef(false);
	const heading = useRef<HTMLButtonElement>(null);
	const [notice, setNotice] = useState<string>();
	const [initialData] = useState(() => ({
		elements: restoreElements(initial.current),
		scrollToContent: true,
	}));
	const attachApi = useCallback((instance: ExcalidrawImperativeAPI) => {
		api.current = instance;
	}, []);

	useLayoutEffect(() => {
		if (!api.current || applied.current === value) return;
		applied.current = value;
		inProgress.current = false;
		const elements = restoreElements(value);
		applying.current = true;
		api.current.updateScene({
			elements,
			captureUpdate: CaptureUpdateAction.NEVER,
		});
		api.current.history.clear();
		version.current = signature(api.current.getSceneElements());
		applying.current = false;
	}, [value]);

	const handleChange: BoardChange = (elements, state) => {
		if (readOnly || applying.current) return;
		if (!tools.has(state.activeTool.type))
			api.current?.setActiveTool({ type: "selection" });
		if (state.isLoading) return;
		if (
			state.newElement ||
			state.multiElement ||
			state.editingTextElement ||
			state.isResizing ||
			state.isRotating ||
			state.selectedElementsAreBeingDragged
		) {
			if (!inProgress.current) {
				inProgress.current = true;
				onChange(applied.current, unfinishedEdit);
			}
			return;
		}
		const completed = inProgress.current;
		inProgress.current = false;
		const current = elements.filter((element) => !element.isDeleted);
		const nextVersion = signature(current);
		if (version.current === undefined) {
			version.current = nextVersion;
			if (completed) onChange(applied.current);
			return;
		}
		if (version.current === nextVersion) {
			if (completed) onChange(applied.current);
			return;
		}
		version.current = nextVersion;
		if (current.some(unsupported)) {
			setNotice("Remove links and unsupported objects before saving.");
			onChange(
				applied.current,
				new InterviewRequestError(422, {
					error: "workspace_invalid",
					kind: "board",
					field: "elements",
				}),
			);
			return;
		}
		setNotice(undefined);
		const next = { elements: current.map(projectElement) };
		applied.current = next;
		onChange(next);
	};
	const blockImport = () =>
		setNotice("Only plain text can be pasted while editing a text element.");

	return (
		<div
			className="studio-whiteboard"
			data-workspace-tool
			onDragOverCapture={(event) => event.preventDefault()}
			onDropCapture={(event) => {
				event.preventDefault();
				event.stopPropagation();
				blockImport();
			}}
			onPasteCapture={(event) => {
				if (
					event.target instanceof HTMLTextAreaElement &&
					!event.clipboardData.files.length
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				blockImport();
			}}
			onContextMenuCapture={(event) => {
				if (
					event.target instanceof HTMLTextAreaElement ||
					event.target instanceof HTMLInputElement
				)
					return;
				event.preventDefault();
				event.stopPropagation();
			}}
			onKeyDownCapture={(event) => {
				if (
					(event.metaKey || event.ctrlKey) &&
					event.key.toLowerCase() === "k"
				) {
					event.preventDefault();
					event.stopPropagation();
					return;
				}
				if (event.key !== "Escape") return;
				if (heading.current?.contains(event.target as Node)) return;
				if (event.currentTarget.closest("dialog:modal")) event.preventDefault();
				if (event.target instanceof HTMLTextAreaElement) return;
				requestAnimationFrame(() => heading.current?.focus());
			}}
		>
			<fieldset
				aria-label="Whiteboard controls"
				className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2"
			>
				<Button
					ref={heading}
					variant="outline"
					size="sm"
					onClick={() => api.current?.scrollToContent()}
				>
					Center drawing
				</Button>
				<span className="text-xs text-muted-foreground">
					{readOnly
						? "Pan and zoom to inspect the board. Esc returns to controls."
						: "T adds text. Delete erases selection. Ctrl or ⌘ + Z undoes. Esc returns to controls."}
				</span>
			</fieldset>
			{notice && (
				<p role="status" className="border-b px-3 py-2 text-sm">
					{notice}
				</p>
			)}
			<section
				className="relative h-[var(--workspace-board-height,clamp(23rem,55vh,38rem))]"
				aria-label="Drawing canvas"
				data-workspace-surface
			>
				<Excalidraw
					excalidrawAPI={attachApi}
					initialData={initialData}
					onChange={handleChange}
					onPaste={() => false}
					onLinkOpen={(_, event) => event.preventDefault()}
					viewModeEnabled={readOnly}
					handleKeyboardGlobally={false}
					isCollaborating={false}
					aiEnabled={false}
					validateEmbeddable={false}
					theme={dark ? "dark" : "light"}
					UIOptions={uiOptions}
				>
					<MainMenu>
						<MainMenu.Item onSelect={() => api.current?.scrollToContent()}>
							Center drawing
						</MainMenu.Item>
					</MainMenu>
				</Excalidraw>
			</section>
			{readOnly && <BoardSummary scene={value} />}
		</div>
	);
}
