/**
 * A provision of an environment that already runs. Three things a run can
 * lack and the deployment already holds, and none is taken from it: the image
 * each app runs, which azd keeps only on the machine that deployed, with the
 * release that image is and the impact.ai endpoint the app copies to; and a
 * Key Vault secret whose value the run's environment does not carry, the
 * session secret and the ingest key among them. A first
 * provision still gets the placeholder image and the placeholder secrets the
 * apps' references need.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	allErrors,
	allResources,
	compiledMain,
	type Deployment,
	INFRA,
	instantiate,
	moduleCalls,
	parameterFile,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const PLACEHOLDER =
	"mcr.microsoft.com/azuredocs/containerapps-helloworld:latest";

function deployment(overrides: Record<string, unknown> = {}): Deployment {
	const d = sampleDeployment(overrides);
	if (!d) throw new Error("no template");
	return d;
}

type Container = {
	image: unknown;
	probes?: unknown[];
	env: { name: string; value?: unknown }[];
};

function container(d: Deployment, service: "backend" | "frontend"): Container {
	const app = allResources(d).find(
		(r) =>
			r.type === "Microsoft.App/containerApps" &&
			r.condition &&
			(r.tags as Record<string, string>)["azd-service-name"] === service,
	)?.properties as { template: { containers: Container[] } } | undefined;
	const found = app?.template.containers[0];
	if (!found) throw new Error(`no ${service} container`);
	return found;
}

function jobImage(d: Deployment): unknown {
	const job = allResources(d).find(
		(r) => r.type === "Microsoft.App/jobs" && r.condition,
	)?.properties as { template: { containers: { image: unknown }[] } };
	return job.template.containers[0]?.image;
}

const envValue = (c: Container, name: string) =>
	c.env.find((e) => e.name === name)?.value;
const tagOf = (c: Container) => envValue(c, "IMAGE_TAG");

const RELEASE = {
	releaseId: "rel_0123456789abcdef01234567",
	releaseVersion: "7",
	releaseEnvironment: "production",
};
const RELEASE_VARIABLES = [
	"IMPACT_RELEASE_ID",
	"IMPACT_RELEASE_VERSION",
	"IMPACT_RELEASE_ENVIRONMENT",
];
const ENDPOINT = "https://ingest.example/v1/traces";

for (const service of ["backend", "frontend"] as const) {
	const image = `${service}Image`;
	const exists = `${service}Exists`;

	it(`${service}: an app that does not exist yet takes the placeholder, with no probe to fail on it`, () => {
		const c = container(deployment(), service);
		expect(c.image).toBe(PLACEHOLDER);
		expect(c.probes ?? []).toEqual([]);
		expect(tagOf(c)).toBe("");
	});

	it(`${service}: a first provision hands postdeploy the probes and the app's name, so a first \`azd up\` ends probed`, () => {
		// The placeholder gets none; azd deploy changes only the image, and
		// postdeploy gives these to an app that holds none.
		const d = deployment();
		const upper = service.toUpperCase();
		const module = d.resources.find((r) => r.symbol === `${service}App`);
		const outputs = module?.deployment?.outputs ?? {};
		// The same probes the template puts on an app that runs a built image.
		const probed = container(
			deployment({ [image]: "registry/app:7" }),
			service,
		).probes;
		expect(probed).toHaveLength(2);
		expect(outputs.probes).toEqual(probed);
		const app = allResources(d).find(
			(r) =>
				r.type === "Microsoft.App/containerApps" &&
				r.condition &&
				(r.tags as Record<string, string>)["azd-service-name"] === service,
		);
		expect(outputs.name).toBe(app?.name);
		// Into the azd environment, where postdeploy reads them: the probes as JSON.
		const main = compiledMain()?.outputs ?? {};
		expect(main[`${upper}_PROBES`]?.value).toBe(
			`[string(reference('${service}App').outputs.probes.value)]`,
		);
		expect(main[`${upper}_APP_NAME`]?.value).toBe(
			`[reference('${service}App').outputs.name.value]`,
		);
	});

	it(`${service}: an app that exists and is given no image keeps the one it runs, probes on`, () => {
		const c = container(deployment({ [exists]: true }), service);
		// Read from the running app: a value only the live deployment answers.
		expect(String(c.image)).toContain("reference(");
		expect(String(c.image)).toContain("template.containers.0.image");
		expect(String(c.image)).not.toContain("helloworld");
		expect(c.probes).toHaveLength(2);
	});

	it(`${service}: an app the resource group holds keeps its image when azd answers that it does not exist`, () => {
		// preprovision's own answer, from the resource group: either answer saying the app exists is enough.
		for (const servicesRunning of [service, "backend,frontend"]) {
			const c = container(
				deployment({ [exists]: false, servicesRunning }),
				service,
			);
			expect(String(c.image)).toContain("template.containers.0.image");
			expect(c.probes).toHaveLength(2);
		}
		// Naming the other service, or none, says nothing of this one.
		const other = service === "backend" ? "frontend" : "backend";
		for (const servicesRunning of [other, "none", ""])
			expect(container(deployment({ servicesRunning }), service).image).toBe(
				PLACEHOLDER,
			);
	});

	it(`${service}: an app that exists and is given no image keeps the release it runs and the endpoint it copies to, whatever release the run carries`, () => {
		// Development's provision runs before its deploy: the release it
		// carries is the next image's, which azd deploy puts on with it.
		const c = container(
			deployment({ [exists]: true, ...RELEASE, impactEndpoint: "" }),
			service,
		);
		for (const name of [...RELEASE_VARIABLES, "IMPACT_ENDPOINT"]) {
			const value = String(envValue(c, name));
			expect(value, name).toContain("template.containers.0.env");
			expect(value, name).toContain(name);
		}
	});

	it(`${service}: a named image carries the release the provision names, and an endpoint given replaces the one it runs`, () => {
		for (const overrides of [
			{ [image]: "registry/app:v7-0123abc" },
			{ [image]: "registry/app:v7-0123abc", [exists]: true },
		]) {
			const c = container(
				deployment({ ...overrides, ...RELEASE, impactEndpoint: ENDPOINT }),
				service,
			);
			expect(RELEASE_VARIABLES.map((name) => envValue(c, name))).toEqual(
				Object.values(RELEASE),
			);
			expect(envValue(c, "IMPACT_ENDPOINT")).toBe(ENDPOINT);
			expect(tagOf(c)).toBe("v7-0123abc");
		}
	});

	it(`${service}: a provision that names the image names the revision as the release says, and one that names none leaves it to Container Apps`, () => {
		const suffixOf = (overrides: Record<string, unknown>) => {
			const app = allResources(deployment(overrides)).find(
				(r) =>
					r.type === "Microsoft.App/containerApps" &&
					r.condition &&
					(r.tags as Record<string, string>)["azd-service-name"] === service,
			);
			if (!app) throw new Error(`no ${service} app`);
			const { template } = app.properties as {
				template: { revisionSuffix?: unknown };
			};
			return template.revisionSuffix ?? null;
		};
		expect(
			suffixOf({ [image]: "registry/app:v7-0123abc", revisionSuffix: "v7-p3" }),
		).toBe("v7-p3");
		// Development's provision runs before its deploy, which names its own.
		expect(suffixOf({ [exists]: true, revisionSuffix: "v7-p3" })).toBeNull();
		expect(suffixOf({ [image]: "registry/app:v7-0123abc" })).toBeNull();
	});

	it(`${service}: a first provision carries no release and no endpoint it was not given`, () => {
		const c = container(deployment(), service);
		for (const name of [...RELEASE_VARIABLES, "IMPACT_ENDPOINT"])
			expect(envValue(c, name), name).toBe("");
		expect(
			envValue(
				container(deployment({ impactEndpoint: ENDPOINT }), service),
				"IMPACT_ENDPOINT",
			),
		).toBe(ENDPOINT);
	});

	it(`${service}: a named image is the one deployed, whether or not the app exists`, () => {
		for (const overrides of [
			{ [image]: "registry/app:7" },
			{ [image]: "registry/app:7", [exists]: true },
		]) {
			const c = container(deployment(overrides), service);
			expect(c.image).toBe("registry/app:7");
			expect(c.probes).toHaveLength(2);
			expect(tagOf(c)).toBe("7");
		}
	});
}

it("the migrate job carries the backend's image, kept or placeholder as the backend's is", () => {
	expect(jobImage(deployment())).toBe(PLACEHOLDER);
	expect(jobImage(deployment({ backendImage: "registry/backend:3" }))).toBe(
		"registry/backend:3",
	);
	const kept = deployment({ backendExists: true });
	expect(jobImage(kept)).toEqual(container(kept, "backend").image);
});

test("the parameter file takes each app's existence from azd, false until it says otherwise, and from the hook's own look at the resource group", () => {
	const file = readFileSync(join(INFRA, "main.parameters.json"), "utf8");
	for (const service of ["BACKEND", "FRONTEND"])
		expect(file).toContain(`\${SERVICE_${service}_RESOURCE_EXISTS=false}`);
	expect(file).toContain(`\${SERVICES_RUNNING=}`);
});

type Secret = { name: string; value: string };

function secrets(overrides: Record<string, unknown> = {}): Secret[] {
	const vault = moduleCalls(deployment(overrides)).find(
		(m) => m.mainType === "Microsoft.KeyVault/vaults",
	);
	return (vault?.parameters.secrets ?? []) as Secret[];
}

const ALL = [
	"auth-secret",
	"entra-client-id",
	"entra-client-secret",
	"entra-issuer",
	"impact-api-key",
];

it("a first provision writes every secret the apps reference, a placeholder where no value is set", () => {
	const written = secrets();
	expect(written.map((s) => s.name)).toEqual(ALL);
	expect(
		Object.fromEntries(written.map((s) => [s.name, s.value])),
	).toMatchObject({
		"auth-secret": "auth",
		"entra-client-id": "unset",
		"entra-client-secret": "unset",
		"impact-api-key": "unset",
	});
});

it("impact.ai's ingest key is written when a provision carries it, and kept from the vault by one that does not", () => {
	expect(
		secrets({ vaultHolds: ALL.join(","), impactApiKey: "ingest" }),
	).toContainEqual({ name: "impact-api-key", value: "ingest" });
	expect(
		secrets({ vaultHolds: ALL.join(",") }).map((s) => s.name),
	).not.toContain("impact-api-key");
});

it("a secret the vault holds is left alone by a provision that carries no value for it", () => {
	const written = secrets({ vaultHolds: ALL.join(",") });
	// This environment carries the session secret and the issuer is the
	// template's own; the sign-in registration's two have no value here, and
	// the vault's are not replaced.
	expect(written.map((s) => s.name)).toEqual(["auth-secret", "entra-issuer"]);
	expect(written.map((s) => s.value)).not.toContain("unset");
});

it("a machine whose environment has no session secret leaves the vault's as it is: nobody is signed out by a provision", () => {
	// preprovision makes a secret only when neither the environment nor the vault has one, so here the value arrives empty.
	const written = secrets({ vaultHolds: ALL.join(","), authSecret: "" });
	expect(written.map((s) => s.name)).toEqual(["entra-issuer"]);
});

it("a value the provision carries is written whether or not the vault holds the secret", () => {
	const written = secrets({
		vaultHolds: ALL.join(","),
		entraClientId: "client",
		entraClientSecret: "secret",
	});
	expect(
		Object.fromEntries(written.map((s) => [s.name, s.value])),
	).toMatchObject({
		"entra-client-id": "client",
		"entra-client-secret": "secret",
	});
});

it("a vault that holds some of them gets a placeholder for the rest only", () => {
	const written = secrets({ vaultHolds: "auth-secret,entra-client-id" });
	expect(written.map((s) => [s.name, s.value])).toContainEqual([
		"entra-client-secret",
		"unset",
	]);
	expect(written.map((s) => s.name)).not.toContain("entra-client-id");
});

/**
 * The parameters a provision hands the template, resolved as azd resolves
 * them. Known from azd's behaviour (`armParameterFileValue` and
 * `ensureParameters` in its Bicep provider): the parameter file is read with
 * the environment substituted in; a string that comes out empty, and a text
 * that is not the boolean or the whole number its parameter is, count as no
 * value; a parameter with no value takes the template's default, and one with
 * no default either is asked for at the terminal, which a run with no
 * terminal (a pipeline's `--no-prompt`) fails on.
 */
