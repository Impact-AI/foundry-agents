/**
 * A module stand-in that ends with the test file that made it.
 *
 * `mock.module` registers process-wide and for the rest of the run, so a
 * factory that returns a fixed object answers for every later file too, and a
 * suite that imports the real export directly still gets the stand-in, since
 * the binding rewritten is the one the real module exports. This returns the
 * override while standing and the real export after `release()`, so the
 * factory can be `() => standIn(real, overrides).module` and an `afterAll` can
 * call `release`.
 *
 * The real exports are captured as values up front: a namespace property is a
 * live binding, and a stand-in that read it later would be calling itself.
 *
 * A function export is answered by one proxy over the real function for the
 * whole run, since the binding a consumer imported is read once and has to
 * work on both sides of `release()`. It calls and constructs the override
 * while standing and the real function after, and everything else about it —
 * its statics, its prototype, what `instanceof` answers — is the real
 * function's throughout. The one thing it is not is the real function's
 * identity: `module.f === real.f` is false before and after.
 *
 * An override for a name the real module does not export is refused: it
 * would stand for nothing, and the test that wrote it would be testing the
 * real export believing otherwise.
 */
export interface StandIn<M extends object> {
	/** What the factory returns: overrides while standing, the real module after. */
	module: M;
	/** Hand every export back to the real module. Idempotent. */
	release(): void;
	/** Whether the overrides are still answering. */
	readonly standing: boolean;
}

export function standIn<M extends object>(
	real: M,
	overrides: Partial<M>,
): StandIn<M> {
	const captured = { ...real };
	let standing = true;
	const module = {} as M;
	for (const key of Object.keys(overrides)) {
		if (!(key in captured))
			throw new Error(
				`standIn: "${key}" is not an export of the real module, so nothing would read the override`,
			);
	}
	type Callable = (...args: unknown[]) => unknown;
	type Constructible = new (...args: unknown[]) => object;
	for (const key of Object.keys(captured) as (keyof M)[]) {
		const override = overrides[key];
		const original = captured[key];
		if (typeof original === "function" && typeof override === "function") {
			Object.defineProperty(module, key, {
				enumerable: true,
				value: new Proxy(original as Callable, {
					apply: (target, self, args) =>
						Reflect.apply(
							standing ? (override as Callable) : target,
							self,
							args,
						),
					// `new` on the export itself builds the class standing in or the real
					// one; `new` on a subclass of the export keeps the subclass as what is built.
					construct: (target, args, newTarget) => {
						const built = standing
							? (override as Constructible)
							: (target as unknown as Constructible);
						return Reflect.construct(
							built,
							args,
							newTarget === module[key] ? built : newTarget,
						);
					},
				}),
			});
		} else if (key in overrides) {
			Object.defineProperty(module, key, {
				enumerable: true,
				get: () => (standing ? overrides[key] : captured[key]),
			});
		} else {
			Object.defineProperty(module, key, {
				enumerable: true,
				get: () => captured[key],
			});
		}
	}
	return {
		module,
		release: () => {
			standing = false;
		},
		get standing() {
			return standing;
		},
	};
}
