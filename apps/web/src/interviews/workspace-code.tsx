import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
	type ArtifactPayload,
	type CodeLanguage,
	codeLanguages,
} from "@studio/contracts";
import { basicSetup } from "codemirror";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useDarkMode } from "@/components/theme";
import {
	WorkspaceCodeRun,
	type WorkspaceExecution,
} from "./workspace-code-run";

type Code = ArtifactPayload["code"];
const languages = {
	javascript: () =>
		import("@codemirror/lang-javascript").then((module) => module.javascript()),
	python: () =>
		import("@codemirror/lang-python").then((module) => module.python()),
	java: () => import("@codemirror/lang-java").then((module) => module.java()),
};
const editorTheme = EditorView.theme({
	"&": {
		height: "var(--workspace-editor-height, clamp(18rem, 42vh, 34rem))",
		color: "var(--foreground)",
		backgroundColor: "var(--background)",
	},
	"&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
	".cm-content": { padding: "0.75rem 0", caretColor: "var(--foreground)" },
	".cm-gutters": {
		backgroundColor: "var(--muted)",
		color: "var(--muted-foreground)",
		border: "none",
		paddingRight: "0.375rem",
	},
	".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--accent)" },
	".cm-scroller": {
		fontFamily: "var(--font-mono, monospace)",
		fontSize: "0.875rem",
	},
});

function switchLanguage(value: Code, language: CodeLanguage): Code {
	const { [language]: saved, ...drafts } = {
		...value.drafts,
		[value.language]: value.source,
	};
	return { language, source: saved ?? codeLanguages[language].starter, drafts };
}

const darkEditorTheme = [
	EditorView.theme(
		{
			".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
				background: "#453655",
			},
			".cm-content ::selection": { background: "#453655" },
		},
		{ dark: true },
	),
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: [tags.keyword, tags.modifier], color: "#d8b9ff" },
			{ tag: [tags.string, tags.regexp], color: "#bce6a0" },
			{ tag: [tags.number, tags.bool, tags.atom], color: "#ffc795" },
			{ tag: [tags.typeName, tags.className], color: "#a9e6df" },
			{
				tag: [
					tags.function(tags.variableName),
					tags.function(tags.propertyName),
				],
				color: "#a5d7ff",
			},
			{ tag: tags.comment, color: "#c5bac7", fontStyle: "italic" },
			{ tag: tags.invalid, color: "#ffb3b6", textDecoration: "underline" },
		]),
	),
];

