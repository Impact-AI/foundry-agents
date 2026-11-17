import { expect, test } from "bun:test";
import { standIn } from "./stand-in";

const real = {
	answer: (x: number) => x * 2,
	limit: 10,
	untouched: () => "real",
};

test("overrides answer while standing, the real exports after release", () => {
	const s = standIn(real, { answer: (x: number) => x * 100, limit: 1 });
	expect(s.module.answer(2)).toBe(200);
	expect(s.module.limit).toBe(1);
	expect(s.module.untouched()).toBe("real");
	s.release();
	expect(s.module.answer(2)).toBe(4);
	expect(s.module.limit).toBe(10);
	expect(s.standing).toBe(false);
});

test("the real functions were captured before anything could rewrite them", () => {
	const mutable = { f: () => "first" };
	const s = standIn(mutable, { f: () => "stand-in" });
	mutable.f = () => "rewritten";
	s.release();
	expect(s.module.f()).toBe("first");
});

test("a class handed back constructs, keeps its statics and answers instanceof", () => {
	class Real {
		static made = "real";
		readonly kind = "real";
		constructor(readonly n: number) {}
	}
	class Fake {
		readonly kind = "fake";
		readonly n = -1;
	}
	const s = standIn({ Real }, { Real: Fake as unknown as typeof Real });
	expect(new s.module.Real(1).kind).toBe("fake");
	s.release();
	const made = new s.module.Real(7);
	expect(made.kind).toBe("real");
	expect(made.n).toBe(7);
	expect(made).toBeInstanceOf(Real);
	expect(made).toBeInstanceOf(s.module.Real);
	expect(s.module.Real.made).toBe("real");
});

test("a subclass of a class that is stood in for builds itself, while the stand-in stands and after", () => {
	class Real {
		readonly kind: string = "real";
	}
	class Fake {
		readonly kind: string = "fake";
	}
	const s = standIn({ Real }, { Real: Fake as unknown as typeof Real });
	class Sub extends s.module.Real {
		readonly own = true;
	}
	const during = new Sub();
	expect(during).toBeInstanceOf(Sub);
	expect(during.own).toBe(true);
	expect(during.kind).toBe("fake");
	s.release();
	const after = new Sub();
	expect(after).toBeInstanceOf(Sub);
	expect(after).toBeInstanceOf(Real);
	expect(after.kind).toBe("real");
});

test("a function handed back keeps the properties the real one carries", () => {
	const f = Object.assign((x: number) => x + 1, { label: "real" });
	const s = standIn({ f }, { f: Object.assign(() => 0, { label: "fake" }) });
	expect(s.module.f(1)).toBe(0);
	s.release();
	expect(s.module.f(1)).toBe(2);
	expect(s.module.f.label).toBe("real");
});

test("an override for something the real module does not export is refused", () => {
	expect(() =>
		standIn(real, { missing: () => 1 } as unknown as Partial<typeof real>),
	).toThrow(/missing/);
});
