/** For tests: Foundry Agent Service stood in for at its HTTP boundary, both SDKs above it real; and the memory's extractor stood in for at the same fetch. */
export {
	FAKE_FOUNDRY_ENDPOINT,
	FAKE_RAI_POLICY,
	type FakeFoundry,
	type FoundryAnswer,
	fakeFoundry,
	type SeenTurn,
} from "../foundry/testing/fake-foundry";
/** A turn's scope, entered by hand: what a tool reads through `currentTurn` when a test runs it outside a turn. */
export { runInTurnScope, UNSCOPED_TURN } from "../turn/scope";
export { type StandInExtractor, standInExtractor } from "./stand-in-extractor";
