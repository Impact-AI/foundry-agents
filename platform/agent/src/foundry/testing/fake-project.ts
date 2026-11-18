import {
	type FakeState,
	HttpError,
	isSearchContextSize,
	type MemoryRecord,
	metadataOf,
	mintId,
	ok,
	page,
	type Route,
	type SkillRecord,
	seconds,
	text,
	type UpdateRecord,
	type VersionRecord,
} from "./fake-state";
import {
	checkedVoiceDefinition,
	isVoice,
	requireVoiceOptIn,
} from "./fake-voice";
import { zipOf } from "./zip";

/**
 * The project's own operations: prompt agents, voice agents (preview,
 * `fake-voice.ts`) and their versions, the memory store (preview) and
 * skills (preview), each behind the opt-in header the SDK sends for it.
 */

const MEMORY = "MemoryStores=V1Preview";
const SKILLS = "Skills=V1Preview";
const KINDS = new Set(["user_profile", "chat_summary", "procedural"]);

type Body = Record<string, unknown>;

/** A prompt agent's definition, as strictly as the host's own needs it read. */
function checkedDefinition(state: FakeState, value: unknown): Body {
	const definition = (value ?? {}) as Body;
	if (definition.kind !== "prompt")
		throw new HttpError(400, "definition.kind is prompt");
	text(definition, "model");
	if (typeof definition.instructions !== "string")
		throw new HttpError(400, "definition.instructions is a string");
	const tools = definition.tools ?? [];
	if (!Array.isArray(tools))
		throw new HttpError(400, "definition.tools is a list");
	const names = new Set<string>();
	for (const tool of tools as Body[]) {
		if (tool.type === "function") {
			const name = text(tool, "name");
			if (names.has(name))
				throw new HttpError(400, `the tool ${name} is listed twice`);
			names.add(name);
			if (!tool.parameters || typeof tool.parameters !== "object")
				throw new HttpError(400, `the tool ${name} has parameters`);
		} else if (tool.type === "web_search") {
			if (!isSearchContextSize(tool))
				throw new HttpError(400, "web_search names a context size");
		} else
			throw new HttpError(
				400,
				`a tool of type ${String(tool.type)} is not taken here`,
			);
	}
	const policy = (definition.rai_config as Body | undefined)?.rai_policy_name;
	if (
		policy !== undefined &&
		!/^\/subscriptions\/.+\/raiPolicies\/[^/]+$/.test(String(policy))
	)
		throw new HttpError(400, `The RAI policy '${String(policy)}' is invalid`);
	for (const skill of (definition.skills ?? []) as Body[]) {
		const held = state.skills.get(String(skill.name));
		if (!held?.versions.some((v) => v.version === skill.version))
			throw new HttpError(
				400,
				`no version ${String(skill.version)} of skill ${String(skill.name)}`,
			);
	}
	return definition;
}

/** The scope a body names, refused as the service refuses it. */
function scopeIn(body: Body): string {
	const scope = text(body, "scope");
	if (!/^[A-Za-z0-9_-]{1,256}$/.test(scope))
		throw new HttpError(
			400,
			`scope is invalid: "${scope}" must only contain A-Z, a-z, 0-9, '-', and '_'.`,
		);
	return scope;
}

function memoryOf(state: FakeState, store: string, id: string): MemoryRecord {
	const memory = state.memories.get(id);
	if (!memory || memory.store !== store)
		throw new HttpError(404, `no memory ${id}`);
	return memory;
}

function storeOf(state: FakeState, name: string): Body {
	const store = state.stores.get(name);
	if (!store) throw new HttpError(404, `no memory store ${name}`);
	return store;
}

/** The scope's statements, oldest first, the way a page reads them. */
function scoped(
	state: FakeState,
	store: string,
	scope: string,
	kind: string | null,
): MemoryRecord[] {
	return [...state.memories.values()]
		.filter(
			(m) =>
				m.store === store && m.scope === scope && (!kind || m.kind === kind),
		)
		.sort((a, b) => a.updated_at - b.updated_at);
}

/** What the extractor keeps from what it was handed: new statements made, a repeated one refreshed. */
function extract(
	state: FakeState,
	store: string,
	scope: string,
	messages: string[],
): MemoryRecord[] {
	const written: MemoryRecord[] = [];
	for (const content of state.extractor(messages, scope)) {
		const held = scoped(state, store, scope, "user_profile").find(
			(m) => m.content === content,
		);
		if (held) {
			held.updated_at = seconds();
			written.push(held);
		} else {
			const memory_id = mintId(state, "mem");
			const memory = {
				memory_id,
				scope,
				content,
				kind: "user_profile",
				updated_at: seconds(),
				store,
			};
			state.memories.set(memory_id, memory);
			written.push(memory);
		}
	}
	return written;
}

