"use client";

import { type ImgHTMLAttributes, useState } from "react";
import { mediaSrc } from "./media-src";

/** An image the assistant surfaced, read through the backend's media route; one naming another host is its words alone. */
export function MediaImage({ src, alt }: { src: string; alt: string }) {
	const drawable = mediaSrc(src);
	const [state, setState] = useState<"loading" | "ready" | "failed">(
		drawable ? "loading" : "failed",
	);
	if (!drawable)
		return (
			<span className="media-slot" data-state="failed">
				<span>{alt}</span>
			</span>
		);
	return (
		<span className="media-slot" data-state={state}>
			{/* biome-ignore lint/performance/noImgElement: the origin is the backend's media route, which next/image would only re-fetch */}
			<img
				src={drawable}
				alt={alt}
				loading="lazy"
				onLoad={() => setState("ready")}
				onError={() => setState("failed")}
			/>
			{state === "failed" ? <span>{alt}</span> : null}
		</span>
	);
}

/**
 * A Markdown image, wherever Markdown is drawn: only a path on this origin
 * is ever fetched, never the URL written. The text is model-written, so a
 * URL in it could carry what the turn knew to a host that logs requests.
 */
export function MarkdownImage({
	src,
	alt,
}: ImgHTMLAttributes<HTMLImageElement>) {
	if (typeof src !== "string" || !src) return null;
	return <MediaImage src={src} alt={alt ?? ""} />;
}
