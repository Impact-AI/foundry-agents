import { expect, test } from "bun:test";
import { RECOGNISED, scrubText } from "./text";

/** Each row is what was written and what may be recorded. */
function holds(rows: ReadonlyArray<readonly [string, string]>): void {
	for (const [written, recorded] of rows) {
		expect(scrubText(written)).toBe(recorded);
		// What is recorded is stable: a second pass changes nothing.
		expect(scrubText(recorded)).toBe(recorded);
	}
}

test("a URL of any network scheme loses its userinfo, its query and its value-shaped segments, and the sentence keeps its punctuation", () => {
	holds([
		[
			"fetch GET https://b.example.test/api/threads/9f3c2a11?token=secret failed",
			"fetch GET https://b.example.test/api/threads/:id failed",
		],
		[
			"connect rediss://:c2VjcmV0a2V5MTIzNDU2Nzg5MA==@name.redis.example.test:6380 refused",
			"connect rediss://name.redis.example.test:6380/ refused",
		],
		[
			"socket wss://voice.example.test/realtime?key=SECRETKEY123 closed",
			"socket wss://voice.example.test/realtime closed",
		],
		[
			"amqps://user:p4ssw0rd@bus.example.test/queue went away",
			"amqps://bus.example.test/queue went away",
		],
		["see https://x.example.test/a/b.", "see https://x.example.test/a/b."],
		[
			"first https://x.example.test/threads/9f3c2a11, then the next",
			"first https://x.example.test/threads/:id, then the next",
		],
		["(at https://x.example.test/a?sig=k)", "(at https://x.example.test/a)"],
	]);
});

test("a request path is known by its query or the method before it, and a bare path is left as a file would be", () => {
	holds([
		[
			"GET /api/media/12?sig=abc&format=json was refused",
			"GET /api/media/:id?format=json was refused",
		],
		[
			"GET /api/users/ada.lovelace/threads/9f3c2a11 failed",
			"GET /api/users/:id/threads/:id failed",
		],
		["DELETE /account: refused.", "DELETE /account: refused."],
		[
			"reading /srv/data/ada.lovelace/notes",
			"reading /srv/data/ada.lovelace/notes",
		],
	]);
});

test("a pair whose key names a credential keeps the key and loses the value", () => {
	holds([
		["api-key: 0123456789abcdef0123456789abcdef", "api-key: [redacted]"],
		[
			"retry with token=abcdef0123456789 now",
			"retry with token=[redacted] now",
		],
		[
			"sig=aGVsbG8%3D&se=2030-01-01T00%3A00%3A00Z&sv=2025-11-05&sp=r",
			"sig=[redacted]&se=[redacted]&sv=[redacted]&sp=[redacted]",
		],
		[
			"InstrumentationKey=00000000-1111-2222-3333-444444444444;IngestionEndpoint=https://in.example.test/",
			"InstrumentationKey=[redacted];IngestionEndpoint=https://in.example.test/",
		],
		[
			"AccountEndpoint=https://a.documents.example.test:443/;AccountKey=c2VjcmV0a2V5MTIz==;",
			"AccountEndpoint=https://a.documents.example.test/;AccountKey=[redacted];",
		],
		[
			"Endpoint=sb://bus.example.test/;SharedAccessKeyName=root;SharedAccessKey=abc123=",
			"Endpoint=sb://bus.example.test/;SharedAccessKeyName=root;SharedAccessKey=[redacted]",
		],
		["Authorization: Bearer abc", "Authorization: [redacted]"],
		["authorization: Basic dXNlcjpwYXNz", "authorization: [redacted]"],
		["x-api-key: k1 refused", "x-api-key: [redacted] refused"],
		["Cookie: session=abc; theme=dark", "Cookie: [redacted]"],
		[
			'body {"password":"hunter2","name":"x"}',
			'body {"password":"[redacted]","name":"x"}',
		],
		[
			"client_secret=s3cr3t&grant_type=code",
			"client_secret=[redacted]&grant_type=code",
		],
	]);
});

