// A model runtime whose responses cost a fixed amount each: the faux provider reports no cost, so
// tests of budgets and cost reporting price its responses here (llm()'s completeSimple and the
// sessions' streamSimple).

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export function priced(base: ModelRuntime, usd: number): ModelRuntime {
	const price = (message: AssistantMessage) => {
		message.usage.cost.total = usd;
		return message;
	};
	return new Proxy(base, {
		get(target, key) {
			if (key === "completeSimple") {
				return async (...args: Parameters<ModelRuntime["completeSimple"]>) => {
					const message = await target.completeSimple(...args);
					return { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: usd } } };
				};
			}
			if (key === "streamSimple") {
				return (...args: Parameters<ModelRuntime["streamSimple"]>) => {
					const stream = target.streamSimple(...args);
					const events = stream[Symbol.asyncIterator].bind(stream);
					stream[Symbol.asyncIterator] = async function* () {
						for await (const event of { [Symbol.asyncIterator]: events }) {
							if (event.type === "done") price(event.message);
							if (event.type === "error") price(event.error);
							yield event;
						}
					};
					const result = stream.result.bind(stream);
					stream.result = async () => price(await result());
					return stream;
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
