/**
 * The workflows under .github. Every action is pinned to a commit, because a
 * tag can be moved to code nobody reviewed. The two release workflows hand
 * each azd step exactly the variables and secrets `azd pipeline config` sets:
 * azd's own and those azure.yaml's `pipeline` block names. A name in the block
 * a workflow never passes reaches the repository and then nothing; a name a
 * workflow passes that the block does not list is never set, so reads empty.
 * Beyond those, a step is handed the release alone, and never anything of
 * impact.ai's.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { LOCKFILES } from "./scripts/dependency-audit";

const AZD = import.meta.dir;
const WORKFLOWS = join(AZD, ".github", "workflows");

type Step = {
	uses?: string;
	run?: string;
	shell?: string;
	env?: Record<string, string>;
	with?: Record<string, string>;
};
type Job = { uses?: string; env?: Record<string, string>; steps?: Step[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
type Project = {
	services: Record<string, { project: string; docker: { path: string } }>;
	pipeline: { variables: string[]; secrets: string[] };
};

const read = (...path: string[]) => readFileSync(join(AZD, ...path), "utf8");
const project = YAML.parse(read("azure.yaml")) as Project;
const workflows = readdirSync(WORKFLOWS)
	.filter((file) => /\.ya?ml$/.test(file))
	.map((file) => {
		const text = read(".github", "workflows", file);
		return { file, text, parsed: YAML.parse(text) as Workflow };
	});

/** What `azd pipeline config` sets on a GitHub repository whatever the template. */
const AZD_VARIABLES = [
	"AZURE_CLIENT_ID",
	"AZURE_ENV_NAME",
	"AZURE_LOCATION",
	"AZURE_SUBSCRIPTION_ID",
	"AZURE_TENANT_ID",
];

test("a step that pipes its command runs under an explicit bash, so the command's failure is the step's", () => {
	const unguarded = workflows.flatMap(({ file, parsed }) =>
		Object.values(parsed.jobs).flatMap((job) =>
			(job.steps ?? []).flatMap((step) =>
				step.run && /\s\|\s/.test(step.run) && step.shell !== "bash"
					? [`${file}: ${step.run.split("\n")[0]}`]
					: [],
			),
		),
	);
	expect(unguarded).toEqual([]);
});

test("every action is pinned to a full commit, with the release it is", () => {
	expect(workflows.length).toBeGreaterThan(0);
	const unpinned = workflows.flatMap(({ file, text, parsed }) =>
		Object.values(parsed.jobs)
			.flatMap((job) => [job.uses, ...(job.steps ?? []).map((s) => s.uses)])
			.filter((uses): uses is string => uses !== undefined)
			.filter(
				(uses) =>
					!/^[^@\s]+@[0-9a-f]{40}$/.test(uses) || !text.includes(`${uses} # v`),
			)
			.map((uses) => `${file}: ${uses}`),
	);
	expect(unpinned).toEqual([]);
});

const workflow = (file: string) => {
	const found = workflows.find((w) => w.file === file);
	if (!found) throw new Error(`${file} is missing`);
	return found;
};

/**
 * The two release workflows, one per GitHub environment: what impact.ai's
 * OIDC allowlist names (the file and the environment), the branch each runs
 * on, and the release action they call.
 */
const RELEASES = [
	{
		file: "azure-development.yml",
		environment: "Development",
		action: "development",
		on: { push: { branches: ["development"] } },
	},
	{
		file: "azure-production.yml",
		environment: "Production",
		action: "production",
		on: {
			push: { branches: ["production"], paths: ["releases/production.json"] },
		},
	},
] as const;

const RELEASE_ACTION = "Impact-AI/impact-ai-release-action";
/** The action's version both workflows run; its commit is the release's to set (azure-development.yml). */
const RELEASE_ACTION_VERSION = "v1.1.0";

type ReleaseJob = Job & {
	environment?: string;
	permissions?: Record<string, string>;
	steps: (Step & { id?: string; name?: string; if?: string })[];
};

const releaseJob = (file: string): ReleaseJob => {
	const jobs = Object.values(workflow(file).parsed.jobs);
	expect(jobs).toHaveLength(1);
	return jobs[0] as ReleaseJob;
};

test("only the two release workflows deploy: the manual one they replace is gone", () => {
	const deploying = workflows
		.filter(({ text }) => /\bazd (provision|deploy)\b/.test(text))
		.map(({ file }) => file)
		.sort();
	expect(deploying).toEqual(RELEASES.map((r) => r.file).sort());
	expect(existsSync(join(WORKFLOWS, "azure-dev.yml"))).toBe(false);
});

