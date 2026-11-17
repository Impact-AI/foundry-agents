import { expect, test } from "bun:test";
import { headOf } from "./head";

test("a failed channel's head is closed, not a second alert", () => {
	// "Something went wrong" in the head as well as the reason on the line
	// below it would be two alerts where the chat shows one.
	expect(headOf("error")).toEqual({ tone: "idle", status: "idle" });
});

test("a working channel's head says what it is doing", () => {
	expect(headOf("listening")).toEqual({ tone: "live", status: "listening" });
	expect(headOf("speaking")).toEqual({ tone: "busy", status: "speaking" });
	expect(headOf("idle")).toEqual({ tone: "idle", status: "idle" });
});
