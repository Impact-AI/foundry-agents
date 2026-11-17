import { afterEach, expect, spyOn, test } from "bun:test";
import { resetAppConfigClient, setAppConfigClient } from "@platform/config";
import { resetAccessSettings } from "../config/access";
import { stagedAccessSettings } from "../testing/fake-config";
import {
	accessClauseFor,
	accessFilter,
	readableSettings,
	readerAdmits,
	servedFilter,
} from "./access";

let restore = () => {};

afterEach(() => {
	restore();
	restore = () => {};
	resetAccessSettings();
});

const GLOBAL = { globalDocumentAccess: true };

test("the clause admits the caller by oid or by any of their groups, `all` included", () => {
	expect(accessFilter({ oid: "p-1", groups: ["g-1", "g-2"] }, GLOBAL)).toBe(
		"(oids/any(t: t eq 'p-1') or groups/any(t: search.in(t, 'g-1|g-2|all', '|')))",
	);
});

test("every literal is quoted by the one OData helper: a quote in a group id is doubled, never a boundary", () => {
	expect(accessFilter({ oid: "o'brien", groups: ["g'1"] }, GLOBAL)).toBe(
		"(oids/any(t: t eq 'o''brien') or groups/any(t: search.in(t, 'g''1|all', '|')))",
	);
});

test("`all` is in the list only while global access is on; an empty id and a repeat are dropped; no groups is the oid alone", () => {
	expect(
		accessFilter(
			{ oid: "p-1", groups: ["g-1", "", "g-1"] },
			{ globalDocumentAccess: false },
		),
	).toBe(
		"(oids/any(t: t eq 'p-1') or groups/any(t: search.in(t, 'g-1', '|')))",
	);
	expect(
		accessFilter({ oid: "p-1", groups: [] }, { globalDocumentAccess: false }),
	).toBe("(oids/any(t: t eq 'p-1'))");
});

test("with enforcement off there is no clause, whoever is asking", async () => {
	expect(await accessClauseFor({ oid: "p-1", groups: ["g-1"] })).toEqual({
		kind: "open",
	});
	expect(await accessClauseFor(null)).toEqual({ kind: "open" });
});

test("with enforcement on the clause is the caller's, and nobody is refused rather than widened", async () => {
	restore = stagedAccessSettings({ enforceAccessControl: true });
	expect(await accessClauseFor({ oid: "p-1", groups: ["g-1"] })).toEqual({
		kind: "filter",
		filter:
			"(oids/any(t: t eq 'p-1') or groups/any(t: search.in(t, 'g-1|all', '|')))",
	});
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await accessClauseFor(null)).toEqual({
			kind: "refused",
			code: "unidentified_caller",
		});
		expect(await accessClauseFor({ oid: "", groups: ["g-1"] })).toEqual({
			kind: "refused",
			code: "unidentified_caller",
		});
		expect(error).toHaveBeenCalledTimes(2);
	} finally {
		error.mockRestore();
	}
});

test("a row in hand is admitted by the same rule as the clause: off, everybody; on, the oid, a group, or `all` while global access is on", () => {
	const on = { enforceAccessControl: true, globalDocumentAccess: true };
	const strict = { enforceAccessControl: true, globalDocumentAccess: false };
	const off = { enforceAccessControl: false, globalDocumentAccess: false };
	const staff = { oids: [], groups: ["g-1"] };
	const everyone = { oids: [], groups: ["all"] };
	const mine = { oids: ["p-1"], groups: [] };
	expect(readerAdmits(staff, null, off)).toBe(true);
	expect(readerAdmits(staff, null, on)).toBe(false);
	expect(readerAdmits(staff, { oid: "p-1", groups: ["g-1"] }, on)).toBe(true);
	expect(readerAdmits(staff, { oid: "p-1", groups: ["g-9"] }, on)).toBe(false);
	expect(readerAdmits(mine, { oid: "p-1", groups: [] }, strict)).toBe(true);
	expect(readerAdmits(everyone, { oid: "p-2", groups: [] }, on)).toBe(true);
	expect(readerAdmits(everyone, { oid: "p-2", groups: [] }, strict)).toBe(
		false,
	);
});

test("a model is handed only what Prompt Shields read and found clean, whoever asks and whatever enforcement says", () => {
	expect(servedFilter({ kind: "open" })).toBe(
		"injection eq false and documentId ne null",
	);
	expect(
		servedFilter({ kind: "filter", filter: "(oids/any(t: t eq 'p-1'))" }),
	).toBe(
		"injection eq false and documentId ne null and (oids/any(t: t eq 'p-1'))",
	);
});

test("a store that has never answered refuses every caller, since whether enforcement is on is not known", async () => {
	setAppConfigClient({
		getConfigurationSetting: async () => {
			throw new Error("the store is unreachable");
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	restore = resetAppConfigClient;
	resetAccessSettings();
	const said = spyOn(console, "error").mockImplementation(() => {});
	const warned = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(await accessClauseFor({ oid: "p-1", groups: ["g-1"] })).toEqual({
			kind: "refused",
			code: "access_unreadable",
		});
		expect(await accessClauseFor(null)).toEqual({
			kind: "refused",
			code: "access_unreadable",
		});
		expect(await readableSettings()).toBeNull();
	} finally {
		said.mockRestore();
		warned.mockRestore();
	}
});
