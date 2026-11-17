import { cookies } from "next/headers";
import {
	parseTextScale,
	TEXT_SCALE_COOKIE,
	type TextScale,
} from "./text-scale";

const ONE_YEAR = 60 * 60 * 24 * 365;

export async function getTextScale(): Promise<TextScale> {
	const store = await cookies();
	return parseTextScale(store.get(TEXT_SCALE_COOKIE)?.value);
}

export async function setTextScale(scale: TextScale): Promise<void> {
	const store = await cookies();
	store.set(TEXT_SCALE_COOKIE, String(scale), {
		path: "/",
		maxAge: ONE_YEAR,
		sameSite: "lax",
	});
}
