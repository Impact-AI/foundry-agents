#!/usr/bin/env bun
/**
 * What a release workflow deployed, written for the impact.ai release action
 * to confirm. After the deploy, from the repository root:
 *
 *   bun scripts/application-receipt.ts --out out/application-receipt.json
 *     --image-tag <tag> --revision-suffix <suffix> [--tests <directory>]
 *
 * It reads the azd environment (`azd env get-values`) for the resource group
 * and the two apps' names, and asks Azure (`az containerapp show`) which
 * revision each app runs and on which image. It waits, up to ten minutes,
 * until each app's latest revision is the one the release named
 * (`<app>--<suffix>`) and is ready, so the receipt names the revision that
 * serves; that revision must run the image the run built or pinned, tagged
 * `<tag>`. `--tests` names the folder of the run's own test reports, one JUnit
 * file per suite (`backend.xml`, `frontend.xml`, as `bun test
 * --reporter=junit` writes them); without it the receipt holds no tests, as
 * in Production, which reruns none.
 *
 * The receipt holds its format, the services with image and revision, and
 * the test counts: nothing else, and never a value the run was handed. The
 * action adds the release's identity, the run and the commit when it
 * publishes the confirmation. It exits 1 with a line on stderr when anything
 * it needs is missing, and writes nothing then.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs as parseCommandLine } from "node:util";
import { $ } from "bun";
import { parseEnvValues } from "./verify-deployment";

export const SERVICES = ["backend", "frontend"] as const;
export type Service = (typeof SERVICES)[number];

/** One suite of the application's own tests, as the release action publishes it. */
export type Suite = {
	suite: string;
	command: string;
	passed: number;
	total: number;
};

export const RECEIPT_FORMAT = "impact-application-receipt/v1";

export type Receipt = {
	format: typeof RECEIPT_FORMAT;
	services: { name: Service; image: string; revision: string }[];
	/** Development's own tests; left out where none ran. */
	tests?: Suite[];
};

/** What `az containerapp show` answers for one app, the three fields read. */
export type AppState = {
	image: string;
	latest: string;
	ready: string | null;
};

export class Refused extends Error {}

/**
 * The counts of one JUnit report, as Bun writes its root element: a skipped
 * test is neither passed nor counted, so a suite whose every test that ran
 * passed reads as all passed.
 */
export function suiteOf(suite: string, command: string, xml: string): Suite {
	const root = /<testsuites\b([^>]*)>/.exec(xml)?.[1];
	if (root === undefined)
		throw new Refused(`the ${suite} report holds no <testsuites> element`);
	const count = (name: string) => {
		const found = new RegExp(`\\b${name}="(\\d+)"`).exec(root)?.[1];
		if (found === undefined)
			throw new Refused(`the ${suite} report's <testsuites> has no ${name}`);
		return Number(found);
	};
	const tests = count("tests");
	const ran = tests - count("skipped");
	return {
		suite,
		command,
		passed: Math.max(0, ran - count("failures")),
		total: ran,
	};
}

/** The suites the run's reports hold, in the order of {@link SERVICES}. */
export function suitesIn(directory: string): Suite[] {
	return SERVICES.map((service) => {
		const path = join(directory, `${service}.xml`);
		if (!existsSync(path))
			throw new Refused(
				`no ${service} test report at ${path}: the run's own tests did not write one`,
			);
		return suiteOf(
			service,
			`bun test apps/${service}`,
			readFileSync(path, "utf8"),
		);
	});
}

/**
 * The revision that serves, or why there is none yet: until the app's latest
 * revision is the one the release named and is ready, the receipt waits. That
 * revision must run the image the run deployed.
 */
export function revisionOf(
	service: Service,
	state: AppState,
	expected: { imageTag: string; revisionSuffix: string },
): { image: string; revision: string } | string {
	if (!state.latest.endsWith(`--${expected.revisionSuffix}`))
		return `the ${service} app's latest revision is ${state.latest}, not the release's --${expected.revisionSuffix}`;
	if (state.ready !== state.latest)
		return `the ${service} app's revision ${state.latest} is not ready (the ready one is ${state.ready ?? "none"})`;
	if (!state.image.endsWith(`:${expected.imageTag}`))
		throw new Refused(
			`the ${service} app runs ${state.image}, not the image tagged ${expected.imageTag} this run deployed`,
		);
	return { image: state.image, revision: state.latest };
}

