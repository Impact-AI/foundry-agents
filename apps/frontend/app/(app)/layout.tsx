import { logoSrc, readAppearance } from "@/src/backend/appearance";
import { readPerson } from "@/src/backend/person";
import { requireCaller } from "@/src/session";
import { StageControlsProvider } from "../components/stage-controls";
import { TopBar } from "../components/TopBar";
import { VisualViewport } from "../components/use-visual-viewport";
import { WarmSweep } from "../components/WarmSweep";
import { GuideMode } from "./guide/GuideOverlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in shell: the door for anyone else, the bar for everyone
 * inside, and the contexts the bar and the workspace share — the stage's
 * controls, the guide. The field is the root layout's, so the door stands
 * on it too.
 */
export default async function AppLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const caller = await requireCaller();
	const appearance = await readAppearance();
	let name: string | null = null;
	try {
		name = (await readPerson(caller)).name;
	} catch (err) {
		// The bar is drawn without a name rather than the page refused: the
		// page itself says what it could not reach.
		console.error("[layout] the person is unavailable:", err);
	}
	return (
		<StageControlsProvider>
			<VisualViewport />
			<WarmSweep />
			<GuideMode>
				<div className="shell">
					<TopBar name={name} logoSrc={logoSrc(appearance)} />
					<main className="main">{children}</main>
				</div>
			</GuideMode>
		</StageControlsProvider>
	);
}
