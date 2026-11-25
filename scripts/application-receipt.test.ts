import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AppState,
	parseArgs,
	Refused,
	receipt,
	type Sources,
	suiteOf,
	suitesIn,
} from "./application-receipt";

const work = mkdtempSync(join(tmpdir(), "receipt-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The root element as `bun test --reporter=junit` writes it. */
const junit = (tests: number, failures: number, skipped: number) =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${tests}" assertions="${tests * 2}" failures="${failures}" skipped="${skipped}" time="1.5">\n  <testsuite name="a.test.ts" tests="${tests}" failures="0" skipped="0"></testsuite>\n</testsuites>\n`;

const ENV = {
	AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000000",
	AZURE_RESOURCE_GROUP: "rg-dev",
	BACKEND_APP_NAME: "ca-backend-abc",
	FRONTEND_APP_NAME: "ca-frontend-abc",
};

function sources(
	answers: Record<string, AppState[]>,
	env: Record<string, string> = ENV,
): Sources & { slept: number } {
	const s = {
		slept: 0,
		env: async () => env,
		app: async (_subscription: string, _group: string, name: string) => {
			const queue = answers[name] ?? [];
			const next = queue.length > 1 ? queue.shift() : queue[0];
			if (!next) throw new Error(`no answer for ${name}`);
			return next;
		},
		sleep: async (ms: number) => {
			s.slept += ms;
		},
	};
	return s;
}

const running = (name: string, revision: string, tag: string): AppState => ({
	image: `cr.azurecr.io/agent-sample/${name}-dev:${tag}`,
	latest: revision,
	ready: revision,
});

const RELEASED = { imageTag: "v7-0123abc", revisionSuffix: "v7" };

test("a suite counts the tests that ran: passed is what ran less what failed, a skip is in neither", () => {
	expect(suiteOf("backend", "bun test apps/backend", junit(214, 0, 2))).toEqual(
		{
			suite: "backend",
			command: "bun test apps/backend",
			passed: 212,
			total: 212,
		},
	);
	expect(
		suiteOf("frontend", "bun test apps/frontend", junit(64, 3, 0)),
	).toEqual({
		suite: "frontend",
		command: "bun test apps/frontend",
		passed: 61,
		total: 64,
	});
	expect(() => suiteOf("backend", "bun test", "<html/>")).toThrow(Refused);
	expect(() =>
		suiteOf("backend", "bun test", '<testsuites tests="1" failures="0">'),
	).toThrow("no skipped");
});

test("both suites are read from the run's reports, and a missing one is named", () => {
	const dir = join(work, "tests");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir);
	writeFileSync(join(dir, "backend.xml"), junit(10, 0, 0));
	expect(() => suitesIn(dir)).toThrow("no frontend test report");
	writeFileSync(join(dir, "frontend.xml"), junit(5, 0, 1));
	expect(suitesIn(dir).map((s) => [s.suite, s.passed, s.total])).toEqual([
		["backend", 10, 10],
		["frontend", 4, 4],
	]);
});

test("the receipt names each app's revision the release named, and its image, with no tests where none ran", async () => {
	const got = await receipt(
		{ out: "x", ...RELEASED },
		sources({
			"ca-backend-abc": [
				running("backend", "ca-backend-abc--v7", "v7-0123abc"),
			],
			"ca-frontend-abc": [
				running("frontend", "ca-frontend-abc--v7", "v7-0123abc"),
			],
		}),
	);
	expect(got).toEqual({
		format: "impact-application-receipt/v1",
		services: [
			{
				name: "backend",
				image: "cr.azurecr.io/agent-sample/backend-dev:v7-0123abc",
				revision: "ca-backend-abc--v7",
			},
			{
				name: "frontend",
				image: "cr.azurecr.io/agent-sample/frontend-dev:v7-0123abc",
				revision: "ca-frontend-abc--v7",
			},
		],
	});
	expect(got).not.toHaveProperty("tests");
});

test("Development's receipt carries its own tests' counts", async () => {
	const dir = join(work, "dev-tests");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "backend.xml"), junit(212, 0, 0));
	writeFileSync(join(dir, "frontend.xml"), junit(64, 0, 0));
	const got = await receipt(
		{ out: "x", ...RELEASED, tests: dir },
		sources({
			"ca-backend-abc": [running("backend", "b--v7", "v7-0123abc")],
			"ca-frontend-abc": [running("frontend", "f--v7", "v7-0123abc")],
		}),
	);
	expect(got.tests).toEqual([
		{
			suite: "backend",
			command: "bun test apps/backend",
			passed: 212,
			total: 212,
		},
		{
			suite: "frontend",
			command: "bun test apps/frontend",
			passed: 64,
			total: 64,
		},
	]);
});