test("a credential after a bare scheme word goes when it reads as one; a signed token and an address are replaced by what they were", () => {
	holds([
		["header was Bearer abcdefgh12345678.xyz", "header was Bearer [redacted]"],
		["header was Bearer 0a1b2c3d", "header was Bearer [redacted]"],
		// Under eight characters nothing tells a credential from a word.
		["header was Bearer abc", "header was Bearer abc"],
		["sent Basic dXNlcjpwYXNz", "sent Basic [redacted]"],
		["Bearer token expired", "Bearer token expired"],
		["Basic authentication is off", "Basic authentication is off"],
		[
			"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk rejected",
			"token [token] rejected",
		],
		["no account for ada@example.test", "no account for [email]"],
		["mail ada.lovelace+notes@mail.example.test.", "mail [email]."],
	]);
});

test("a stack is left as it was written: file paths, positions, local schemes and package versions", () => {
	const stack = [
		"Error: boom",
		"    at handler (/app/src/routes/list.ts:12:7)",
		"    at async serve (/app/src/index.ts:40:3)",
		"    at dispatch (/app/node_modules/.bun/hono@4.6.3/node_modules/hono/dist/compose.js:22:17)",
		"    at read (/app/node_modules/.bun/@azure+cosmos@4.2.0/node_modules/@azure/cosmos/dist/index.js:9:1)",
		"    at render (/app/node_modules/.bun/next@15.1.0_react@19.0.0/node_modules/next/dist/server/render.js:5:2)",
		"    at build (/app/node_modules/.bun/pkg@2.0.0-rc.next/node_modules/pkg/index.js:1:1)",
		"    at route (webpack-internal:///(rsc)/./app/api/me/route.ts:11:9)",
		"    at load (file:///app/src/wiring.ts:58:12)",
		"    at node:internal/process/task_queues:95:5",
	].join("\n");
	holds([
		[stack, stack],
		["a/b ratio? 3/4", "a/b ratio? 3/4"],
		[
			"Unexpected token } in JSON at position 4",
			"Unexpected token } in JSON at position 4",
		],
		["the response was 503", "the response was 503"],
	]);
});

test("the forms a credential's pair is written in: quoted, in JSON, under any scheme, with the cookie whole", () => {
	holds([
		["authorization=Bearer abc.def", "authorization=[redacted]"],
		["Authorization: Token abc123", "Authorization: [redacted]"],
		["Authorization: ApiKey abc123", "Authorization: [redacted]"],
		["Authorization: SharedKey acct:sIgNaTuRe==", "Authorization: [redacted]"],
		[
			'Authorization: Digest username="bob", response="6629fae4"',
			"Authorization: [redacted]",
		],
		[
			"Proxy-Authorization: Basic dXNlcjpwYXNz\nnext line stays",
			"Proxy-Authorization: [redacted]\nnext line stays",
		],
		[
			"curl -H 'Authorization: Bearer abc' https://x.example.test/a",
			"curl -H 'Authorization: [redacted]' https://x.example.test/a",
		],
		['password="hunter2"', 'password="[redacted]"'],
		["password='hunter2'", "password='[redacted]'"],
		['token="abc"', 'token="[redacted]"'],
		["Pwd='hun ter2';", "Pwd='[redacted]';"],
		["password: hunter2", "password: [redacted]"],
		["my password: Tr0ub4dor&3 ok", "my password: [redacted] ok"],
		["--password=hunter2 --verbose", "--password=[redacted] --verbose"],
		["client.secret=abc", "client.secret=[redacted]"],
		[
			"aws_secret_access_key=wJalrXUtnFEMI/K7MDENG",
			"aws_secret_access_key=[redacted]",
		],
		['{"password":"it\'s \\"q\\" x","n":1}', '{"password":"[redacted]","n":1}'],
		['{"access_token":123456}', '{"access_token":[redacted]}'],
		[
			'{"refreshToken": "r-1", "ok": true}',
			'{"refreshToken": "[redacted]", "ok": true}',
		],
		['{"secret":null,"token":true}', '{"secret":null,"token":true}'],
		[
			'body was "{\\"password\\":\\"hunter2\\",\\"n\\":1}"',
			'body was "{\\"password\\":\\"[redacted]\\",\\"n\\":1}"',
		],
		['cookie: "a=b; c=d"', 'cookie: "[redacted]"'],
		["cookie: 'sid=abc'", "cookie: '[redacted]'"],
		['{"cookie":"session=abc"}', '{"cookie":"[redacted]"}'],
		[
			'{"set-cookie":["a=b; Path=/","c=d; HttpOnly"],"x":1}',
			'{"set-cookie":"[redacted]","x":1}',
		],
		["Set-Cookie: sid=abc; Path=/; HttpOnly", "Set-Cookie: [redacted]"],
		["https://u:p;ss@h.example.test/x", "https://h.example.test/x"],
		[
			"https://a.example.test/b?sv=2025-11-05&sig=abc gave 403",
			"https://a.example.test/b gave 403",
		],
	]);
});

