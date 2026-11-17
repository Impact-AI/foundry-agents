"use client";

import { useTranslations } from "next-intl";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { downscaleImage } from "@/src/chat/downscale";
import { Button, Dialog, StatusLine } from "../../components/controls";
import { focusOnMount } from "../../components/focus-on-mount";

export interface CapturedPhoto {
	value: string;
	mimeType: string;
}

type Trouble = "insecure" | "denied" | "unavailable" | null;

function troubleOf(err: unknown): Trouble {
	const name = err instanceof Error ? err.name : "";
	if (name === "NotAllowedError" || name === "SecurityError") return "denied";
	return "unavailable";
}

/**
 * The ref of the preview: whichever `<video>` is mounted is handed the open
 * stream. A shot replaces the preview with the picture, and a retake mounts
 * a new `<video>` long after the stream opened — without this it stays
 * black and has no frame to take.
 */
export function previewRef(
	video: RefObject<HTMLVideoElement | null>,
	stream: RefObject<MediaStream | null>,
): (el: HTMLVideoElement | null) => void {
	return (el) => {
		video.current = el;
		if (el && stream.current) el.srcObject = stream.current;
	};
}

/**
 * The device camera as a sheet: a live preview, one shot onto a canvas,
 * re-encoded like any attachment, and the stream stopped the moment the
 * sheet closes. The picture goes nowhere until the person sends it.
 */
export function CameraCapture({
	onCapture,
	onClose,
}: {
	onCapture: (photo: CapturedPhoto) => void;
	onClose: () => void;
}) {
	const t = useTranslations("camera");
	const video = useRef<HTMLVideoElement>(null);
	const stream = useRef<MediaStream | null>(null);
	const [trouble, setTrouble] = useState<Trouble>(null);
	const [shot, setShot] = useState<CapturedPhoto | null>(null);
	const [opening, setOpening] = useState(true);
	const [attachPreview] = useState(() => previewRef(video, stream));

	useEffect(() => {
		let cancelled = false;
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
			setTrouble("insecure");
			setOpening(false);
			return;
		}
		navigator.mediaDevices
			.getUserMedia({ video: { facingMode: "user" }, audio: false })
			.then((opened) => {
				if (cancelled) {
					for (const track of opened.getTracks()) track.stop();
					return;
				}
				stream.current = opened;
				if (video.current) video.current.srcObject = opened;
				setOpening(false);
			})
			.catch((err) => {
				if (cancelled) return;
				setTrouble(troubleOf(err));
				setOpening(false);
			});
		return () => {
			cancelled = true;
			for (const track of stream.current?.getTracks() ?? []) track.stop();
			stream.current = null;
		};
	}, []);

	const take = useCallback(async () => {
		const el = video.current;
		if (!el || el.videoWidth === 0) return;
		const canvas = document.createElement("canvas");
		canvas.width = el.videoWidth;
		canvas.height = el.videoHeight;
		canvas.getContext("2d")?.drawImage(el, 0, 0);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", 0.92),
		);
		if (!blob) return;
		try {
			setShot(await downscaleImage(blob));
		} catch {
			setTrouble("unavailable");
		}
	}, []);

	return (
		<Dialog
			label={t("label")}
			className="camera"
			onClose={onClose}
			actions={
				<>
					<Button onClick={onClose}>{t("close")}</Button>
					{shot ? (
						<>
							<Button onClick={() => setShot(null)}>{t("retake")}</Button>
							<Button
								variant="primary"
								onClick={() => onCapture(shot)}
								ref={focusOnMount}
							>
								{t("use")}
							</Button>
						</>
					) : (
						<Button
							variant="primary"
							disabled={opening || trouble !== null}
							onClick={() => void take()}
							ref={focusOnMount}
						>
							{t("take")}
						</Button>
					)}
				</>
			}
		>
			{trouble ? (
				<StatusLine tone="danger">{t(trouble)}</StatusLine>
			) : shot ? (
				// biome-ignore lint/performance/noImgElement: a data URL that never left the browser
				<img
					src={`data:${shot.mimeType};base64,${shot.value}`}
					alt={t("alt")}
				/>
			) : (
				<video
					ref={attachPreview}
					autoPlay
					playsInline
					muted
					aria-label={t("preview")}
				/>
			)}
			{opening ? <StatusLine tone="busy">{t("opening")}</StatusLine> : null}
		</Dialog>
	);
}
