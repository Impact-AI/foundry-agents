import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ProductModule } from "./backend-product";

/**
 * The product is `product.ts` and `product/`, and the rest of the app reads
 * it through `product.ts` alone: its routes, its tools, its library and its
 * surfaces all reach the app on the one object that file builds. So a file
 * outside the two never imports from `product/` — read off every import in
 * the source, tests and stand-ins included — and the app's own files take
 * from `product.ts` only the names `ProductModule` declares.
 */
const SRC = import.meta.dir;
const PRODUCT_DIR = join(SRC, "product");
const PRODUCT_FILE = join(SRC, "product.ts");

const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return path === PRODUCT_DIR ? [] : sources(path);
		return /\.tsx?$/.test(entry.name) && path !== PRODUCT_FILE ? [path] : [];
	});
}

// `./product` is the file: only a path below the folder is the folder's.
const inProduct = (path: string) => path.startsWith(`${PRODUCT_DIR}/`);

test("no file outside product.ts and product/ imports from product/", () => {
	const files = sources(SRC);
	// A walk that found nothing would pass for the wrong reason.
	expect(files.length).toBeGreaterThan(20);
	const reaching = files.flatMap((file) =>
		[...readFileSync(file, "utf8").matchAll(IMPORT)]
			.map((match) => match[1] ?? "")
			.filter((spec) => spec.startsWith("."))
			.filter((spec) => inProduct(resolve(dirname(file), spec)))
			.map((spec) => `${relative(SRC, file)} imports ${spec}`),
	);
	expect(reaching).toEqual([]);
});

/** The names `backend-product.ts`'s `ProductModule` declares: all the app takes from `product.ts`. */
const TAKEN = ["guardrails", "product", "prompt", "skills"];

const NAMED_IMPORT =
	/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

// A test and a stand-in are the sample's own, replaced with it.
const ofTheSample = (file: string) =>
	/\.test\.tsx?$/.test(file) || file.startsWith(join(SRC, "testing"));

test("the app's files take four names from product.ts and no other", () => {
	const taken = sources(SRC)
		.filter((file) => !ofTheSample(file))
		.flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(NAMED_IMPORT)]
				.filter(
					([, , spec = ""]) =>
						spec.startsWith(".") &&
						resolve(dirname(file), spec) === PRODUCT_FILE.replace(/\.ts$/, ""),
				)
				.flatMap(([, names = ""]) =>
					names
						.split(",")
						.map(
							(name) =>
								name
									.trim()
									.replace(/^type\s+/, "")
									.split(/\s+as\s+/)[0],
						)
						.filter((name): name is string => Boolean(name))
						.map((name) => ({ file: relative(SRC, file), name })),
				),
		);
	// Nothing found would pass for the wrong reason.
	expect(taken.length).toBeGreaterThan(3);
	expect(taken.filter(({ name }) => !TAKEN.includes(name))).toEqual([]);
	expect([...new Set(taken.map(({ name }) => name))].sort()).toEqual(TAKEN);
});

test("the product's object carries what the app reads off it", async () => {
	const module: ProductModule = await import("./product");
	expect(Object.keys(module).sort()).toEqual(expect.arrayContaining(TAKEN));
	const { product } = module;
	expect(Object.keys(product.surfaces).sort()).toEqual(["live", "web"]);
	expect(product.routes).toBeFunction();
	expect(product.library?.name).toBeTruthy();
});
