import { defineProblemCodes } from "@platform/observability";

/**
 * Every refusal this package can answer, as a closed list a query can group
 * by. No subject ever appears on a line: a facet names the bound that
 * refused, never who it refused.
 */
export const meteringProblems = defineProblemCodes([
	"metering.call.rate_limited",
	"metering.seconds.refused",
] as const);
