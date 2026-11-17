import { appearanceAttributes, appearanceCss } from "@platform/appearance";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { readAppearance } from "@/src/backend/appearance";
import { getTextScale } from "@/src/text-scale-store";
import { AppField } from "./components/field/AppField";
import { Vitals } from "./components/Vitals";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations("metadata");
	return {
		title: t("title"),
		description: t("description"),
		formatDetection: { telephone: false, email: false, address: false },
	};
}

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
};

export default async function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const [locale, textScale, appearance] = await Promise.all([
		getLocale(),
		getTextScale(),
		readAppearance(),
	]);
	// The deployment's look, in the first byte of the page so nothing flashes
	// the shipped one first; nothing at all for the shipped look. The sheet is
	// built from a parsed document only — colours, integers and closed lists —
	// and refused whole if it could close its element (@platform/appearance).
	const css = appearanceCss(appearance);
	return (
		<html
			lang={locale}
			data-text-scale={textScale}
			{...appearanceAttributes(appearance)}
		>
			<body>
				{css ? (
					<style
						id="appearance-sheet"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: a sheet generated from validated values, never stored text
						dangerouslySetInnerHTML={{ __html: css }}
					/>
				) : null}
				{/* One field under every screen: the door, the workspace, the rooms off it. */}
				<AppField />
				<NextIntlClientProvider>{children}</NextIntlClientProvider>
				<Vitals />
			</body>
		</html>
	);
}
