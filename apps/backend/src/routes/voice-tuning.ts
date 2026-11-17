import type { VoiceTuning } from "@platform/agent";
import { agentSettings } from "@platform/agent";
import {
	checkVoiceTuning,
	type EffectiveVoice,
	effectiveVoice,
	realtimeDeployments,
	type TuningChoices,
	type TuningContext,
	tuningChoices,
} from "@platform/agent/foundry";
import {
	type Account,
	isVoiceTester,
	setVoiceTuning,
	type Tier,
} from "@platform/identity";
import { liveVoiceAudio } from "@platform/voice";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth/context";
import { accessOf, refuseAccountGone } from "../auth/standing";
import { problems } from "../problems";
import { NO_STORE, readObject, refuse } from "./reply";

/**
 * Settings → Voice tuning: a voice tester's override of how their own live
 * sessions run, kept on their account and never written to the `agent` or
 * `voice` document. Who is a tester is the app role `tester` on the
 * account's row, read at the point of use — the route's gate and the
 * session's open both re-read it — so a role taken away stops the tuning at
 * the next session, saved or not. Every value is checked against the lists
 * the documents are checked against and against what this deployment has
 * (`checkVoiceTuning`); one that does not hold is refused under
 * `invalid_body` with the field, never stored. A managed model is offered
 * with where the service processes it, so a tester sees that choosing one
 * can take their speech outside this deployment's region.
 *
 * `GET` answers what the panel draws: the saved tuning, the values each
 * control offers, and `effective` — the value every control runs with, from
 * the function the session's open uses — so the panel never says "default"
 * where the session runs with a value.
 */

/** Every control's value, the realtime deployment named by its model and a managed model by its name. */
type Resolved = Omit<EffectiveVoice, "realtime" | "managed"> & {
	realtimeModel: string | null;
	managedModel: string | null;
};

/** What the panel draws. */
interface VoiceTuningView {
	tuning: VoiceTuning;
	choices: TuningChoices;
	/** What this tester's sessions run with. */
	effective: Resolved;
	/** What they would run with untuned: the documents' values, which the panel marks. */
	baseline: Resolved;
}

function resolved({ realtime, managed, ...rest }: EffectiveVoice): Resolved {
	return {
		...rest,
		realtimeModel: realtime?.model || null,
		managedModel: managed?.name ?? null,
	};
}

async function context(): Promise<TuningContext> {
	const { voices, openaiVoices } = await liveVoiceAudio();
	return { realtime: realtimeDeployments(), voices, openaiVoices };
}

/**
 * The tuning a session of this account opens with: the saved one, for a
 * tester, checked again now; none for anybody else. One that no longer holds
 * — the deployment lost a realtime model, the operator moved the engine — is
 * reported and left out, so the session runs on the documents.
 */
export async function sessionTuningOf(
	account: Account | null,
	tier: Tier,
): Promise<VoiceTuning | null> {
	if (!account?.voiceTuning || !isVoiceTester(account.roles)) return null;
	const checked = checkVoiceTuning(
		account.voiceTuning,
		await agentSettings(),
		await context(),
		tier,
	);
	if (checked.ok) return checked.tuning;
	problems.report("backend.voice_tuning.stale", { reason: checked.field });
	console.warn(
		`[voice] a saved voice tuning no longer holds (${checked.field}); the session runs on the documents`,
	);
	return null;
}

async function view(tuning: VoiceTuning, tier: Tier): Promise<VoiceTuningView> {
	const [ctx, settings] = await Promise.all([context(), agentSettings()]);
	const effective = effectiveVoice(settings, ctx, tier, tuning);
	return {
		tuning,
		choices: tuningChoices(ctx, effective),
		effective: resolved(effective),
		baseline: resolved(effectiveVoice(settings, ctx, tier, null)),
	};
}

/** Behind `requireStanding`: the routes answer a tester and nobody else. */
export function voiceTuningRoutes(): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	const tester = (c: Context<AppEnv>): Account | null => {
		const account = c.get("account") ?? null;
		return account && isVoiceTester(account.roles) ? account : null;
	};
	const forbidden = (c: Context<AppEnv>) => {
		problems.report("backend.voice_tuning.refused", { status: 403 });
		return refuse(c, 403, "forbidden");
	};

	routes.get("/", async (c) => {
		const account = tester(c);
		if (!account) return forbidden(c);
		const { tier } = accessOf(c);
		const saved = checkVoiceTuning(
			account.voiceTuning ?? {},
			await agentSettings(),
			await context(),
			tier,
		);
		return c.json(
			await view(saved.ok ? saved.tuning : {}, tier),
			200,
			NO_STORE,
		);
	});

	routes.put("/", async (c) => {
		const account = tester(c);
		if (!account) return forbidden(c);
		const { tier } = accessOf(c);
		const checked = checkVoiceTuning(
			await readObject(c),
			await agentSettings(),
			await context(),
			tier,
		);
		if (!checked.ok) {
			problems.report("backend.voice_tuning.refused", {
				status: 400,
				reason: checked.field,
			});
			return refuse(c, 400, "invalid_body", { field: checked.field });
		}
		const empty = Object.keys(checked.tuning).length === 0;
		// Lands only on the account the gate admitted this request on.
		if (
			!(await setVoiceTuning(
				account.id,
				empty ? null : { ...checked.tuning },
				account,
			))
		)
			return refuseAccountGone(c);
		return c.json(await view(checked.tuning, tier), 200, NO_STORE);
	});

	return routes;
}
