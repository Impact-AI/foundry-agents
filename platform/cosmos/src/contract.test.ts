import { cosmosContract } from "./testing";

/**
 * The shared suite, in memory always and on the emulator under
 * `COSMOS_TESTS=1` with `COSMOS_ENDPOINT` and `COSMOS_KEY`.
 */
cosmosContract(false);
cosmosContract(true);