for (const release of RELEASES) {
	test(`${release.file} runs on its branch, in the ${release.environment} environment, one run at a time, with only what the release action needs`, () => {
		const { parsed } = workflow(release.file);
		expect(parsed.on).toEqual(release.on);
		const job = releaseJob(release.file);
		expect(job.environment).toBe(release.environment);
		expect(job.permissions).toEqual({
			contents: "read",
			actions: "read",
			checks: "write",
			"id-token": "write",
		});
		expect((parsed as { permissions?: unknown }).permissions).toEqual({
			contents: "read",
		});
		expect((parsed as { concurrency?: unknown }).concurrency).toEqual({
			group: release.file.replace(/\.yml$/, ""),
			"cancel-in-progress": false,
		});
	});

	test(`${release.file} prepares through the release action before Azure and confirms through it last, always`, () => {
		const steps = releaseJob(release.file).steps;
		const calls = steps.filter((s) => s.uses?.startsWith(`${RELEASE_ACTION}@`));
		expect(calls.map((s) => s.with)).toEqual([
			{ kind: "application", environment: release.action, mode: "prepare" },
			{ kind: "application", environment: release.action, mode: "finish" },
		]);
		const prepare = steps.indexOf(calls[0] as (typeof steps)[number]);
		const login = steps.findIndex((s) => s.uses?.startsWith("azure/login@"));
		expect(calls[0]?.id).toBe("prepare");
		expect(prepare).toBeLessThan(login);
		expect(steps.at(-1)).toBe(calls[1]);
		expect(calls[1]?.if).toBe("always()");
		expect(steps[login]?.with).toEqual({
			"client-id": `\${{ steps.prepare.outputs.client-id }}`,
			"tenant-id": `\${{ steps.prepare.outputs.tenant-id }}`,
			"subscription-id": `\${{ steps.prepare.outputs.subscription-id }}`,
		});
		// The receipt is written before the confirmation reads it.
		const receipt = steps.findIndex((s) =>
			s.run?.startsWith(
				"bun scripts/application-receipt.ts --out out/application-receipt.json",
			),
		);
		expect(receipt).toBeGreaterThan(login);
		expect(receipt).toBe(steps.length - 2);
	});
}

test("both workflows run one commit of the release action, at the version the release names", () => {
	const pins = new Set(
		workflows.flatMap(({ text }) =>
			[
				...text.matchAll(
					new RegExp(
						`uses: (${RELEASE_ACTION}@[0-9a-f]{40}) # (v[\\d.]+)`,
						"g",
					),
				),
			].map((m) => `${m[1]} # ${m[2]}`),
		),
	);
	expect(pins.size).toBe(1);
	expect([...pins][0]).toEndWith(` # ${RELEASE_ACTION_VERSION}`);
});

test("Development's own tests run after its deploy, and its receipt counts them", () => {
	const steps = releaseJob("azure-development.yml").steps;
	const deploy = steps.findIndex((s) => s.run === "azd deploy --no-prompt");
	const tests = steps.findIndex((s) => s.run?.includes("bun test"));
	expect(deploy).toBeGreaterThan(-1);
	expect(tests).toBeGreaterThan(deploy);
	expect(steps[tests]?.run).toContain("for app in backend frontend");
	expect(steps[tests]?.run).toContain(
		'--reporter=junit --reporter-outfile="out/tests/$app.xml"',
	);
	expect(steps.at(-2)?.run).toContain("--tests out/tests");
	// Production reruns none.
	expect(
		releaseJob("azure-production.yml").steps.some((s) =>
			s.run?.includes("bun test"),
		),
	).toBe(false);
});

/**
 * Beyond what `azd pipeline config` sets, an azd step is handed only what the
 * release names: the image tag from the action's prepare step, and, in
 * Production, the copied pinned images and the revision's name. The release
 * itself (`IMPACT_RELEASE_ID`, `IMPACT_RELEASE_VERSION`,
 * `IMPACT_RELEASE_ENVIRONMENT`) the prepare step puts in the job's
 * environment, where every later step reads it.
 */