export function WorkspaceCode({
	value,
	readOnly,
	onChange,
	execution,
}: {
	value: Code;
	readOnly: boolean;
	onChange: (value: Code) => void;
	execution?: WorkspaceExecution;
}) {
	const root = useRef<HTMLDivElement>(null);
	const editor = useRef<EditorView>(null);
	const heading = useRef<HTMLFieldSetElement>(null);
	const dark = useDarkMode();
	const label = useId();
	const help = useId();
	const [language] = useState(() => new Compartment());
	const [languageReady, setLanguageReady] = useState(true);
	const [permissions] = useState(() => new Compartment());
	const [theme] = useState(() => new Compartment());
	const current = useRef({ value, readOnly, onChange, dark });
	current.current = { value, readOnly, onChange, dark };

	// biome-ignore lint/correctness/useExhaustiveDependencies: Recreate the editor on a language change to reset undo history.
	useLayoutEffect(() => {
		if (!root.current) return;
		const view = new EditorView({
			parent: root.current,
			state: EditorState.create({
				doc: current.current.value.source,
				extensions: [
					basicSetup,
					editorTheme,
					theme.of(current.current.dark ? darkEditorTheme : []),
					EditorState.lineSeparator.of("\n"),
					language.of([]),
					permissions.of(editableExtensions(current.current.readOnly)),
					EditorView.contentAttributes.of({
						"aria-label": "Source code",
						"aria-describedby": help,
					}),
					keymap.of([
						{
							key: "Escape",
							run: () => {
								heading.current?.focus();
								return true;
							},
						},
					]),
					EditorView.updateListener.of((update) => {
						if (
							update.docChanged &&
							update.transactions.some(
								(transaction) =>
									transaction.annotation(Transaction.addToHistory) !== false,
							) &&
							!current.current.readOnly
						) {
							current.current.onChange({
								...current.current.value,
								source: update.state.doc.toString(),
							});
						}
					}),
				],
			}),
		});
		editor.current = view;
		return () => {
			view.destroy();
			editor.current = null;
		};
	}, [help, language, permissions, theme, value.language]);
	useLayoutEffect(() => {
		editor.current?.dispatch({
			effects: theme.reconfigure(dark ? darkEditorTheme : []),
		});
	}, [dark, theme]);
	useLayoutEffect(() => {
		const view = editor.current;
		if (!view) return;
		const previous = view.state.doc.toString();
		if (previous === value.source) return;
		let from = 0;
		let to = previous.length;
		let end = value.source.length;
		while (from < to && from < end && previous[from] === value.source[from])
			from++;
		while (
			from < to &&
			from < end &&
			previous[to - 1] === value.source[end - 1]
		) {
			to--;
			end--;
		}
		view.dispatch({
			changes: { from, to, insert: value.source.slice(from, end) },
			annotations: Transaction.addToHistory.of(false),
		});
	}, [value.source]);
	useEffect(() => {
		let current = true;
		void languages[value.language]()
			.then((extension) => {
				if (!current) return;
				editor.current?.dispatch({ effects: language.reconfigure(extension) });
				setLanguageReady(true);
			})
			.catch(() => {
				if (!current) return;
				editor.current?.dispatch({ effects: language.reconfigure([]) });
				setLanguageReady(false);
			});
		return () => {
			current = false;
		};
	}, [language, value.language]);
	useLayoutEffect(() => {
		editor.current?.dispatch({
			effects: permissions.reconfigure(editableExtensions(readOnly)),
		});
	}, [permissions, readOnly]);

	return (
		<WorkspaceCodeRun execution={execution} program={value} readOnly={readOnly}>
			{({ actions, input, output }) => (
				<div data-workspace-tool>
					<fieldset
						ref={heading}
						aria-label="Code controls"
						tabIndex={-1}
						className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2"
					>
						<div className="flex items-center gap-2">
							{readOnly ? (
								<span className="font-medium">Language</span>
							) : (
								<label htmlFor={label} className="font-medium">
									Language
								</label>
							)}
							{readOnly ? (
								<span id={label}>{codeLanguages[value.language].label}</span>
							) : (
								<select
									id={label}
									value={value.language}
									className="rounded-md border bg-background px-2 py-1 focus-visible:outline-2 focus-visible:outline-ring"
									onChange={(event) =>
										onChange(
											switchLanguage(
												current.current.value,
												event.target.value as CodeLanguage,
											),
										)
									}
								>
									{Object.entries(codeLanguages).map(
										([key, { label: text }]) => (
											<option key={key} value={key}>
												{text}
											</option>
										),
									)}
								</select>
							)}
						</div>
						{actions}
						<span id={help} className="text-xs text-muted-foreground">
							Esc returns to code controls.
						</span>
					</fieldset>
					{input}
					{!languageReady && (
						<p
							role="status"
							className="px-3 py-1 text-xs text-muted-foreground"
						>
							Syntax highlighting is unavailable.
						</p>
					)}
					<div ref={root} data-workspace-surface />
					{output}
				</div>
			)}
		</WorkspaceCodeRun>
	);
}

function editableExtensions(readOnly: boolean) {
	return [
		EditorState.readOnly.of(readOnly),
		EditorView.editable.of(!readOnly),
		EditorView.contentAttributes.of({
			tabindex: "0",
			"aria-readonly": readOnly ? "true" : "false",
		}),
	];
}