function asAzdResolves(env: Record<string, string>): {
	given: Record<string, unknown>;
	askedFor: string[];
} {
	const declared = compiledMain()?.parameters ?? {};
	const given: Record<string, unknown> = {};
	const askedFor: string[] = [];
	const file = parameterFile(env);
	for (const [name, declaration] of Object.entries(declared)) {
		const written = file[name];
		let value: unknown = written;
		if (typeof written === "string") {
			if (declaration.type === "bool")
				value = /^(1|t|true|0|f|false)$/i.test(written)
					? /^(1|t|true)$/i.test(written)
					: undefined;
			else if (declaration.type === "int")
				value = /^[+-]?\d+$/.test(written) ? Number(written) : undefined;
			else if (
				declaration.type === "string" ||
				declaration.type === "securestring"
			)
				value =
					written !== "" ||
					(typeof declaration.defaultValue === "string" &&
						declaration.defaultValue !== "")
						? written
						: undefined;
		}
		if (value !== undefined) given[name] = value;
		else if (declaration.defaultValue === undefined) askedFor.push(name);
	}
	return { given, askedFor };
}

/** What azd always has: the environment's name, its region and who provisions. */
const AZD = {
	AZURE_ENV_NAME: "sample",
	AZURE_LOCATION: "westeurope",
	AZURE_PRINCIPAL_ID: "11111111-2222-3333-4444-555555555555",
};