const RELEASE_VALUES: Record<string, RegExp> = {
	IMPACT_IMAGE_TAG: /^\$\{\{ steps\.prepare\.outputs\.image-tag \}\}$/,
	SERVICE_BACKEND_IMAGE_NAME: /^\$\{\{ steps\.images\.outputs\.backend \}\}$/,
	SERVICE_FRONTEND_IMAGE_NAME: /^\$\{\{ steps\.images\.outputs\.frontend \}\}$/,
	IMPACT_REVISION_SUFFIX: /^\$\{\{ steps\.revision\.outputs\.suffix \}\}$/,
};
const FROM_THE_ACTION = [
	"IMPACT_RELEASE_ID",
	"IMPACT_RELEASE_VERSION",
	"IMPACT_RELEASE_ENVIRONMENT",
];

/** Every azd provision and deploy of both release workflows, with the environment each step sees. */
const azdSteps = () =>
	RELEASES.flatMap(({ file, action }) => {
		const job = releaseJob(file);
		return job.steps
			.filter((step) => /^azd (provision|deploy)\b/.test(step.run ?? ""))
			.map((step) => ({
				file,
				action,
				run: step.run as string,
				env: { ...job.env, ...step.env } as Record<string, string>,
			}));
	});

test("Development provisions then deploys; Production provisions, then provisions with the pinned images", () => {
	const runs = (file: string) =>
		azdSteps()
			.filter((s) => s.file === file)
			.map((s) => s.run.split(" ")[1]);
	expect(runs("azure-development.yml")).toEqual(["provision", "deploy"]);
	expect(runs("azure-production.yml")).toEqual(["provision", "provision"]);
});

test("each azd step gets exactly what pipeline config sets, and beyond it only the release", () => {
	const passed = (env: Record<string, string>, kind: "vars" | "secrets") =>
		Object.entries(env)
			.filter(([name, value]) => value === `\${{ ${kind}.${name} }}`)
			.map(([name]) => name)
			.sort();
	for (const { file, run, env } of azdSteps()) {
		const at = `${file}: ${run}`;
		expect(passed(env, "vars"), at).toEqual(
			[...AZD_VARIABLES, ...project.pipeline.variables].sort(),
		);
		expect(passed(env, "secrets"), at).toEqual(
			[...project.pipeline.secrets].sort(),
		);
		const rest = Object.entries(env).filter(
			([name, value]) =>
				value !== `\${{ vars.${name} }}` && value !== `\${{ secrets.${name} }}`,
		);
		for (const [name, value] of rest) {
			expect(Object.keys(RELEASE_VALUES), `${at}: ${name}`).toContain(name);
			expect(value, `${at}: ${name}`).toMatch(RELEASE_VALUES[name] as RegExp);
		}
		for (const name of FROM_THE_ACTION)
			expect(env, `${at}: ${name} is the action's`).not.toHaveProperty(name);
	}
	// Development's deploy alone tags images; Production's second provision
	// alone names images, and the revision with them.
	const naming = (name: string) =>
		azdSteps()
			.filter((s) => name in s.env)
			.map((s) => `${s.file}: ${s.run}`);
	expect(naming("IMPACT_IMAGE_TAG")).toEqual([
		"azure-development.yml: azd deploy --no-prompt",
	]);
	for (const name of [
		"SERVICE_BACKEND_IMAGE_NAME",
		"SERVICE_FRONTEND_IMAGE_NAME",
		"IMPACT_REVISION_SUFFIX",
	])
		expect(naming(name), name).toEqual([
			"azure-production.yml: azd provision --no-prompt",
		]);
	expect(
		azdSteps().filter((s) => s.file === "azure-production.yml")[1]?.env,
	).toHaveProperty("IMPACT_REVISION_SUFFIX");
});