/** An action on one store about one person: the store must exist, and the body names the scope. */
function scopeAction(
	state: FakeState,
	action: string,
	handle: (store: string, scope: string, body: Body) => Response,
): Route {
	return {
		method: "POST",
		pattern: new RegExp(`^/memory_stores/([^/:]+):${action}$`),
		project: true,
		feature: MEMORY,
		handle({ match, body }) {
			const store = match[1] as string;
			storeOf(state, store);
			return handle(store, scopeIn(body), body);
		},
	};
}

/** A skill version's folder, as the service serves it: `SKILL.md` with its front matter. */
/** A skill as the service reads it back: its name, its default's description and two version numbers. */
function skillObject(skill: SkillRecord): Record<string, unknown> {
	const current = skill.versions.find(
		(v) => v.version === skill.default_version,
	);
	return {
		id: skill.name,
		name: skill.name,
		description: current?.description ?? "",
		created_at: skill.created_at,
		default_version: skill.default_version,
		latest_version: skill.versions.at(-1)?.version,
	};
}

function skillFolder(
	skill: SkillRecord | undefined,
	version: string | undefined,
	name: string,
): Response {
	const held = skill?.versions.find((v) => v.version === version);
	if (!skill || !held) throw new HttpError(404, `no skill ${name}`);
	const metadata = Object.entries(held.metadata).map(
		([k, v]) => `  ${k}: ${v}`,
	);
	const folder = zipOf({
		[`${skill.name}/SKILL.md`]: [
			"---",
			`name: ${skill.name}`,
			`description: ${held.description}`,
			...(metadata.length ? ["metadata:", ...metadata] : []),
			"---",
			"",
			held.instructions,
		].join("\n"),
	});
	return new Response(folder, {
		headers: { "content-type": "application/zip" },
	});
}

