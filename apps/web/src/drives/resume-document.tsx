import { type DocumentStatus, wordMediaType } from "@studio/contracts";
import {
	ArrowLeft,
	Download,
	LoaderCircle,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import {
	lazy,
	memo,
	type RefObject,
	Suspense,
	useEffect,
	useState,
} from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { originalUrl, wordPreviewUrl } from "./api";

const PdfPreview = lazy(() => import("./pdf-preview"));

function PreviewLoading() {
	return (
		<p
			role="status"
			className="flex items-center justify-center gap-2 py-12 text-muted-foreground"
		>
			<LoaderCircle
				className="size-4 motion-safe:animate-spin"
				aria-hidden="true"
			/>
			Loading resume…
		</p>
	);
}

function PreviewError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-12 text-center">
			<p role="alert">
				This resume couldn’t be displayed. Try again or download the original.
			</p>
			<Button size="sm" variant="outline" onClick={onRetry}>
				Retry preview
			</Button>
		</div>
	);
}

function FilePreview({
	source,
	word,
	zoomed,
	filename,
	onRetry,
}: {
	source: string;
	word: boolean;
	zoomed: boolean;
	filename: string;
	onRetry: () => void;
}) {
	const [content, setContent] = useState<string>();
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		let imageUrl: string | undefined;
		async function load() {
			const response = await fetch(source, {
				cache: "no-store",
				signal: AbortSignal.any([
					controller.signal,
					AbortSignal.timeout(20_000),
				]),
			});
			if (!response.ok) throw new Error("Preview request failed");
			if (word) {
				const [{ default: purifier }, markup] = await Promise.all([
					import("dompurify"),
					response.text(),
				]);
				const clean = purifier.sanitize(markup, {
					ALLOWED_TAGS: [
						"p",
						"h1",
						"h2",
						"h3",
						"h4",
						"h5",
						"h6",
						"ul",
						"ol",
						"li",
						"table",
						"thead",
						"tbody",
						"tfoot",
						"tr",
						"th",
						"td",
						"strong",
						"em",
						"u",
						"s",
						"sub",
						"sup",
						"br",
						"img",
						"blockquote",
					],
					ALLOWED_ATTR: ["src", "alt", "colspan", "rowspan"],
					ALLOW_DATA_ATTR: false,
					ALLOW_ARIA_ATTR: false,
					ALLOWED_URI_REGEXP: /^data:image\/(?:jpeg|png|gif|webp);base64,/i,
				});
				if (!clean.trim()) throw new Error("Empty preview");
				if (!controller.signal.aborted) setContent(clean);
			} else {
				const blob = await response.blob();
				if (!controller.signal.aborted) {
					imageUrl = URL.createObjectURL(blob);
					setContent(imageUrl);
				}
			}
		}
		void load().catch(() => {
			if (!controller.signal.aborted) setFailed(true);
		});
		return () => {
			controller.abort();
			if (imageUrl) URL.revokeObjectURL(imageUrl);
		};
	}, [source, word]);

	if (failed) return <PreviewError onRetry={onRetry} />;
	if (!content) return <PreviewLoading />;
	return word ? (
		<article
			aria-label="Word document"
			className="mx-auto w-full max-w-3xl overflow-hidden rounded-sm border bg-white p-4 text-base leading-relaxed text-neutral-950 [overflow-wrap:anywhere] sm:p-10 [&_blockquote]:border-l [&_blockquote]:pl-4 [&_h1]:my-4 [&_h1]:text-2xl [&_h2]:mt-5 [&_h2]:text-lg [&_h3]:mt-4 [&_h3]:text-base [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_img]:my-3 [&_img]:h-auto [&_img]:max-w-full [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_table]:my-3 [&_table]:w-full [&_table]:table-fixed [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
			// Mammoth converts the private document and DOMPurify allows only static document markup.
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Content is sanitized before rendering.
			dangerouslySetInnerHTML={{ __html: content }}
		/>
	) : (
		<div
			className={
				zoomed ? "mx-auto w-[150%] max-w-6xl" : "mx-auto w-full max-w-3xl"
			}
		>
			<img
				src={content}
				alt={`Resume scan of ${filename}`}
				className="block h-auto w-full rounded-sm border bg-white"
				onError={() => setFailed(true)}
			/>
		</div>
	);
}

export const ResumeViewer = memo(function ResumeViewer({
	driveId,
	document,
	onClose,
	closeButton,
}: {
	driveId: string;
	document: DocumentStatus;
	onClose: () => void;
	closeButton: RefObject<HTMLButtonElement | null>;
}) {
	const [zoomed, setZoomed] = useState(false);
	const [retry, setRetry] = useState(0);
	const word = document.mediaType === wordMediaType;
	const pdf = document.mediaType === "application/pdf";
	const stored = document.uploadState === "stored";
	const download = originalUrl(driveId, document.id);
	const onRetry = () => setRetry((value) => value + 1);
	const ZoomIcon = zoomed ? ZoomOut : ZoomIn;

	return (
		<section
			aria-label="Resume preview"
			className="flex min-h-0 min-w-0 flex-col lg:border-r"
		>
			<header className="shrink-0 border-b bg-popover px-4 py-3 sm:px-5">
				<div className="flex min-w-0 items-start justify-between gap-3">
					<div className="min-w-0">
						<h3
							className="truncate text-base font-semibold"
							title={document.filename}
						>
							{document.filename}
						</h3>
					</div>
					<Button
						ref={closeButton}
						variant="ghost"
						size="sm"
						onClick={onClose}
						className="shrink-0"
					>
						<ArrowLeft aria-hidden="true" />
						<span className="lg:hidden">Back to candidate</span>
						<span className="hidden lg:inline">Hide resume</span>
					</Button>
				</div>
				{stored && (
					<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
						{word ? (
							<p className="text-xs text-muted-foreground">
								Word formatting may differ from the original.
							</p>
						) : (
							<Button
								size="sm"
								variant="outline"
								onClick={() => setZoomed((value) => !value)}
							>
								<ZoomIcon aria-hidden="true" />
								{zoomed ? "Fit width" : "Zoom in"}
							</Button>
						)}
						<a
							className={buttonVariants({ size: "sm", variant: "ghost" })}
							href={download}
						>
							<Download aria-hidden="true" /> Download original
						</a>
					</div>
				)}
			</header>
			<section
				aria-label="Resume pages"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this scroll pane.
				tabIndex={0}
				className="min-h-0 flex-1 overflow-auto overscroll-contain bg-muted/70 p-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:p-5"
			>
				{!stored ? (
					<p
						role="status"
						className="px-4 py-12 text-center text-muted-foreground"
					>
						{document.uploadState === "pending"
							? "The resume will appear when the upload finishes."
							: "The resume file is unavailable."}
					</p>
				) : pdf ? (
					<Suspense fallback={<PreviewLoading />}>
						<PdfPreview
							key={retry}
							source={download}
							zoomed={zoomed}
							loading={<PreviewLoading />}
							error={<PreviewError onRetry={onRetry} />}
						/>
					</Suspense>
				) : (
					<FilePreview
						key={retry}
						source={word ? wordPreviewUrl(driveId, document.id) : download}
						word={word}
						zoomed={zoomed}
						filename={document.filename}
						onRetry={onRetry}
					/>
				)}
			</section>
		</section>
	);
});
