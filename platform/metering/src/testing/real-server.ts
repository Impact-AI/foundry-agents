import { sweepNamespace, throwawayNamespace } from "@platform/redis/testing";
import { meteringKeys, setMeteringKeyPrefix } from "../keys";

export { REDIS_AVAILABLE } from "@platform/redis/testing";

/** Put this package's keys under a prefix nothing else writes, so a suite can sweep its own. */
export function useThrowawayPrefix(): void {
	setMeteringKeyPrefix(throwawayNamespace().prefix);
}

/** Delete every key this package wrote under its current prefix. */
export function sweepMeteringKeys(): Promise<void> {
	return sweepNamespace(meteringKeys());
}
