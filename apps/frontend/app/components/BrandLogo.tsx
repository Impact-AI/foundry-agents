/**
 * The deployment's logo, beside the name that says the same thing — so it is
 * decorative to a screen reader. Drawn from this app's own relay of the one
 * picture the appearance document names (`logoSrc`); nothing at all when the
 * deployment has none.
 */
export function BrandLogo({
	src,
	className = "brand-logo",
}: {
	/** Where the logo is drawn from; empty for none. */
	src: string;
	className?: string;
}) {
	if (!src) return null;
	return (
		// biome-ignore lint/performance/noImgElement: a small picture this app relays itself; there is nothing for an optimiser to do
		<img className={className} src={src} alt="" />
	);
}
