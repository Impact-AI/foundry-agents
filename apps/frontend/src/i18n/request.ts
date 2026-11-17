import { getRequestConfig } from "next-intl/server";
import { readAppearance } from "../backend/appearance";
import { withBrand } from "./brand";
import { getUserLocale } from "./locale";

export default getRequestConfig(async () => {
	const [locale, appearance] = await Promise.all([
		getUserLocale(),
		readAppearance(),
	]);
	return {
		locale,
		messages: withBrand(
			(await import(`../../messages/${locale}.json`)).default,
			appearance.brand,
			locale,
		),
	};
});
