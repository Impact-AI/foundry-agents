"use server";

import { isTextScale } from "./text-scale";
import { setTextScale } from "./text-scale-store";

export async function chooseTextScale(scale: unknown): Promise<void> {
	if (isTextScale(scale)) await setTextScale(scale);
}