test("what reads like a credential and is not one is left as it was written", () => {
	const kept = [
		"Basic usage of the API",
		"the Basic plan",
		"Bearer expired",
		"Bearer token expired",
		"Basic authentication is off",
		"pwd=/home/app",
		"PWD=/app",
		"pwd=~/work",
		"se=5",
		"sv=2",
		"x-se=1",
		"sp=r&st=now",
		"git@github.com:org/repo.git",
		"deploy@host.example.test:/srv/app",
		"password: required",
		"password: must be at least 8 characters",
		"Token: expired.",
		"token == null",
		"token => next",
		"Token::parse failed",
		"Unexpected token } in JSON at position 4",
		'{"inputTokens":10,"outputTokens":3,"totalTokens":13}',
		"max_tokens=4096",
		"SharedAccessKeyName=root",
		"problem.code=agent.turn.failed reason=settle",
		"GET /conversations/:id answered 404",
		"at 2026-01-01T00:00:00.000Z the read of thread:9f3c2a11 failed",
	];
	holds(kept.map((line) => [line, line] as const));
});

test("a megabyte of anything is read in a quarter of a second, and a text past the bound is cut at a word", () => {
	const million = 1_048_576;
	const fill = (unit: string, length: number): string =>
		unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
	const units = [
		"a",
		"a@a.a.",
		"a.",
		"%",
		"%41",
		"/-",
		"/a",
		"eyJ",
		"a-",
		"password ",
		"token=",
		'"',
		"Bearer ",
		" @",
		"@a.b",
		"://",
		"a://",
		"?",
		"/?",
		"pwd=/",
		"GET /a?",
		"Authorization: ",
		'cookie: "',
		"x@y.zz:",
		"--token",
	];
	const texts = [
		...units.map((unit) => fill(unit, million)),
		`a@${fill("a.", million)}`,
		`https://a.b/${fill(".", million)}`,
		`https://${fill("a;", million)}`,
		`password="${fill("x", million)}`,
		`{"cookie":[${fill("[", million)}`,
		// Just under the bound, where nothing is cut and all of it is read.
		...units.map((unit) => fill(unit, 65_000)),
		`https://a.b/${fill(".", 65_000)}`,
		`a@${fill("a.", 65_000)}`,
	];
	for (const text of texts) {
		const started = performance.now();
		const recorded = scrubText(text);
		const took = performance.now() - started;
		expect({ took: took < 250, sample: text.slice(0, 24) }).toEqual({
			took: true,
			sample: text.slice(0, 24),
		});
		expect(recorded.length).toBeLessThanOrEqual(65_536 + 12);
		expect(scrubText(recorded)).toBe(recorded);
	}
	const long = `${fill("word ", 70_000)}password=hunter2`;
	const recorded = scrubText(long);
	expect(recorded.endsWith("word [truncated]")).toBe(true);
	expect(recorded).not.toContain("hunter2");
	// A value the bound falls inside is dropped whole, never recorded in half.
	const straddling = `${fill("word ", 65_530)}token=abcdefghijklmnopqrstuvwxyz`;
	expect(scrubText(straddling)).not.toContain("abcdef");
});

