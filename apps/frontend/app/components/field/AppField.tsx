import { Drift } from "./Drift";
import { StillField } from "./StillField";
import "./field.css";

/**
 * The one field, under every screen: the door, the workspace and the rooms
 * off it are layers over it, so signing in reads as the same place letting
 * you in. The still frame is in the first HTML; the live canvas mounts with
 * hydration and the two crossfade on one clock.
 */
export function AppField() {
	return (
		<div className="field" aria-hidden="true">
			<StillField />
			<Drift />
		</div>
	);
}