export type Options = {
	out: string;
	imageTag: string;
	revisionSuffix: string;
	tests?: string;
};

export function parseArgs(argv: string[]): Options {
	let values: {
		out?: string;
		"image-tag"?: string;
		"revision-suffix"?: string;
		tests?: string;
	};
	try {
		({ values } = parseCommandLine({
			args: argv,
			options: {
				out: { type: "string" },
				"image-tag": { type: "string" },
				"revision-suffix": { type: "string" },
				tests: { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (err) {
		throw new Refused((err as Error).message);
	}
	for (const [name, purpose] of [
		["out", "where the receipt goes"],
		["image-tag", "the tag the run deployed"],
		["revision-suffix", "the revision the release named"],
	] as const)
		if (!values[name]) throw new Refused(`--${name} names ${purpose}`);
	return {
		out: values.out as string,
		imageTag: values["image-tag"] as string,
		revisionSuffix: values["revision-suffix"] as string,
		...(values.tests ? { tests: values.tests } : {}),
	};
}

/** What the receipt reads from Azure and the azd environment; a test hands in its own. */
export type Sources = {
	env: () => Promise<Record<string, string>>;
	app: (subscription: string, group: string, name: string) => Promise<AppState>;
	sleep: (ms: number) => Promise<void>;
};

const WAIT_MS = 10 * 60_000;
const POLL_MS = 10_000;

export async function receipt(
	options: Options,
	sources: Sources,
): Promise<Receipt> {
	const env = await sources.env();
	const need = (name: string) => {
		const value = env[name];
		if (!value)
			throw new Refused(
				`${name} is not in the azd environment; run this after the provision`,
			);
		return value;
	};
	const subscription = need("AZURE_SUBSCRIPTION_ID");
	const group = need("AZURE_RESOURCE_GROUP");
	const names: Record<Service, string> = {
		backend: need("BACKEND_APP_NAME"),
		frontend: need("FRONTEND_APP_NAME"),
	};
	// Read before the wait, so a missing report fails at once.
	const tests = options.tests ? suitesIn(options.tests) : undefined;
	const services: Receipt["services"] = [];
	for (const name of SERVICES) {
		let waited = 0;
		for (;;) {
			const found = revisionOf(
				name,
				await sources.app(subscription, group, names[name]),
				options,
			);
			if (typeof found !== "string") {
				services.push({ name, ...found });
				break;
			}
			if (waited >= WAIT_MS)
				throw new Refused(`${found} after ${WAIT_MS / 60_000} minutes`);
			await sources.sleep(POLL_MS);
			waited += POLL_MS;
		}
	}
	return { format: RECEIPT_FORMAT, services, ...(tests ? { tests } : {}) };
}

const live: Sources = {
	env: async () =>
		parseEnvValues((await $`azd env get-values`.quiet()).stdout.toString()),
	app: async (subscription, group, name) =>
		JSON.parse(
			(
				await $`az containerapp show --subscription ${subscription} -g ${group} -n ${name} --query ${"{image: properties.template.containers[0].image, latest: properties.latestRevisionName, ready: properties.latestReadyRevisionName}"} -o json --only-show-errors`.quiet()
			).stdout.toString(),
		) as AppState,
	sleep: (ms) => Bun.sleep(ms),
};

async function main(argv: string[]): Promise<number> {
	try {
		const options = parseArgs(argv);
		const written = await receipt(options, live);
		mkdirSync(dirname(options.out), { recursive: true });
		writeFileSync(options.out, `${JSON.stringify(written, null, 2)}\n`);
		for (const s of written.services)
			console.log(`application-receipt: ${s.name} runs ${s.revision}`);
		return 0;
	} catch (err) {
		const message =
			err instanceof Refused
				? err.message
				: err instanceof $.ShellError
					? `${err.message}: ${err.stderr.toString().trim()}`
					: String(err);
		console.error(`application-receipt: ${message}`);
		return 1;
	}
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
