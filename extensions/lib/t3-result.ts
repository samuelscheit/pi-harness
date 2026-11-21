// Reading t3's MCP tool results from a session: shared by the goal (delegated tasks it may wait on)
// and the thread-wait guard (a wait that timed out).

/** t3's MCP tools, as its bridge registers them (also under a hidden canonical name). */
export const T3_TOOL = /^mcp__t3[-_]code__/;

/** The text of a message's content. */
export const contentText = (content: string | readonly { type: string; text?: string }[]) => (typeof content === "string" ? content : content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""));

/** The JSON object a text holds, if it is one. */
export const parseObject = (text: string): Record<string, unknown> | undefined => {
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
};

/** A non-empty string, else undefined. */
export const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** A duration for a message to the agent: seconds below a minute, else minutes. */
export const ago = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};
