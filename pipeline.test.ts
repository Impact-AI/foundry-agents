/**
 * The workflows under .github. Every action is pinned to a commit, because a
 * tag can be moved to code nobody reviewed. The deploy workflow hands each azd
 * step exactly the variables and secrets `azd pipeline config` sets: azd's own
 * and those azure.yaml's `pipeline` block names. A name in the block the
 * workflow never passes reaches the repository and then nothing; a name the
 * workflow passes that the block does not list is never set, so reads empty.
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

const deploy = () => {
	const found = workflows.find((w) => w.file === "azure-dev.yml");
	if (!found) throw new Error("azure-dev.yml is missing");
	return found;
};

test("the deploy workflow runs by hand only, until pipeline config has given it an identity", () => {
	expect(Object.keys(deploy().parsed.on)).toEqual(["workflow_dispatch"]);
});

test("each azd step of the deploy workflow gets exactly what pipeline config sets", () => {
	const steps = Object.values(deploy().parsed.jobs).flatMap((job) =>
		(job.steps ?? [])
			.filter((step) => /^azd (provision|deploy)\b/.test(step.run ?? ""))
			.map((step) => ({ run: step.run, env: { ...job.env, ...step.env } })),
	);
	expect(steps.map((s) => s.run?.split(" ")[1])).toEqual([
		"provision",
		"deploy",
	]);
	const passed = (env: Record<string, string>, kind: "vars" | "secrets") =>
		Object.entries(env)
			.filter(([name, value]) => value === `\${{ ${kind}.${name} }}`)
			.map(([name]) => name)
			.sort();
	for (const { env } of steps) {
		expect(Object.keys(env).sort()).toEqual(
			[...passed(env, "vars"), ...passed(env, "secrets")].sort(),
		);
		expect(passed(env, "vars")).toEqual(
			[...AZD_VARIABLES, ...project.pipeline.variables].sort(),
		);
		expect(passed(env, "secrets")).toEqual(
			[...project.pipeline.secrets].sort(),
		);
	}
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
	// provision, whether each service's container app exists.
	const reaching = new Set([
		...AZD_VARIABLES,
		"AZURE_PRINCIPAL_ID",
		...services.map((service) => `SERVICE_${service}_RESOURCE_EXISTS`),
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
			(name) => !reaching.has(name) && !images.includes(name),
		),
	).toEqual([]);
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

const workflow = (file: string) => {
	const found = workflows.find((w) => w.file === file);
	if (!found) throw new Error(`${file} is missing`);
	return found;
};

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
