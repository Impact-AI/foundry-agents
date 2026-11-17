import { expect, test } from "bun:test";
import { TITLE_MAX as hostBound } from "../../../../platform/agent/src/title/title-from";
import { TITLE_LENGTH } from "./title";

test("the rename field and route hold a title to the bound the agent's host keeps", async () => {
	expect(TITLE_LENGTH).toBe(hostBound);
	// One number: neither the field nor the route writes a bound of its own.
	for (const file of [
		"../../app/(app)/chat/ConversationPicker.tsx",
		"../../app/api/conversations/[id]/route.ts",
	]) {
		const source = await Bun.file(`${import.meta.dir}/${file}`).text();
		expect(source).toContain('from "@/src/chat/title"');
		expect(source).not.toMatch(/const TITLE_MAX\s*=/);
	}
});
