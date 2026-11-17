import { expect, test } from "bun:test";
import { keyNamespace } from "./keys";

test("keys sit under the prefix; a tenant's keys carry its hash tag", () => {
	const keys = keyNamespace("svc");
	expect(keys.prefix).toBe("svc");
	expect(keys.key("lock", "sweeper")).toBe("svc:lock:sweeper");
	expect(keys.tenantKey("t1", "queue", "pending")).toBe(
		"svc:{t1}:queue:pending",
	);
});

test("a child is a namespace of its own beside the parent, and its segment is a prefix in its own right", () => {
	const child = keyNamespace("svc").child("notes");
	expect(child.prefix).toBe("svc-notes");
	expect(child.key("pending")).toBe("svc-notes:pending");
	expect(child.tenantKey("t1", "lane")).toBe("svc-notes:{t1}:lane");
	expect(child.child("retries").prefix).toBe("svc-notes-retries");
	for (const bad of ["", "{x}", "a:b", "-x", " x"]) {
		expect(() => keyNamespace("svc").child(bad)).toThrow(RangeError);
	}
});

test("a prefix is a plain identifier, and a part is non-empty with no brace of its own", () => {
	for (const bad of ["", " svc", "svc:", "{svc}", "-svc"]) {
		expect(() => keyNamespace(bad)).toThrow(RangeError);
	}
	const keys = keyNamespace("svc");
	expect(() => keys.key()).toThrow(RangeError);
	expect(() => keys.key("")).toThrow(RangeError);
	expect(() => keys.key("a{b}")).toThrow(RangeError);
	expect(() => keys.tenantKey("{t}", "x")).toThrow(RangeError);
	expect(() => keys.tenantKey("t")).toThrow(RangeError);
});