export function projectRoutes(state: FakeState): Route[] {
	/** An agent's versions, the opt-in checked when it is a voice agent. */
	const versionsOf = (name: string, headers?: Headers) => {
		const versions = state.agents.get(name) ?? [];
		if (headers && isVoice(versions)) requireVoiceOptIn(headers);
		return versions;
	};
	return [
		{
			method: "GET",
			pattern: /^\/agents\/([^/]+)$/,
			project: true,
			handle({ match, headers }) {
				const versions = versionsOf(match[1] as string, headers);
				if (!versions.length) throw new HttpError(404, `no agent ${match[1]}`);
				return ok({
					object: "agent",
					id: match[1],
					name: match[1],
					versions: { latest: versions.at(-1) },
				});
			},
		},
		{
			method: "POST",
			pattern: /^\/agents\/([^/]+)\/versions$/,
			project: true,
			handle({ match, headers, body }) {
				const name = match[1] as string;
				if (
					"skills" in ((body.definition ?? {}) as Body) &&
					headers.get("foundry-features") !== SKILLS
				)
					throw new HttpError(403, `skill references need ${SKILLS}`);
				const versions = versionsOf(name, headers);
				const given = (body.definition ?? {}) as Body;
				const voice = given.kind === "voice";
				if (voice) requireVoiceOptIn(headers);
				if (versions.length && isVoice(versions) !== voice)
					throw new HttpError(400, `the agent ${name} cannot change its kind`);
				const definition = voice
					? checkedVoiceDefinition(given)
					: checkedDefinition(state, given);
				const number = (state.versionSeq.get(name) ?? 0) + 1;
				state.versionSeq.set(name, number);
				const version: VersionRecord = {
					object: "agent.version",
					id: `${name}:${number}`,
					name,
					version: String(number),
					created_at: seconds(),
					definition,
					metadata: metadataOf(body.metadata),
				};
				state.agents.set(name, [...versions, version]);
				return ok(version);
			},
		},
		{
			method: "GET",
			pattern: /^\/agents\/([^/]+)\/versions$/,
			project: true,
			handle({ match, url, headers }) {
				const versions = versionsOf(match[1] as string, headers);
				if (!versions.length) throw new HttpError(404, `no agent ${match[1]}`);
				return page(
					versions.slice(
						0,
						Math.max(0, versions.length - state.listingLag),
					) as unknown as Body[],
					(v) => String(v.version),
					url,
					"desc",
				);
			},
		},
		{
			method: "GET",
			pattern: /^\/agents\/([^/]+)\/versions\/([^/]+)$/,
			project: true,
			handle({ match, headers }) {
				const [, name, version] = match as unknown as [string, string, string];
				const held = versionsOf(name, headers).find(
					(v) => v.version === version,
				);
				if (!held) throw new HttpError(404, `no version ${version}`);
				return ok(held);
			},
		},
		{
			method: "DELETE",
			pattern: /^\/agents\/([^/]+)\/versions\/([^/]+)$/,
			project: true,
			handle({ match, headers }) {
				const [, name, version] = match as unknown as [string, string, string];
				const versions = versionsOf(name, headers);
				if (!versions.some((v) => v.version === version))
					throw new HttpError(404, `no version ${version}`);
				state.agents.set(
					name,
					versions.filter((v) => v.version !== version),
				);
				return ok({
					object: "agent.version.deleted",
					name,
					version,
					deleted: true,
				});
			},
		},
		{
			method: "POST",
			pattern: /^\/memory_stores$/,
			project: true,
			feature: MEMORY,
			handle({ body }) {
				const name = text(body, "name");
				if (state.stores.has(name))
					throw new HttpError(409, `the memory store ${name} exists`);
				const definition = (body.definition ?? {}) as Body;
				if (definition.kind !== "default")
					throw new HttpError(400, "definition.kind is default");
				text(definition, "chat_model");
				text(definition, "embedding_model");
				const store = {
					object: "memory_store",
					id: mintId(state, "ms"),
					name,
					created_at: seconds(),
					updated_at: seconds(),
					definition,
				};
				state.stores.set(name, store);
				return ok(store);
			},
		},
		{
			method: "GET",
			pattern: /^\/memory_stores\/([^/:]+)$/,
			project: true,
			feature: MEMORY,
			handle({ match }) {
				return ok(storeOf(state, match[1] as string));
			},
		},
		scopeAction(state, "update_memories", (store, scope, body) => {
			const items = body.items;
			if (!Array.isArray(items) || !items.length)
				throw new HttpError(400, "items are required");
			const messages = (items as Body[]).map((item) => {
				if (item.type !== "message" || typeof item.content !== "string")
					throw new HttpError(400, "an item is a message with words");
				return `${String(item.role)}: ${item.content}`;
			});
			state.extractions.push(messages.join("\n"));
			const delay = Number(body.update_delay ?? 300);
			const update_id = mintId(state, "upd");
			// A new hand-over for a scope restarts the wait: the update waiting is superseded, its messages carried on.
			const carried: string[] = [];
			for (const waiting of state.updates.values()) {
				if (
					waiting.status !== "queued" ||
					waiting.store !== store ||
					waiting.scope !== scope
				)
					continue;
				if (waiting.timer) {
					clearTimeout(waiting.timer);
					state.timers.delete(waiting.timer);
				}
				waiting.status = "superseded";
				waiting.superseded_by = update_id;
				carried.push(...waiting.messages);
			}
			const update: UpdateRecord = {
				update_id,
				store,
				scope,
				status: "queued",
				messages: [...carried, ...messages],
				written: [],
			};
			const timer = setTimeout(() => {
				state.timers.delete(timer);
				update.written = extract(state, store, scope, update.messages);
				update.status = "completed";
			}, delay * 1000);
			update.timer = timer;
			state.timers.add(timer);
			state.updates.set(update_id, update);
			return ok({ update_id, status: "queued" }, 202, {
				"operation-location": `/memory_stores/${store}/updates/${update_id}`,
			});
		}),
		{
			method: "GET",
			pattern: /^\/memory_stores\/([^/:]+)\/updates\/([^/]+)$/,
			project: true,
			feature: MEMORY,
			handle({ match }) {
				const update = state.updates.get(match[2] as string);
				if (!update || update.store !== match[1])
					throw new HttpError(404, `no update ${match[2]}`);
				return ok({
					update_id: update.update_id,
					status: update.status,
					...(update.superseded_by
						? { superseded_by: update.superseded_by }
						: {}),
					...(update.status === "completed"
						? {
								result: {
									memory_operations: update.written.map((memory) => ({
										kind: "create",
										memory_item: memory,
									})),
									usage: {
										embedding_tokens: 0,
										input_tokens: 0,
										input_tokens_details: { cached_tokens: 0 },
										output_tokens: 0,
										output_tokens_details: { reasoning_tokens: 0 },
										total_tokens: 0,
									},
								},
							}
						: {}),
				});
			},
		},
		{
			method: "POST",
			pattern: /^\/memory_stores\/([^/:]+)\/items:list$/,
			project: true,
			feature: MEMORY,
			handle({ match, body, url }) {
				const store = match[1] as string;
				storeOf(state, store);
				const kind = url.searchParams.get("kind");
				if (kind && !KINDS.has(kind))
					throw new HttpError(400, `no kind ${kind}`);
				return page(
					scoped(state, store, scopeIn(body), kind) as unknown as Body[],
					(m) => String(m.memory_id),
					url,
					"desc",
				);
			},
		},
		{
			method: "GET",
			pattern: /^\/memory_stores\/([^/:]+)\/items\/([^/]+)$/,
			project: true,
			feature: MEMORY,
			handle({ match }) {
				return ok(memoryOf(state, match[1] as string, match[2] as string));
			},
		},
		{
			method: "POST",
			pattern: /^\/memory_stores\/([^/:]+)\/items\/([^/]+)$/,
			project: true,
			feature: MEMORY,
			handle({ match, body }) {
				const memory = memoryOf(state, match[1] as string, match[2] as string);
				memory.content = text(body, "content");
				memory.updated_at = seconds();
				return ok(memory);
			},
		},
		{
			method: "DELETE",
			pattern: /^\/memory_stores\/([^/:]+)\/items\/([^/]+)$/,
			project: true,
			feature: MEMORY,
			handle({ match }) {
				const memory = memoryOf(state, match[1] as string, match[2] as string);
				state.memories.delete(memory.memory_id);
				return ok({
					object: "memory_store.item.deleted",
					memory_id: memory.memory_id,
					deleted: true,
				});
			},
		},
		scopeAction(state, "delete_scope", (store, scope) => {
			for (const memory of scoped(state, store, scope, null))
				state.memories.delete(memory.memory_id);
			return ok({
				object: "memory_store.scope.deleted",
				name: store,
				scope,
				deleted: true,
			});
		}),
		{
			method: "GET",
			pattern: /^\/skills$/,
			project: true,
			feature: SKILLS,
			handle({ url }) {
				return page(
					[...state.skills.values()].map(skillObject),
					(skill) => String(skill.id),
					url,
					"desc",
				);
			},
		},
		{
			method: "GET",
			pattern: /^\/skills\/([^/]+)$/,
			project: true,
			feature: SKILLS,
			handle({ match }) {
				const skill = state.skills.get(match[1] as string);
				if (!skill) throw new HttpError(404, `no skill ${match[1]}`);
				return ok(skillObject(skill));
			},
		},
		{
			method: "POST",
			pattern: /^\/skills\/([^/]+)$/,
			project: true,
			feature: SKILLS,
			handle({ match, body }) {
				const skill = state.skills.get(match[1] as string);
				if (!skill) throw new HttpError(404, `no skill ${match[1]}`);
				const version = text(body, "default_version");
				if (!skill.versions.some((v) => v.version === version))
					throw new HttpError(404, `no version ${version} of ${skill.name}`);
				skill.default_version = version;
				return ok(skillObject(skill));
			},
		},
		{
			method: "POST",
			pattern: /^\/skills\/([^/]+)\/versions$/,
			project: true,
			feature: SKILLS,
			handle({ match, body }) {
				const name = match[1] as string;
				const inline = (body.inline_content ?? {}) as Body;
				const skill = state.skills.get(name) ?? {
					name,
					created_at: seconds(),
					default_version: "",
					versions: [],
				};
				const version = {
					version: String(skill.versions.length + 1),
					description: text(inline, "description"),
					instructions: text(inline, "instructions"),
					metadata: metadataOf(inline.metadata),
					created_at: seconds(),
				};
				skill.versions.push(version);
				if (body.default === true || !skill.default_version)
					skill.default_version = version.version;
				state.skills.set(name, skill);
				return ok({
					id: `${name}:${version.version}`,
					skill_id: name,
					name,
					version: version.version,
					description: version.description,
					created_at: version.created_at,
				});
			},
		},
		{
			method: "GET",
			pattern: /^\/skills\/([^/]+)\/content$/,
			project: true,
			feature: SKILLS,
			handle({ match }) {
				const skill = state.skills.get(match[1] as string);
				return skillFolder(skill, skill?.default_version, match[1] as string);
			},
		},
		{
			method: "GET",
			pattern: /^\/skills\/([^/]+)\/versions\/([^/]+)\/content$/,
			project: true,
			feature: SKILLS,
			handle({ match }) {
				const skill = state.skills.get(match[1] as string);
				return skillFolder(skill, match[2], match[1] as string);
			},
		},
	];
}
