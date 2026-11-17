import { authMode } from "@platform/identity/claims";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { logoSrc, readAppearance } from "@/src/backend/appearance";
import { readCaller } from "@/src/session";
import { LoginForm } from "./LoginForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LoginPage() {
	// The same question every page asks, so a session they refuse is shown the door rather than bounced back to them.
	if (await readCaller()) redirect("/chat");
	const appearance = await readAppearance();
	return (
		<main className="door">
			{/* useSearchParams needs a Suspense boundary under the App Router. */}
			<Suspense fallback={null}>
				<LoginForm mode={authMode()} logoSrc={logoSrc(appearance)} />
			</Suspense>
		</main>
	);
}