/**
 * Texts nobody picked by hand: every word and mark the rules know
 * (`RECOGNISED`, from their own tables), alone and in the forms a rule goes
 * on from, repeated with each separator a rule stops or continues at. A rule
 * that reads the same stretch again from each place in it takes sixteen
 * times as long over four times the text; one that does not takes four.
 */
test("the time a reading takes grows with the text and no faster, whatever the text repeats", () => {
	const fill = (unit: string, length: number): string =>
		unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
	const goingOn = RECOGNISED.flatMap((word) =>
		/^[A-Za-z-]+$/.test(word)
			? [
					`${word}=`,
					`"${word}":[`,
					`'${word}=a `,
					`${word} "`,
					`${word} <`,
					`${word}://"`,
				]
			: [],
	);
	const words = [
		...RECOGNISED,
		...goingOn,
		"a",
		"a@a",
		"a@a.aa",
		"eyJaaaaaaaa",
		"eyJaaaaaaaa.aaaaaaaa",
		"GET /",
		"GET /a?",
		"/a?",
		"https://a.b/",
		"https://u:p@",
		"%",
		".",
		"-",
		"_",
		"&",
		";",
		'\\"',
	];
	const separators = ["", " ", "-", ".", "=", '"', "\n", "@"];
	const least = (text: string): number => {
		const started = performance.now();
		scrubText(text);
		return performance.now() - started;
	};
	const slow: string[] = [];
	let shapes = 0;
	for (const word of words)
		for (const separator of separators) {
			const unit = `${word}${separator}`;
			shapes++;
			const short = least(fill(unit, 16_384));
			let long = least(fill(unit, 65_000));
			// One more reading before a verdict: a pause in the process is not the text's doing.
			if (long > 6 * short + 10 || long > 200)
				long = Math.min(
					long,
					least(fill(unit, 65_000)),
					least(fill(unit, 65_000)),
				);
			if (long > 6 * short + 10 || long > 200)
				slow.push(
					`${JSON.stringify(unit)}: ${short.toFixed(1)} ms at 16 KB, ${long.toFixed(1)} ms at 64 KB`,
				);
		}
	expect(shapes).toBeGreaterThan(1_500);
	expect(slow).toEqual([]);
}, 120_000);

test("a key is found by its last word wherever it begins: after `_`, `$`, a digit, a `.` or a `:`", () => {
	holds([
		["_authToken=npm_Zq9Kw7Xy3", "_authToken=[redacted]"],
		[
			"//registry.npmjs.org/:_authToken=npm_Zq9Kw7Xy3",
			"//registry.npmjs.org/:_authToken=[redacted]",
		],
		['{"_token":"Zq9Kw7Xy3"}', '{"_token":"[redacted]"}'],
		['{"__secret":"Zq9Kw7Xy3"}', '{"__secret":"[redacted]"}'],
		['_password: "Zq9Kw7Xy3"', '_password: "[redacted]"'],
		["$_password=Zq9Kw7Xy3", "$_password=[redacted]"],
		["x._token=Zq9Kw7Xy3", "x._token=[redacted]"],
		["2fa_secret=Zq9Kw7Xy3", "2fa_secret=[redacted]"],
		["0_password=Zq9Kw7Xy3", "0_password=[redacted]"],
		["SIG=abc123 and Sig=def456", "SIG=[redacted] and Sig=[redacted]"],
	]);
});

