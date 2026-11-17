# @platform/appearance

This package sets how the frontend looks on each deployment. It holds the `appearance` settings document, what that document puts on the page, and the color arithmetic that holds a palette to WCAG AA.

- `document` — the document's fields and two functions. `appearanceDefaults(locales)` is the shipped look, with an empty name and welcome line per language. `parseAppearance` merges a stored document over those defaults leaf by leaf with `mergeOverDefault`, and refuses each leaf that breaks its rule back to its default. Every leaf is a color, a bounded integer, a name from a closed list, a short line of text or a logo's key. After that, a scheme's palette under which any text would read below AA is refused whole, back to the shipped palette of that scheme. Fields that other writers of the document use and this frontend does not draw (`layout`, `preview`) are not among the defaults, so the merge passes over them.
- `palette` — six primitives per color scheme (`surface`, `ambient`, `primary`, `warning`, `success`, `aux`), the shipped ones, the `color-mix()` derivations the frontend's stylesheet applies once a primitive changes, and `contrastIssues`: every text/ground pair a palette would draw below AA.
- `tokens` — the font (a closed list of stacks a device already has), the base size, the type scale, the spacing density and the corner radius, each as the custom properties the token sheet declares.
- `brand` — the rules for the name and the welcome line, and the logo's key (`appearance/logo/<sha256>.<ext>`, a raster: PNG, JPEG, GIF or WebP, never SVG), the type its extension names and the version its hash gives.
- `css` — `appearanceCss` and `appearanceAttributes`: the one `<style>` and the `<html>` attributes the frontend's root layout injects. Each group is emitted only when it differs from the shipped choice, so an untouched deployment injects nothing.
- `settings` (server only, `./settings`) — `appearanceSettings(locales)`, the cached, fail-soft reader of the stored document, which logs what it refused. It rereads the store once per settings refresh interval (`CONFIG_TTL_MS`, 30 s).

Everything but `settings` is dependency-free apart from `@platform/config/merge`, so a browser bundle can carry it.

The document's fields are in [configuration](../../docs/configuration.md#appearance). Impact AI Admin Center writes the same document, field for field. `src/fixtures/` holds a document Admin Center wrote and the sheet its own app draws from it, and the parser and the sheet here are tested against both.

Its own suites test parsing, the AA rule, the injected sheet and the palette's arithmetic. The frontend's suites check that the shipped values here match `apps/frontend/app/globals.css`.
