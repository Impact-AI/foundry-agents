import { envString } from "@platform/config";
import { closeCosmos, setCosmosDatabase } from "../client";
import type { ContainerDefinition, CosmosDatabase } from "../container";
import { provisionEmulator } from "../emulator";
import { sdkDatabase } from "../sdk";
import { fakeCosmosDatabase } from "./fake";

/**
 * A database for one suite, installed as the process's: on the emulator
 * when asked for, made under a throwaway name and dropped after; otherwise
 * in memory. Every store suite runs on whichever this answers, so the same
 * assertions meet the stand-in here and the emulator in CI.
 */
export interface TestCosmos {
	database: CosmosDatabase;
	/** Where it runs, for a log line. */
	target: "emulator" | "memory";
	/** Drop it, and forget it as the process's. */
	drop(): Promise<void>;
}

/** The suites run on the emulator under `COSMOS_TESTS=1`, given its endpoint and key. */
export function emulatorRequested(): boolean {
	return (
		process.env.COSMOS_TESTS === "1" &&
		Boolean(envString("COSMOS_ENDPOINT") && envString("COSMOS_KEY"))
	);
}

async function onEmulator(
	definitions: readonly ContainerDefinition[],
): Promise<TestCosmos> {
	const provisioned = await provisionEmulator(
		definitions,
		`test-${crypto.randomUUID().slice(0, 8)}`,
	);
	if (!provisioned)
		throw new Error("the emulator is named by COSMOS_ENDPOINT and COSMOS_KEY");
	const { database, close } = provisioned;
	return {
		database: sdkDatabase(database),
		target: "emulator",
		async drop() {
			await database.delete();
			close();
		},
	};
}

/**
 * Open a database holding `definitions`' containers and make it the
 * process's. `emulator` picks the target; a suite leaves it to
 * {@link emulatorRequested}.
 */
export async function openTestCosmos(
	definitions: readonly ContainerDefinition[],
	emulator: boolean = emulatorRequested(),
): Promise<TestCosmos> {
	const opened: TestCosmos = emulator
		? await onEmulator(definitions)
		: {
				database: fakeCosmosDatabase(definitions),
				target: "memory",
				drop: async () => {},
			};
	setCosmosDatabase(opened.database);
	return {
		...opened,
		async drop() {
			closeCosmos();
			await opened.drop();
		},
	};
}