test("a JSON value under a credential's key goes whole, over as many lines as it is written on, and however many times its quotes are escaped", () => {
	holds([
		[
			JSON.stringify({ token: ["Zq9Kw7Xy3"] }, null, 2),
			'{\n  "token": "[redacted]"\n}',
		],
		[
			JSON.stringify({ clientSecret: { value: "Zq9Kw7Xy3" } }, null, 2),
			'{\n  "clientSecret": "[redacted]"\n}',
		],
		[
			JSON.stringify({ headers: { cookie: ["a=SECRET"] } }, null, 2),
			'{\n  "headers": {\n    "cookie": "[redacted]"\n  }\n}',
		],
		['"password":\n"SECRET"', '"password":\n"[redacted]"'],
		['{\\"token\\":\\"Zq9Kw7Xy3\\"}', '{\\"token\\":\\"[redacted]\\"}'],
		[
			'{\\\\\\"token\\\\\\":\\\\\\"Zq9Kw7Xy3\\\\\\",\\\\\\"a\\\\\\":1}',
			'{\\\\\\"token\\\\\\":\\\\\\"[redacted]\\\\\\",\\\\\\"a\\\\\\":1}',
		],
		['env["API_TOKEN"]=Zq9Kw7Xy3', 'env["API_TOKEN"]=[redacted]'],
		[
			"headers['x-api-key'] = 'Zq9Kw7Xy3'",
			"headers['x-api-key'] = '[redacted]'",
		],
		["password=<Zq9Kw7Xy3>", "password=<[redacted]>"],
	]);
});

test("a URL's userinfo and query go whatever they hold: a quote, a bracket, a `;`", () => {
	holds([
		[
			"redis://u:Zq9)Kw7)Xy3@h.example.com:6380/0",
			"redis://h.example.com:6380/:id",
		],
		['https://Zq9"Kw7:Xy3"@h.example.com/p', "https://h.example.com/p"],
		["https://u:p;ss@h.example.com/x", "https://h.example.com/x"],
		["https://h.example.com/p?token=ab'Zq9Kw7Xy3", "https://h.example.com/p"],
		[
			'fetch("https://x.example.test/a?token=abc") failed',
			'fetch("https://x.example.test/a") failed',
		],
		["see (https://x.example.test/a?b=c).", "see (https://x.example.test/a)."],
	]);
});

test("a URL that names a place in the code keeps its path and loses a userinfo, and a credential's pair inside it goes as anywhere", () => {
	holds([
		["webpack://./a.js?token=Zq9Kw7Xy3", "webpack://./a.js?token=[redacted]"],
		["file://u:Zq9Kw7Xy3@host/share", "file://host/share"],
		["app://cb?code=abc&token=Kw7Xy3", "app://cb?code=abc&token=[redacted]"],
		["rsc://x?password=Zq9Kw7Xy3", "rsc://x?password=[redacted]"],
		[
			"at g (webpack-internal:///(rsc)/./src/app.ts:3:1)",
			"at g (webpack-internal:///(rsc)/./src/app.ts:3:1)",
		],
		[
			"at f (turbopack://[project]/src/app.ts:3:1)",
			"at f (turbopack://[project]/src/app.ts:3:1)",
		],
	]);
});

test("an address at a host whose first label is a number is one; a package's version is not", () => {
	holds([
		["alice@163.com wrote", "[email] wrote"],
		["bob@126.com and eve@139.com", "[email] and [email]"],
		[
			"pkg@1.2.3 pkg@1.2.3-rc.next next@15.1.0_react@19.0.0",
			"pkg@1.2.3 pkg@1.2.3-rc.next next@15.1.0_react@19.0.0",
		],
	]);
});

