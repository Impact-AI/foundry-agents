/**
 * A picture re-encoded for the wire: drawn onto a canvas at a bounded edge
 * and re-encoded as JPEG, stepping down a ladder of sizes and qualities until
 * the base64 payload fits the budget. A model does not need more pixels than
 * this, and a chat run should not carry them.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES = 96 * 1024;

const LADDER: readonly { edge: number; quality: number }[] = [
	{ edge: 1280, quality: 0.8 },
	{ edge: 1024, quality: 0.75 },
	{ edge: 896, quality: 0.7 },
	{ edge: 768, quality: 0.62 },
	{ edge: 768, quality: 0.45 },
];

const TOO_DENSE = "image-too-dense";

function fitWithin(
	width: number,
	height: number,
	edge: number,
): { width: number; height: number } {
	const longest = Math.max(width, height);
	if (longest <= edge) return { width, height };
	const scale = edge / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

function payloadOf(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

export async function downscaleImage(
	file: Blob,
	budget: number = MAX_ENCODED_IMAGE_BYTES,
): Promise<{ type: "data"; value: string; mimeType: string }> {
	const bitmap = await createImageBitmap(file);
	try {
		for (const rung of LADDER) {
			const { width, height } = fitWithin(
				bitmap.width,
				bitmap.height,
				rung.edge,
			);
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error(TOO_DENSE);
			ctx.drawImage(bitmap, 0, 0, width, height);
			const value = payloadOf(canvas.toDataURL("image/jpeg", rung.quality));
			if (value.length <= budget)
				return { type: "data", value, mimeType: "image/jpeg" };
		}
		throw new Error(TOO_DENSE);
	} finally {
		bitmap.close();
	}
}
