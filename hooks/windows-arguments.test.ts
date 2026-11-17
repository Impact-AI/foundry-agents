/**
 * What a Windows command line does to an argument, held by rule, since the
 * twins are run under PowerShell on Linux, where `az` is a program and an
 * argument reaches it as written. On Windows `az` is `az.cmd`: a double quote
 * inside an argument is taken out on the way, and an ampersand ends the
 * command there. No argument a `.ps1` hands `az` or `azd` therefore holds
 * either: a query that needs a quoted key is asked without one and read
 * here, and an address with a query string is asked for by its parameters.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Each `.ps1` of the hooks and the scripts. */
function twins(): string[] {
	return ["hooks", "scripts"].flatMap((dir) =>
		readdirSync(join(ROOT, dir))
			.filter((name) => name.endsWith(".ps1"))
			.map((name) => join(dir, name)),
	);
}

/**
 * What a script hands `az` or `azd`, a call at a time: the text after the
 * command's name, a line continued with a backtick joined to the next.
 */
function cliCalls(source: string): { line: number; args: string }[] {
	const calls: { line: number; args: string }[] = [];
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		let text = lines[i] ?? "";
		const line = i + 1;
		while (/`\s*$/.test(text) && i + 1 < lines.length)
			text = `${text.replace(/`\s*$/, " ")}${lines[++i]}`;
		if (/^\s*#/.test(text)) continue;
		// The command where a statement or an expression begins: never the
		// same letters inside a message.
		const call = /(?:^|[=(|;{]|@\()\s*(?:az|azd)\s+(.*)$/.exec(text);
		if (call?.[1]) calls.push({ line, args: call[1] });
	}
	return calls;
}

/**
 * Why Windows would not hand an argument of the call on as written, or null.
 * PowerShell quotes an argument that holds a space when it starts a program,
 * and inside quotes an ampersand is a character; in an argument with none it
 * ends the command.
 */
function lostOnWindows(args: string): string | null {
	// A stream sent to another (`2>&1`) is the shell's own and no argument.
	const call = args.replace(/\d?>&\d/g, " ");
	const split = (body: string) => body.includes("&") && !/\s/.test(body);
	// A single-quoted text is literal, so a double quote in it is in the argument.
	for (const [, body] of call.matchAll(/'((?:[^']|'')*)'/g)) {
		if (body?.includes('"')) return "a double quote inside an argument";
		if (body && split(body)) return "an ampersand in an argument with no space";
	}
	// In a double-quoted text, a backtick or a doubled quote puts one in.
	for (const [, body] of call.matchAll(/"((?:[^"`]|`.|"")*)"/g)) {
		if (body && /`"|""/.test(body)) return "a double quote inside an argument";
		if (body && split(body)) return "an ampersand in an argument with no space";
	}
	const bare = call
		.replace(/'(?:[^']|'')*'/g, " ")
		.replace(/"(?:[^"`]|`.|"")*"/g, " ");
	return bare.includes("&")
		? "an ampersand in an argument with no space"
		: null;
}

test("the rule reads a call, a continued one and an assignment, and no message that names the command", () => {
	const calls = cliCalls(
		[
			"# az storage account show",
			"az group exists -n $group",
			"$vault = az resource list `",
			"\t--query '[0].name' -o tsv",
			'throw "run az login first"',
			"$answer = @(azd env get-values)",
		].join("\n"),
	);
	expect(calls.map((c) => [c.line, c.args])).toEqual([
		[2, "group exists -n $group"],
		[3, "resource list  \t--query '[0].name' -o tsv"],
		[6, "env get-values)"],
	]);
});

test("a double quote or an ampersand in an argument is what Windows loses", () => {
	expect(
		lostOnWindows(`resource list --query '[].tags."azd-service-name"'`),
	).toBe("a double quote inside an argument");
	expect(lostOnWindows('rest --url "`"$page`""')).toBe(
		"a double quote inside an argument",
	);
	expect(lostOnWindows("rest --url https://example.test/list?a=1&b=2")).toBe(
		"an ampersand in an argument with no space",
	);
	expect(lostOnWindows('rest --url "$($list)?a=1&b=2"')).toBe(
		"an ampersand in an argument with no space",
	);
	// Quoted for its spaces, a query keeps its `&&`; a redirection is no argument.
	expect(
		lostOnWindows(`rest --query "value[?a=='x' && contains(b, 'y')].name"`),
	).toBeNull();
	expect(lostOnWindows("resource show --ids $id -o none 2>&1")).toBeNull();
	expect(
		lostOnWindows(`rest --query "[nextLink || '', value[].name][]"`),
	).toBeNull();
	expect(lostOnWindows("resource list --query '[].tags' -o json")).toBeNull();
});

test("no PowerShell twin hands az or azd an argument Windows would not hand on as written", () => {
	const scripts = twins();
	expect(scripts.length).toBeGreaterThan(5);
	let read = 0;
	const lost: string[] = [];
	for (const script of scripts)
		for (const { line, args } of cliCalls(
			readFileSync(join(ROOT, script), "utf8"),
		)) {
			read++;
			const why = lostOnWindows(args);
			if (why) lost.push(`${script}:${line}: ${why}`);
		}
	// The twins make dozens of calls; a reader that found none would pass anything.
	expect(read).toBeGreaterThan(40);
	expect(lost).toEqual([]);
});