test("a credential in quotes or brackets after a bare scheme word, after a command's flag, and after curl's -u", () => {
	holds([
		['Bearer "s3cr3tV4lue9XyZ"', 'Bearer "[redacted]"'],
		["Bearer 's3cr3tV4lue9XyZ'", "Bearer '[redacted]'"],
		["Bearer <s3cr3tV4lue9XyZ>", "Bearer <[redacted]>"],
		['say "Basic usage" twice', 'say "Basic usage" twice'],
		[
			"login --password Zq9Kw7Xy3 --token abc123def --verbose",
			"login --password [redacted] --token [redacted] --verbose",
		],
		["run --password --verbose", "run --password --verbose"],
		[
			"curl -u bob:Zq9Kw7Xy3 https://h.example.com/x",
			"curl -u [redacted] https://h.example.com/x",
		],
		[
			"curl --user 'bob:Zq9Kw7Xy3' -H 'Authorization: Token abc123' https://h.example.com/x",
			"curl --user '[redacted]' -H 'Authorization: [redacted]' https://h.example.com/x",
		],
		["tar -u archive.tar", "tar -u archive.tar"],
	]);
});

test("a query value runs past a quote, a bracket or a full stop inside it, and ends at the whitespace or the close after them", () => {
	holds([
		['https://h.example.com/p?token=ab".Zq9Kw7Xy3', "https://h.example.com/p"],
		["https://h.example.com/p?token=ab]]Zq9Kw7Xy3", "https://h.example.com/p"],
		[
			"https://h.example.com/p?token=ab)?Zq9Kw7Xy3 x",
			"https://h.example.com/p x",
		],
		["https://h.example.com/p?token=ab',Zq9Kw7Xy3", "https://h.example.com/p"],
		['GET /p?token=a".Zq9Kw7Xy3', "GET /p"],
		['see /p?token=a".Zq9Kw7Xy3 end', "see /p end"],
		[
			'("https://h.example.com/p?token=abc") next',
			'("https://h.example.com/p") next',
		],
		[
			"[link](https://h.example.com/p?token=abc) next",
			"[link](https://h.example.com/p) next",
		],
	]);
});

test("a userinfo goes whatever its length, a key is read by its end whatever its length, and a path after a `:` is a path", () => {
	const long = `https://u:"${"x".repeat(520)}Zq9Kw7Xy3@h.example.com/x`;
	holds([
		[long, "https://h.example.com/x"],
		[
			"MY_SERVICE_INTEGRATION_ENVIRONMENT_PRODUCTION_DATABASE_ADMIN_PASSWORD=Zq9Kw7Xy3",
			"MY_SERVICE_INTEGRATION_ENVIRONMENT_PRODUCTION_DATABASE_ADMIN_PASSWORD=[redacted]",
		],
		["redirect:/cb?token=Zq9Kw7Xy3", "redirect:/cb"],
		["redirect:/cb?code=Zq9Kw7Xy3", "redirect:/cb"],
		["at https://a.example.test:443/x", "at https://a.example.test/x"],
	]);
});

test("a value escaped deeper than is counted goes with the rest of its line, and a signed token glued to a word is one", () => {
	const deep = "\\".repeat(31);
	holds([
		[`{"password":${deep}"Zq9Kw7Xy3${deep}"}`, '{"password":[redacted]'],
		[
			`{${deep}"password${deep}":${deep}"Zq9Kw7Xy3${deep}"}`,
			`{${deep}"password${deep}":[redacted]`,
		],
		["_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk", "_[token]"],
		["1eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk", "1[token]"],
	]);
});

