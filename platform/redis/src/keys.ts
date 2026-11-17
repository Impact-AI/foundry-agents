/**
 * Every key a process writes sits under one app-supplied prefix, so several
 * services share one instance without colliding and a test sweeps its own.
 * Braces are refused in every part: Redis reads `{…}` as a hash tag, and a tag
 * the caller did not mean changes which cluster slot a key lands on.
 */
export interface KeyNamespace {
	readonly prefix: string;
	/** `<prefix>:<part>:<part>…` */
	key(...parts: string[]): string;
	/**
	 * `<prefix>:{<tenant>}:<part>…`, hash-tagged so one tenant's keys share a
	 * cluster slot and a script may touch several of them at once.
	 */
	tenantKey(tenant: string, ...parts: string[]): string;
	/**
	 * A namespace of its own under `<prefix>-<segment>`, for a component that
	 * keeps keys beside its owner's rather than among them.
	 */
	child(segment: string): KeyNamespace;
}

const PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function keyNamespace(prefix: string): KeyNamespace {
	if (!PREFIX.test(prefix)) {
		throw new RangeError(
			`a key prefix is letters, digits, "_", "." or "-", got ${JSON.stringify(prefix)}`,
		);
	}
	return {
		prefix,
		key: (...parts) => `${prefix}:${join(parts)}`,
		tenantKey: (tenant, ...parts) =>
			`${prefix}:{${join([tenant])}}:${join(parts)}`,
		child: (segment) => {
			if (!PREFIX.test(segment)) {
				throw new RangeError(
					`a child segment is letters, digits, "_", "." or "-", got ${JSON.stringify(segment)}`,
				);
			}
			return keyNamespace(`${prefix}-${segment}`);
		},
	};
}

function join(parts: string[]): string {
	if (parts.length === 0) throw new RangeError("a key needs at least one part");
	for (const part of parts) {
		if (part === "" || /[{}]/.test(part)) {
			throw new RangeError(
				`a key part is non-empty and carries no braces, got ${JSON.stringify(part)}`,
			);
		}
	}
	return parts.join(":");
}
