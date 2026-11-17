import type { QueryDrafter } from "../models/contract";

export function scriptedDrafter(
	answer: (request: { system: string; prompt: string }) => unknown,
): QueryDrafter & { requests: { system: string; prompt: string }[] } {
	const requests: { system: string; prompt: string }[] = [];
	return {
		requests,
		async draft(request) {
			requests.push({ system: request.system, prompt: request.prompt });
			return answer(request) as never;
		},
	};
}