test("every key the README names goes, under `=` and as a header", () => {
	holds([
		["passwd=Zq9Kw7Xy3", "passwd=[redacted]"],
		["passphrase=Zq9Kw7Xy3", "passphrase=[redacted]"],
		["privatekey=Zq9Kw7Xy3", "privatekey=[redacted]"],
		["sharedaccesssignature=Zq9Kw7Xy3", "sharedaccesssignature=[redacted]"],
		["accesskey=Zq9Kw7Xy3", "accesskey=[redacted]"],
		["apikey=Zq9Kw7Xy3", "apikey=[redacted]"],
		["subscriptionkey=Zq9Kw7Xy3", "subscriptionkey=[redacted]"],
		[
			"Ocp-Apim-Subscription-Key: Zq9Kw7Xy3",
			"Ocp-Apim-Subscription-Key: [redacted]",
		],
		["x-api-key: Zq9Kw7Xy3", "x-api-key: [redacted]"],
		[
			"sig=a&sr=bZq9Kw7Xy3&st=cZq9Kw7Xy3",
			"sig=[redacted]&sr=[redacted]&st=[redacted]",
		],
		["sr=b&st=c without a signature", "sr=b&st=c without a signature"],
	]);
});

test("a curl command continued over lines keeps its -u a credential, and a quote never closed after a flag takes its word", () => {
	holds([
		[
			"curl \\\n  -u bob:Zq9Kw7Xy3 \\\n  https://h.example.com/x",
			"curl \\\n  -u [redacted] \\\n  https://h.example.com/x",
		],
		["curl `\n  -u bob:Zq9Kw7Xy3", "curl `\n  -u [redacted]"],
		["curl ^\n  -u bob:Zq9Kw7Xy3", "curl ^\n  -u [redacted]"],
		["curl x\n-u bob:Zq9Kw7Xy3", "curl x\n-u bob:Zq9Kw7Xy3"],
		["login --password 'Zq9Kw7Xy3", "login --password [redacted]"],
	]);
});

test("what the rules do not reach is left, and the README says so", () => {
	holds([
		// No key the list names, and no origin or leading `/` to know a request path by.
		["../cb?code=S3cr3t", "../cb?code=S3cr3t"],
		["example.com/p?code=S", "example.com/p?code=S"],
		// A provider's key by its prefix, with no key before it.
		["using ghp_Zq9Kw7Xy3Zq9Kw7Xy3", "using ghp_Zq9Kw7Xy3Zq9Kw7Xy3"],
		// A flag's value that begins with `-` reads as the next flag.
		["--password -Zq9Kw7Xy3", "--password -Zq9Kw7Xy3"],
		// A bare scheme word's credential ends at a `,`, and four letters are a word.
		["Bearer abcd,Zq9Kw7Xy3", "Bearer abcd,Zq9Kw7Xy3"],
		// A signed token whose last part is short is not taken for one.
		[
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
		],
	]);
});

test("a second reading changes nothing, whatever was written", () => {
	// What follows a replacement is read against the replacement, as the
	// second reading will meet it: the path after the address is a path both times.
	holds([["p@h.example.test/a/9f3c2a11?x=1 next", "[email]/a/:id next"]]);
	const pieces = [
		"password",
		"token",
		"sig",
		"se",
		"Authorization",
		"cookie",
		"Bearer",
		"Basic",
		"eyJhbGciOiJIUzI1NiJ9",
		"https",
		"rediss",
		"git",
		"GET",
		"ada",
		"example.test",
		"hunter2",
		"abc123XYZ",
		"9f3c2a11",
		"[redacted]",
		"[email]",
		"[token]",
		"[url]",
		":id",
		" [truncated]",
		"=",
		":",
		"://",
		"@",
		"/",
		"?",
		"&",
		";",
		",",
		".",
		"-",
		"_",
		" ",
		"\n",
		'"',
		"'",
		"\\",
		"{",
		"}",
		"[",
		"]",
		"(",
		")",
		"<",
		">",
		"%",
		"+",
		"1",
		"a",
	];
	let seed = 20_240_229;
	const next = (): number => {
		seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
		return seed;
	};
	for (let round = 0; round < 40_000; round++) {
		let text = "";
		for (let length = 1 + (next() % 14); length > 0; length--)
			text += pieces[next() % pieces.length];
		const once = scrubText(text);
		if (scrubText(once) !== once)
			expect({ text, once, twice: scrubText(once) }).toBeNull();
	}
});
