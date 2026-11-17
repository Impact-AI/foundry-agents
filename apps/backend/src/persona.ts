import { closeCosmos } from "@platform/cosmos";
import { prompt } from "./product";

/**
 * The operator's way to change the persona: `bun run persona <command>`,
 * as an identity holding Cosmos DB Built-in Data Contributor on the app's
 * database — the deploying principal does — with `COSMOS_ENDPOINT` set.
 *
 *   publish <label> <file>   the file's text becomes the active version
 *   activate <label>         an earlier version becomes the active one again
 *   show                     which version is active
 *
 * Every replica serves the change within the memo's 30 seconds.
 */
export async function persona(args: readonly string[]): Promise<string> {
	const [command, label, file] = args;
	if (command === "publish" && label && file) {
		await prompt.publish({ label, text: await Bun.file(file).text() });
	} else if (command === "activate" && label && !file) {
		if (!(await prompt.activate(label)))
			throw new Error(`the persona has no version "${label}"`);
	} else if (command !== "show" || label) {
		throw new Error(
			"usage: persona publish <label> <file> | persona activate <label> | persona show",
		);
	}
	const active = await prompt.version();
	return active
		? `the persona's active version is "${active.label}", ${active.chars} characters`
		: "the persona has no version: the code's default is served";
}

if (import.meta.main) {
	try {
		console.log(await persona(process.argv.slice(2)));
	} catch (err) {
		console.error((err as Error).message);
		process.exitCode = 1;
	} finally {
		closeCosmos();
	}
}
