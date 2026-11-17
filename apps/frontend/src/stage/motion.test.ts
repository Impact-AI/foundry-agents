import { expect, test } from "bun:test";
import { guideScrollTo, placeCard } from "./guide-place";
import { eased, flipFrames, worthPlaying } from "./stage-flip";
import { activePage } from "./stage-pages";
import { pickLine, poolFor, RARE_ODDS } from "./thinking-lines";

test("the flip's two halves compose to the identity at every sample", () => {
	const { tile, inner } = flipFrames({ dx: 120, dy: -40, sx: 2, sy: 0.5 });
	expect(tile).toHaveLength(inner.length);
	for (const [i, frame] of tile.entries()) {
		const k = /scale\(([^,]+), ([^)]+)\)/.exec(frame.transform);
		const r = /scale\(([^,]+), ([^)]+)\)/.exec(inner[i]?.transform ?? "");
		if (!k || !r) throw new Error("no scale");
		expect(Number(k[1]) * Number(r[1])).toBeCloseTo(1, 9);
		expect(Number(k[2]) * Number(r[2])).toBeCloseTo(1, 9);
	}
	expect(tile[0]?.transform).toBe("translate(120px, -40px) scale(2, 0.5)");
	expect(tile.at(-1)?.transform).toBe("translate(0px, 0px) scale(1, 1)");
});

test("the curve is monotonic and ends where it starts", () => {
	expect(eased(0)).toBe(0);
	expect(eased(1)).toBe(1);
	let last = 0;
	for (let x = 0.05; x < 1; x += 0.05) {
		const y = eased(x);
		expect(y).toBeGreaterThanOrEqual(last);
		last = y;
	}
});

test("a move too small to see is not played", () => {
	expect(worthPlaying({ dx: 0.2, dy: 0, sx: 1.001, sy: 1 })).toBe(false);
	expect(worthPlaying({ dx: 3, dy: 0, sx: 1, sy: 1 })).toBe(true);
});

test("the pager lights the page nearest its offset", () => {
	const pages = [
		{ key: "chat", left: 0 },
		{ key: "reader", left: 393 },
	];
	expect(activePage(0, pages)).toBe("chat");
	expect(activePage(250, pages)).toBe("reader");
	expect(activePage(0, [])).toBeNull();
});

test("a wait draws a line, never the same one twice running", () => {
	expect(poolFor(RARE_ODDS - 0.001)).toBe("rare");
	expect(poolFor(RARE_ODDS)).toBe("lines");
	expect(pickLine(["a", "b"], "a", 0)).toBe("b");
	expect(pickLine(["a"], "a", 0.5)).toBe("a");
	expect(pickLine([], null, 0.5)).toBeNull();
	expect(pickLine(["a", "b", "c"], null, 1)).toBe("c");
});

test("the guide's card stands beside its stop where there is room, and over it where there is none", () => {
	const view = { width: 1400, height: 900 };
	const card = { width: 320, height: 160 };
	expect(placeCard(null, card, view)).toEqual({ x: 540, y: 370 });
	expect(
		placeCard(
			{ top: 100, left: 40, width: 200, height: 80, radius: 8 },
			card,
			view,
		),
	).toEqual({
		x: 254,
		y: 60,
	});
	const cramped = placeCard(
		{ top: 10, left: 10, width: 300, height: 600, radius: 8 },
		card,
		{ width: 340, height: 640 },
	);
	expect(cramped.x).toBeGreaterThanOrEqual(12);
	expect(cramped.y).toBeGreaterThanOrEqual(12);
	expect(
		guideScrollTo({ top: 200, height: 100 }, { height: 800, scrollY: 0 }, 64),
	).toBeNull();
	expect(
		guideScrollTo({ top: 900, height: 100 }, { height: 800, scrollY: 0 }, 64),
	).toBe(518);
});