test("it waits for the release's revision to be the latest and ready, and gives up after ten minutes", async () => {
	const azd = (name: string): AppState => ({
		image: `cr.azurecr.io/${name}:v7-0123abc`,
		latest: `${name}--azd-1764064023`,
		ready: `${name}--azd-1764064023`,
	});
	const starting = (name: string): AppState => ({
		image: `cr.azurecr.io/${name}:v7-0123abc`,
		latest: `${name}--v7`,
		ready: `${name}--azd-1764064023`,
	});
	const s = sources({
		"ca-backend-abc": [
			azd("ca-backend-abc"),
			starting("ca-backend-abc"),
			running("backend", "ca-backend-abc--v7", "v7-0123abc"),
		],
		"ca-frontend-abc": [running("frontend", "f--v7", "v7-0123abc")],
	});
	const got = await receipt({ out: "x", ...RELEASED }, s);
	expect(got.services[0]?.revision).toBe("ca-backend-abc--v7");
	expect(s.slept).toBe(20_000);

	const stuck = sources({
		"ca-backend-abc": [starting("ca-backend-abc")],
		"ca-frontend-abc": [running("frontend", "f--v7", "v7-0123abc")],
	});
	await expect(receipt({ out: "x", ...RELEASED }, stuck)).rejects.toThrow(
		"is not ready (the ready one is ca-backend-abc--azd-1764064023) after 10 minutes",
	);
});

test("a rerun's revision carries its mark after the version", async () => {
	const got = await receipt(
		{ out: "x", imageTag: "v7-0123abc", revisionSuffix: "v7-a2" },
		sources({
			"ca-backend-abc": [running("backend", "b--v7-a2", "v7-0123abc")],
			"ca-frontend-abc": [running("frontend", "f--v7-a2", "v7-0123abc")],
		}),
	);
	expect(got.services.map((s) => s.revision)).toEqual(["b--v7-a2", "f--v7-a2"]);
});

test("an app that runs another image than the one the run deployed is refused, not confirmed", async () => {
	await expect(
		receipt(
			{ out: "x", imageTag: "v8-4567def", revisionSuffix: "v8" },
			sources({
				"ca-backend-abc": [running("backend", "b--v8", "v7-0123abc")],
				"ca-frontend-abc": [running("frontend", "f--v8", "v8-4567def")],
			}),
		),
	).rejects.toThrow("not the image tagged v8-4567def");
});

test("what it needs from the azd environment is named when it is missing", async () => {
	const { BACKEND_APP_NAME: _, ...rest } = ENV;
	await expect(
		receipt({ out: "x", ...RELEASED }, sources({}, rest)),
	).rejects.toThrow("BACKEND_APP_NAME is not in the azd environment");
});

test("the arguments: the receipt's path, the tag and the revision are required, and nothing unknown is taken", () => {
	const named = [
		"--out",
		"o.json",
		"--image-tag",
		"v1-abc1234",
		"--revision-suffix",
		"v1",
	];
	expect(parseArgs([...named, "--tests", "t"])).toEqual({
		out: "o.json",
		imageTag: "v1-abc1234",
		revisionSuffix: "v1",
		tests: "t",
	});
	expect(parseArgs(named)).toEqual({
		out: "o.json",
		imageTag: "v1-abc1234",
		revisionSuffix: "v1",
	});
	expect(() => parseArgs([])).toThrow("--out");
	expect(() => parseArgs(named.slice(0, 4))).toThrow("--revision-suffix");
	expect(() => parseArgs(["--out"])).toThrow(Refused);
	expect(() => parseArgs([...named, "--env", "dev"])).toThrow(Refused);
	expect(() => parseArgs([...named, "extra"])).toThrow(Refused);
});
