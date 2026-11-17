export const TEXT_SCALE_COOKIE = "text-scale";

export const TEXT_SCALES = [100, 115, 130, 150] as const;

export type TextScale = (typeof TEXT_SCALES)[number];

export const TEXT_SCALE_NAMES: Record<
	TextScale,
	"standard" | "large" | "larger" | "largest"
> = {
	100: "standard",
	115: "large",
	130: "larger",
	150: "largest",
};

const DEFAULT_TEXT_SCALE: TextScale = 100;

export function isTextScale(value: unknown): value is TextScale {
	return (TEXT_SCALES as readonly unknown[]).includes(value);
}

export function parseTextScale(value: string | null | undefined): TextScale {
	if (value == null || value.trim() === "") return DEFAULT_TEXT_SCALE;
	const n = Number(value);
	return isTextScale(n) ? n : DEFAULT_TEXT_SCALE;
}
