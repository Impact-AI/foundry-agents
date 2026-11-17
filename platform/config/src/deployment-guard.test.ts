import { expect, test } from "bun:test";
import {
	assertDeploymentSafe,
	forbidWhenActive,
	forbidWhenSet,
	isDeployedEnvironment,
	isDeployedJob,
	isProductionRuntime,
	refuseValue,
	requireNonEmpty,
} from "./deployment-guard";

const RULES = [
	forbidWhenActive("MOCK_DATA", "serves invented data"),
	forbidWhenSet("DEV_ACCOUNT_EMAIL", "names a fabricated operator"),
	requireNonEmpty("AUTH_SECRET", "caller authentication fails open without it"),
	refuseValue("ALLOWED_ORIGIN", "*", "lets any page read responses"),
];

const DEPLOYED = { CONTAINER_APP_NAME: "backend" };

test("deployed is the container app's own variable", () => {
	expect(isDeployedEnvironment({})).toBe(false);
	expect(isDeployedEnvironment({ CONTAINER_APP_NAME: " " })).toBe(false);
	expect(isDeployedEnvironment(DEPLOYED)).toBe(true);
});

test("a job execution is the job's own variable, and is not a replica", () => {
	const job = { CONTAINER_APP_JOB_NAME: "migrate" };
	expect(isDeployedJob({})).toBe(false);
	expect(isDeployedJob({ CONTAINER_APP_JOB_NAME: " " })).toBe(false);
	expect(isDeployedJob(job)).toBe(true);
	expect(isDeployedEnvironment(job)).toBe(false);
	expect(isDeployedJob(DEPLOYED)).toBe(false);
});

test("the production image is held to the rules wherever it runs, not only on Container Apps", () => {
	const elsewhere = { NODE_ENV: "production" };
	expect(isProductionRuntime(elsewhere)).toBe(true);
	expect(isProductionRuntime(DEPLOYED)).toBe(true);
	expect(isProductionRuntime({ NODE_ENV: "development" })).toBe(false);
	expect(isProductionRuntime({})).toBe(false);
	expect(() => assertDeploymentSafe(RULES, elsewhere)).toThrow(
		/NODE_ENV="production"[\s\S]*AUTH_SECRET is missing/,
	);
	expect(() =>
		assertDeploymentSafe(RULES, { ...elsewhere, AUTH_SECRET: "s" }),
	).not.toThrow();
});

test("a correctly configured deployment starts; a laptop with every override starts too", () => {
	expect(() =>
		assertDeploymentSafe(RULES, {
			...DEPLOYED,
			AUTH_SECRET: "s",
			MOCK_DATA: "0",
		}),
	).not.toThrow();
	expect(() =>
		assertDeploymentSafe(RULES, {
			MOCK_DATA: "1",
			DEV_ACCOUNT_EMAIL: "dev@example.test",
			ALLOWED_ORIGIN: "*",
		}),
	).not.toThrow();
});

test("every offender is named at once, with its effect, and a toggle with its value", () => {
	let message = "";
	try {
		assertDeploymentSafe(RULES, {
			...DEPLOYED,
			MOCK_DATA: "pasted-secret-value",
			DEV_ACCOUNT_EMAIL: "dev@example.test",
			ALLOWED_ORIGIN: "*",
		});
	} catch (err) {
		message = (err as Error).message;
	}
	expect(message).toContain("MOCK_DATA is on — serves invented data");
	expect(message).not.toContain("pasted-secret-value");
	expect(message).toContain(
		"DEV_ACCOUNT_EMAIL is set — names a fabricated operator",
	);
	expect(message).not.toContain("dev@example.test");
	expect(message).toContain("AUTH_SECRET is missing or empty");
	expect(message).toContain('ALLOWED_ORIGIN="*"');
});

test("a toggle is off only on the explicit off-values; a named thing is refused on any value", () => {
	for (const raw of ["0", "false", "no", "off", ""]) {
		expect(() =>
			assertDeploymentSafe([forbidWhenActive("T", "x")], {
				...DEPLOYED,
				T: raw,
			}),
		).not.toThrow();
	}
	expect(() =>
		assertDeploymentSafe([forbidWhenActive("T", "x")], {
			...DEPLOYED,
			T: "maybe",
		}),
	).toThrow();
	expect(() =>
		assertDeploymentSafe([forbidWhenSet("N", "x")], { ...DEPLOYED, N: "0" }),
	).toThrow();
});

test("a variable that must not be set is named, and its value is never printed", () => {
	const rule = forbidWhenSet("ACCOUNT_KEY", "opens the account");
	const problem = rule.check({ ACCOUNT_KEY: "s3cr3t-value" });
	expect(problem).toContain("ACCOUNT_KEY");
	expect(problem).not.toContain("s3cr3t-value");
	let thrown = "";
	try {
		assertDeploymentSafe([rule], { ...DEPLOYED, ACCOUNT_KEY: "s3cr3t-value" });
	} catch (err) {
		thrown = String(err);
	}
	expect(thrown).toContain("ACCOUNT_KEY");
	expect(thrown).not.toContain("s3cr3t-value");
});