function provisioned(env: Record<string, string>): Deployment {
	const template = compiledMain();
	if (!template) throw new Error("no template");
	const { given, askedFor } = asAzdResolves({ ...AZD, ...env });
	expect(askedFor).toEqual([]);
	return instantiate(template, given);
}

const vaultSecrets = (d: Deployment) =>
	(moduleCalls(d).find((m) => m.mainType === "Microsoft.KeyVault/vaults")
		?.parameters.secrets ?? []) as Secret[];

it("a provision whose environment carries no session secret is asked for nothing and leaves the vault's alone, through the parameter file as azd reads it", () => {
	// A second machine, or a pipeline with no AUTH_SECRET: the hook found the
	// secret in the vault and made none.
	const d = provisioned({ KEY_VAULT_HOLDS: ALL.join(",") });
	expect(allErrors(d)).toEqual([]);
	expect(vaultSecrets(d).map((s) => s.name)).not.toContain("auth-secret");
	// The file hands the variable on empty, never as a text azd would pass through.
	expect(readFileSync(join(INFRA, "main.parameters.json"), "utf8")).toContain(
		`"authSecret": { "value": "\${AUTH_SECRET=}" }`,
	);
});

it("a first provision writes the secret the hook made, and nothing else is asked for", () => {
	const d = provisioned({
		KEY_VAULT_HOLDS: "none",
		AUTH_SECRET: "a".repeat(64),
	});
	expect(allErrors(d)).toEqual([]);
	expect(vaultSecrets(d)).toContainEqual({
		name: "auth-secret",
		value: "a".repeat(64),
	});
});

it("a provision with no session secret and a vault that holds none is refused by name: the placeholder is never what the apps sign with", () => {
	for (const KEY_VAULT_HOLDS of ["none", "entra-client-id"]) {
		const d = provisioned({ KEY_VAULT_HOLDS });
		expect(allErrors(d).join("\n")).toContain(
			"AUTH_SECRET is empty and the vault holds no auth-secret",
		);
	}
	// The others keep their placeholder: a sign-in nobody set up fails the
	// sign-in, not the provision, and an ingest key nobody set copies nothing.
	const placed = vaultSecrets(
		provisioned({ KEY_VAULT_HOLDS: "none", AUTH_SECRET: "a".repeat(64) }),
	);
	expect(placed.filter((s) => s.value === "unset").map((s) => s.name)).toEqual([
		"entra-client-id",
		"entra-client-secret",
		"impact-api-key",
	]);
});
