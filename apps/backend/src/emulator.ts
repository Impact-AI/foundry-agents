import { provisionEmulator } from "@platform/cosmos";
import { cosmosContainers } from "./containers";

/**
 * `bun run emulator`: the Cosmos DB emulator's database and the containers
 * this app reads, made where absent, as the template makes a deployment's.
 * For a laptop only: it runs with the emulator's `COSMOS_KEY` beside
 * `COSMOS_ENDPOINT`, and refuses anything else.
 */
const emulator = await provisionEmulator(cosmosContainers);
if (!emulator) {
	console.error(
		"[emulator] set COSMOS_ENDPOINT and the emulator's COSMOS_KEY: a deployment's containers are the template's",
	);
	process.exit(1);
}
emulator.close();
console.log("[emulator] the database and containers ensured");