test("each release's revision is named from the action's suffix, after the deploy and before the receipt reads it", () => {
	for (const { file } of RELEASES) {
		const steps = releaseJob(file).steps;
		const naming = steps.findIndex((s) => s.id === "revision");
		const step = steps[naming];
		expect(step?.env?.REVISION_SUFFIX, file).toBe(
			`\${{ steps.prepare.outputs.revision-suffix }}`,
		);
		// The version's suffix first, a run's own mark only after it.
		expect(step?.run, file).toMatch(/^\s*suffix="\$REVISION_SUFFIX/);
		const receipt = steps.at(-2);
		expect(receipt?.env?.REVISION_SUFFIX, file).toBe(
			`\${{ steps.revision.outputs.suffix }}`,
		);
		expect(receipt?.run, file).toContain(
			'--revision-suffix "$REVISION_SUFFIX"',
		);
		expect(naming, file).toBeLessThan(steps.length - 2);
	}
	// Development renames what azd deploy rolled; Production names it in the
	// provision that takes the images.
	const development = releaseJob("azure-development.yml").steps;
	expect(development.findIndex((s) => s.id === "revision")).toBeGreaterThan(
		development.findIndex((s) => s.id === "deploy"),
	);
	expect(development.find((s) => s.id === "revision")?.run).toContain(
		'revisionSuffix\\": \\"$suffix',
	);
	const production = releaseJob("azure-production.yml").steps;
	expect(production.findIndex((s) => s.id === "revision")).toBeLessThan(
		production.findIndex((s) => s.id === "deploy"),
	);
});

test("each service's deploy carries the release and the tag the Development workflow names", () => {
	const yaml = YAML.parse(read("azure.yaml")) as {
		services: Record<
			string,
			{ env?: Record<string, string>; docker: { tag?: string } }
		>;
	};
	for (const [name, service] of Object.entries(yaml.services)) {
		expect(service.docker.tag, name).toBe(`\${IMPACT_IMAGE_TAG}`);
		expect(service.env, name).toEqual({
			IMPACT_RELEASE_ID: `\${IMPACT_RELEASE_ID}`,
			IMPACT_RELEASE_VERSION: `\${IMPACT_RELEASE_VERSION}`,
			IMPACT_RELEASE_ENVIRONMENT: `\${IMPACT_RELEASE_ENVIRONMENT}`,
		});
	}
});

/**
 * What no run carries: impact.ai's endpoint and the product's ingest key. A
 * person sets them once per environment, from their own machine; each app
 * keeps the endpoint it runs, and the vault keeps the key. Neither workflow
 * needs a key, a variable or a secret from impact.ai.
 */
const KEPT_OUT_OF_RUNS = ["IMPACT_ENDPOINT", "IMPACT_API_KEY"];

test("no workflow carries impact.ai's endpoint, its key, or any value named for impact.ai", () => {
	for (const { file, text } of workflows) {
		for (const name of KEPT_OUT_OF_RUNS) expect(text, file).not.toContain(name);
		expect(text, file).not.toMatch(/\b(vars|secrets)\.IMPACT_/);
	}
});

/** The example pin in docs/deployment.md, under "The Production pin". */
function documentedPin(): Record<string, unknown> {
	const page = read("docs", "deployment.md");
	const at = page.indexOf("### The Production pin");
	expect(at).toBeGreaterThan(-1);
	const block = /```json\n([\s\S]*?)\n```/.exec(page.slice(at))?.[1];
	if (!block) throw new Error("no JSON example under The Production pin");
	return JSON.parse(block) as Record<string, unknown>;
}

test("the documented pin is one the release action takes: the contract's keys, and images tagged with its version", () => {
	const pin = documentedPin();
	expect(Object.keys(pin).sort()).toEqual([
		"action",
		"format",
		"images",
		"releaseId",
		"sourceRunId",
		"version",
	]);
	expect(pin.format).toBe("impact-application-production/v1");
	expect(["promote", "rollback"]).toContain(pin.action as string);
	expect(Number.isInteger(pin.version) && (pin.version as number) >= 1).toBe(
		true,
	);
	expect(pin.releaseId).toMatch(/^rel_[0-9a-f]{24}$/);
	expect(Number.isSafeInteger(pin.sourceRunId)).toBe(true);
	const images = pin.images as Record<string, string>;
	expect(Object.keys(images).sort()).toEqual(["backend", "frontend"]);
	for (const image of Object.values(images))
		expect(image).toMatch(new RegExp(`:v${pin.version}-[0-9a-f]{7}$`));
	// Production takes the images from the action, which verified the pin.
	const production = releaseJob("azure-production.yml").steps;
	expect(production.find((s) => s.id === "images")?.env).toEqual({
		BACKEND_IMAGE: `\${{ steps.prepare.outputs.backend-image }}`,
		FRONTEND_IMAGE: `\${{ steps.prepare.outputs.frontend-image }}`,
	});
});

test("every value the parameter file reads reaches a pipeline run", () => {
	const referenced = new Set(
		[...read("infra", "main.parameters.json").matchAll(/\$\{([A-Z_]+)/g)].map(
			(m) => m[1] as string,
		),
	);
	const hooks = readdirSync(join(AZD, "hooks"))
		.filter((file) => file.endsWith(".sh"))
		.map((file) => read("hooks", file))
		.join("\n");
	const services = Object.keys(project.services).map((s) => s.toUpperCase());
	// azd sets the principal from the signed-in identity and, at each
	// provision, whether each service's container app exists; a release
	// workflow hands its azd steps the release.
	const reaching = new Set([
		...AZD_VARIABLES,
		"AZURE_PRINCIPAL_ID",
		...services.map((service) => `SERVICE_${service}_RESOURCE_EXISTS`),
		...azdSteps().flatMap((s) => Object.keys(s.env)),
		...FROM_THE_ACTION,
		// A hook sets a value by azd's own command, or through the function it wraps it in.
		...[...hooks.matchAll(/(?:azd env set|set_value) ([A-Z_]+)/g)].map(
			(m) => m[1],
		),
		...project.pipeline.variables,
		...project.pipeline.secrets,
	]);
	// A service's image name is the one value a run does not carry: azd keeps
	// it in the environment of the machine that deployed, and a runner starts
	// with none. The template may read it only beside the service's existence,
	// from which it keeps the image a running app has.
	const images = services.map((service) => `SERVICE_${service}_IMAGE_NAME`);
	expect(
		[...referenced].filter(
			(name) =>
				!reaching.has(name) &&
				!images.includes(name) &&
				!KEPT_OUT_OF_RUNS.includes(name),
		),
	).toEqual([]);
	// And those two never reach one.
	for (const name of KEPT_OUT_OF_RUNS) {
		expect(referenced.has(name), name).toBe(true);
		expect(reaching.has(name), name).toBe(false);
	}
	for (const service of services)
		if (referenced.has(`SERVICE_${service}_IMAGE_NAME`))
			expect([...referenced]).toContain(`SERVICE_${service}_RESOURCE_EXISTS`);
});

test("the workflows, the images and the dev container run one Bun", () => {
	const version = read(".bun-version").trim();
	const pins = Object.values(project.services).flatMap((service) =>
		[
			...read(service.project, service.docker.path).matchAll(
				/oven\/bun:([\d.]+)/g,
			),
		].map((m) => m[1]),
	);
	const container = JSON.parse(read(".devcontainer", "devcontainer.json")) as {
		features: Record<string, { version?: string }>;
	};
	const feature = Object.entries(container.features).find(([id]) =>
		id.includes("/bun:"),
	);
	expect(pins.length).toBeGreaterThan(0);
	expect([...pins, feature?.[1].version]).toEqual(
		[...pins, feature].map(() => version),
	);
	for (const { text } of workflows)
		if (text.includes("setup-bun"))
			expect(text).toContain("bun-version-file: .bun-version");
});

/** The folders that hold a lockfile: the root, or one folder down from it. */
const lockfiles = () =>
	[
		".",
		...readdirSync(AZD, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					entry.name !== "node_modules",
			)
			.map((entry) => entry.name),
	]
		.filter((folder) => existsSync(join(AZD, folder, "bun.lock")))
		.sort();

test("the audit asks about every lockfile, on a change and on a schedule, and installs nothing", () => {
	expect([...LOCKFILES].sort()).toEqual(lockfiles());
	const { parsed } = workflow("audit.yml");
	expect(Object.keys(parsed.on).sort()).toEqual([
		"pull_request",
		"push",
		"schedule",
		"workflow_dispatch",
	]);
	const runs = Object.values(parsed.jobs).flatMap((job) =>
		(job.steps ?? []).flatMap((step) => (step.run ? [step.run] : [])),
	);
	expect(runs).toEqual(["bun scripts/dependency-audit.ts"]);
});

test("Dependabot reads every lockfile the audit does", () => {
	const dependabot = YAML.parse(read(".github", "dependabot.yml")) as {
		updates: { "package-ecosystem": string; directory?: string }[];
	};
	const read_ = dependabot.updates
		.filter((update) => update["package-ecosystem"] === "bun")
		.map((update) => (update.directory ?? "").replace(/^\//, "") || ".")
		.sort();
	expect(read_).toEqual(lockfiles());
});

test("each image is scanned as it was built, by a scanner at a pinned version, and a finding fails the job", () => {
	const { parsed } = workflow("ci.yml");
	const steps = parsed.jobs.image?.steps ?? [];
	const built = steps.findIndex((step) => step.run?.startsWith("docker build"));
	const scanned = steps.findIndex((step) => step.uses?.includes("trivy"));
	expect(built).toBeGreaterThanOrEqual(0);
	expect(scanned).toBeGreaterThan(built);
	const tag = /--tag (.+) \.$/.exec(steps[built]?.run ?? "")?.[1];
	const scan = steps[scanned]?.with ?? {};
	expect(tag).toBeTruthy();
	expect(scan["image-ref"]).toBe(tag as string);
	expect(scan.version).toMatch(/^v\d+\.\d+\.\d+$/);
	expect(scan["exit-code"]).toBe("1");
});
