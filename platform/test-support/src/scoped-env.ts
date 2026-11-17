/**
 * Set environment variables for a test and hand back their restoration.
 *
 * Every test file runs in one process, so a variable left set or deleted is
 * set or deleted for every file after it, and a suite that then skips does
 * so silently. `undefined` unsets, because assigning `undefined` to
 * `process.env` writes the string "undefined", which every later file in
 * the run would read as configured.
 */
export function scopedEnv(
	values: Record<string, string | undefined>,
): () => void {
	const saved = Object.fromEntries(
		Object.keys(values).map((name) => [name, process.env[name]]),
	);
	apply(values);
	return () => apply(saved);
}

function apply(values: Record<string, string | undefined>): void {
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}
