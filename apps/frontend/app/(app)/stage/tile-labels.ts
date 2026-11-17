"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import type { Section } from "@/src/stage/stage";

/** A section's word, the one its tile's head prints and the phone's strip repeats. */
export function useTileLabel(): (section: Section) => string {
	const t = useTranslations("stage");
	return useCallback((section: Section) => t(`sections.${section}`), [t]);
}
