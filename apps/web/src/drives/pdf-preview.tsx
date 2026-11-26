import {
	AnnotationMode,
	GlobalWorkerOptions,
	getDocument,
	type PDFDocumentProxy,
	type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type ReactNode, useEffect, useRef, useState } from "react";

GlobalWorkerOptions.workerSrc = workerUrl;

function PdfPage({
	pdf,
	number,
	width,
}: {
	pdf: PDFDocumentProxy;
	number: number;
	width: number;
}) {
	const surface = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [aspect, setAspect] = useState(8.5 / 11);
	const [status, setStatus] = useState<"waiting" | "rendered" | "failed">(
		"waiting",
	);
	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				setVisible(entry.isIntersecting);
			},
			{ rootMargin: "300px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const element = surface.current;
		if (!element || !visible || width < 1) return;
		const canvas = document.createElement("canvas");
		canvas.className = "block h-auto w-full";
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", `Page ${number} of ${pdf.numPages}`);
		element.append(canvas);
		let cancelled = false;
		let render: RenderTask | undefined;
		setStatus("waiting");
		async function draw() {
			const page = await pdf.getPage(number);
			if (cancelled) return;
			const natural = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: width / natural.width });
			const pixelRatio = Math.min(
				window.devicePixelRatio || 1,
				2,
				Math.sqrt(5_000_000 / (viewport.width * viewport.height)),
				4096 / Math.max(viewport.width, viewport.height),
			);
			canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
			canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
			setAspect(natural.width / natural.height);
			render = page.render({
				canvas,
				viewport,
				transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
				annotationMode: AnnotationMode.ENABLE,
				background: "#fff",
			});
			await render.promise;
			if (!cancelled) setStatus("rendered");
		}
		void draw().catch(() => {
			if (!cancelled) setStatus("failed");
		});
		return () => {
			cancelled = true;
			render?.cancel();
			canvas.remove();
			canvas.width = 0;
			canvas.height = 0;
		};
	}, [number, pdf, visible, width]);

	return (
		<figure className="mx-auto" style={{ width }}>
			<div
				ref={surface}
				style={{ aspectRatio: aspect }}
				data-rendered={status === "rendered" && visible}
				className="relative overflow-hidden rounded-sm border bg-white [&_canvas]:absolute [&_canvas]:inset-0"
			>
				{status === "failed" && (
					<p className="relative z-10 bg-popover p-4" role="alert">
						Page {number} couldn’t be rendered. Download the original to view
						it.
					</p>
				)}
			</div>
			<figcaption className="mt-2 text-center text-xs tabular-nums text-muted-foreground">
				Page {number} of {pdf.numPages}
			</figcaption>
		</figure>
	);
}

export default function PdfPreview({
	source,
	zoomed,
	loading,
	error,
}: {
	source: string;
	zoomed: boolean;
	loading: ReactNode;
	error: ReactNode;
}) {
	const container = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [pdf, setPdf] = useState<PDFDocumentProxy>();
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			setWidth(Math.min(816, Math.floor(entry.contentRect.width)));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const task = getDocument({
			url: source,
			disableRange: true,
			enableXfa: false,
			maxImageSize: 32_000_000,
			useSystemFonts: true,
			cMapUrl: "/pdf-assets/cmaps/",
			standardFontDataUrl: "/pdf-assets/standard_fonts/",
			iccUrl: "/pdf-assets/iccs/",
			wasmUrl: "/pdf-assets/wasm/",
			stopAtErrors: true,
		});
		let cancelled = false;
		const timer = window.setTimeout(() => {
			if (cancelled) return;
			setFailed(true);
			void task.destroy().catch(() => undefined);
		}, 20_000);
		void task.promise
			.then((loaded) => {
				if (cancelled) return;
				if (loaded.numPages > 50) setFailed(true);
				else setPdf(loaded);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			})
			.finally(() => window.clearTimeout(timer));
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			void task.destroy().catch(() => undefined);
		};
	}, [source]);

	return (
		<div ref={container} className="flex w-full min-w-0 flex-col gap-5">
			{failed
				? error
				: !pdf || !width
					? loading
					: Array.from({ length: pdf.numPages }, (_, index) => index + 1).map(
							(number) => (
								<PdfPage
									key={number}
									pdf={pdf}
									number={number}
									width={zoomed ? Math.floor(width * 1.5) : width}
								/>
							),
						)}
		</div>
	);
}
