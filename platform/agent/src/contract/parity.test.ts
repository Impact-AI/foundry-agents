import { REDIS_AVAILABLE } from "@platform/redis/testing";
import { foundryParityFactory } from "../foundry/testing/parity-factory";
import { describeAgentHostParity } from "./parity";

/**
 * The host on Foundry against the acceptance bar, on the stand-in service,
 * once per pair of stores the operator can choose: what is remembered in
 * the service's memory store (the default) or the deployment's own, and a
 * thread's messages in the deployment's own container (the default) or the
 * service's conversations. It needs a `REDIS_URL`: the bar includes the
 * duplicate turn refused across a fleet, which has nothing to coordinate
 * on without one.
 */
for (const memory of ["foundry", "own"] as const)
	for (const history of ["own", "foundry"] as const)
		describeAgentHostParity(foundryParityFactory({ memory, history }), {
			skip: !REDIS_AVAILABLE,
		});
