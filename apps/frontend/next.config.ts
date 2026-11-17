import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { contentSecurityPolicy } from "./src/csp";

const nextConfig: NextConfig = {
	// Workspace packages ship as TypeScript source, so Next compiles them.
	transpilePackages: [
		"@platform/appearance",
		"@platform/config",
		"@platform/http",
		"@platform/i18n",
		"@platform/identity",
		"@platform/metering",
		"@platform/observability",
		"@platform/prompt",
	],
	output: "standalone",
	turbopack: {
		// CopilotKit's assistant message imports `streamdown` by name, and
		// streamdown carries KaTeX and a code highlighter no first screen
		// renders. The alias sends the bare specifier to a shim that fetches
		// the real module behind `import()` on the first assistant turn.
		resolveAlias: {
			streamdown: "./app/components/markdown/streamdown-lazy.tsx",
		},
	},
	// The Azure Monitor distro patches `node:http` at require time; a bundled
	// copy patches a module graph nothing resolves to.
	serverExternalPackages: ["@azure/monitor-opentelemetry"],
	outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
	async headers() {
		// The policy for what answers with no document. A page's own, with
		// its nonce, is the proxy's, and replaces this one on every page.
		const csp = contentSecurityPolicy({
			dev: process.env.NODE_ENV === "development",
		});
		return [
			{
				// Next drops a header a route sets when this config already set
				// it, and `/api/media/` and the logo answer with a policy of their own: a
				// picture must not inherit the page's script-src.
				source: "/((?!api/media/|api/appearance/logo$).*)",
				headers: [{ key: "Content-Security-Policy", value: csp }],
			},
			{
				source: "/:path*",
				headers: [
					{
						key: "Strict-Transport-Security",
						value: "max-age=31536000; includeSubDomains",
					},
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{ key: "X-Frame-Options", value: "DENY" },
					{
						key: "Permissions-Policy",
						value: "camera=(self), microphone=(self), geolocation=()",
					},
				],
			},
		];
	},
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
