// Explains each cache-loss event the metrics index recorded for Pi sessions (requests.cache_event,
// classified by extensions/metrics/attribution.ts `rebuildCause`): what changed between the
// previous answered request and the one that lost the cache.
//
// For both requests it rebuilds the context from the session file (Pi's buildSessionContext) and
// the exact request body Pi sends (the installed models.json, Pi's own provider code, captured with
// onPayload before any network call; the thinking level as recorded). The bodies are flattened in
// the order a prefix cache hashes them (tools, system, then one entry per message block) and the
// first entry the second body does not repeat is reported, with both versions of that entry. It
// also lists the session entries between the two requests (model changes, prompt or tool updates,
// experiment assignments, compactions, aborts) and what the event cost above the read rate.
//
// Usage: node scripts/evidence/cache-loss.ts [metrics.db] [--all]   (--all: every event, also idle expiry)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	getAgentDir,
	migrateSessionEntries,
	ModelRegistry,
	ModelRuntime,
	parseSessionEntries,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { metricsPath } from "../../extensions/metrics/stats.ts";

const MODELS_JSON = join(getAgentDir(), "models.json");

type Body = Record<string, unknown>;

async function registryFor(): Promise<ModelRegistry> {
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: MODELS_JSON, allowModelNetwork: false });
	const configured = Object.keys(JSON.parse(readFileSync(MODELS_JSON, "utf8")).providers ?? {});
	for (const provider of configured) await credentials.modify(provider, async () => ({ type: "api_key", key: "test-key" }));
	return new ModelRegistry(runtime);
}

/** The request body Pi sends for these messages, captured before the network call. */
export async function payload(registry: ModelRegistry, model: Model<Api>, messages: unknown[], reasoning?: string): Promise<Body> {
	let captured: Body | undefined;
	const stream = registry.streamSimple(model, { messages } as never, {
		reasoning: reasoning as never,
		cacheRetention: "long",
		onPayload: (body) => {
			captured = body as Body;
			throw new Error("payload captured");
		},
	});
	let failure = "";
	for await (const event of stream) {
		// Drain until the capture aborts the request.
		if (event.type === "error") failure = event.error.errorMessage ?? "";
	}
	if (!captured) throw new Error(`no payload for ${model.provider}/${model.id}: ${failure}`);
	return captured;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Cache markers move to the newest block each request and are not part of the cached content. */
const withoutCacheMarkers = (value: Json): Json =>
	Array.isArray(value)
		? value.map(withoutCacheMarkers)
		: value === null || typeof value !== "object"
			? value
			: Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, inner]) => [key, withoutCacheMarkers(inner)]));

/** Tools, system, then one entry per message block, as a prefix cache reads them. Messages with no blocks (effort markers) are one entry. */
export function sequence(body: Body): { key: string; label: string }[] {
	const clean = withoutCacheMarkers(body as Json) as Body;
	const out = [
		{ key: JSON.stringify(clean.tools ?? []), label: "tools" },
		{ key: JSON.stringify(clean.system ?? null), label: "system" },
	];
	(clean.messages as { role: string; content: unknown; [k: string]: unknown }[]).forEach((message, index) => {
		const { content, role, ...rest } = message;
		const extra = Object.keys(rest).length ? JSON.stringify(rest) : "";
		if (typeof content === "string") out.push({ key: JSON.stringify([role, content, extra]), label: `msg ${index} ${role} text` });
		else if (Array.isArray(content) && content.length === 0) out.push({ key: JSON.stringify([role, extra]), label: `msg ${index} ${role} ${extra}` });
		else (content as { type: string }[]).forEach((block, b) => out.push({ key: JSON.stringify([role, block, extra]), label: `msg ${index} ${role} block ${b} ${block.type}` }));
	});
	return out;
}

const describe = (entry: SessionEntry): string => {
	if (entry.type === "message") {
		const m = entry.message as { role: string; customType?: string; stopReason?: string; toolName?: string; sections?: Record<string, string | null>; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
		if (m.role === "system")
			return `system update: sections ${Object.keys(m.sections ?? {}).join(", ") || "-"}; tools +${(m.toolsAdded ?? []).map((t) => t.name).join(",") || "-"} −${(m.toolsRemoved ?? []).map((t) => t.name).join(",") || "-"}`;
		if (m.role === "assistant") return `assistant (${m.stopReason})`;
		if (m.role === "toolResult") return `tool result ${m.toolName}`;
		return m.role + (m.customType ? ` ${m.customType}` : "");
	}
	if (entry.type === "custom") return `custom ${(entry as { customType?: string }).customType} ${JSON.stringify((entry as { data?: unknown }).data).slice(0, 80)}`;
	if (entry.type === "model_change") return `model_change ${(entry as { modelId?: string }).modelId}`;
	return entry.type;
};

if (import.meta.main) {
	const args = process.argv.slice(2);
	const dbPath = args.find((a) => !a.startsWith("--")) ?? metricsPath();
	const all = args.includes("--all");
	if (!existsSync(MODELS_JSON)) throw new Error(`no ${MODELS_JSON}`);
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const events = db
		.prepare(
			`SELECT r.session_id, r.entry_id, r.ts, r.cache_event, r.cache_read, r.cache_write, r.cache_lost, r.cache_waste, r.cost_write, s.file
			FROM requests r JOIN sessions s ON s.id = r.session_id
			WHERE s.source = 'pi' AND r.cache_event IS NOT NULL AND ($all = 1 OR r.cache_event NOT LIKE 'cache expired%') ORDER BY r.ts`,
		)
		.all({ $all: all ? 1 : 0 }) as { session_id: string; entry_id: string; ts: number; cache_event: string; cache_read: number; cache_write: number; cache_lost: number; cache_waste: number; cost_write: number; file: string }[];
	const registry = await registryFor();
	for (const event of events) {
		const fileEntries = parseSessionEntries(readFileSync(event.file, "utf8"));
		migrateSessionEntries(fileEntries);
		const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
		const byId = new Map(entries.map((e) => [e.id, e]));
		const current = byId.get(event.entry_id)!;
		// The previous answered request on this branch, and what lies between.
		const between: SessionEntry[] = [];
		let cursor = current.parentId ? byId.get(current.parentId) : undefined;
		while (cursor) {
			const m = cursor.type === "message" ? (cursor.message as { role: string; usage?: { cacheRead: number; cacheWrite: number; input: number } }) : undefined;
			if (m?.role === "assistant" && m.usage && m.usage.input + m.usage.cacheRead + m.usage.cacheWrite > 0) break;
			between.unshift(cursor);
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
		console.log(`\n### ${event.session_id.slice(0, 13)} ${event.entry_id} — ${event.cache_event}`);
		console.log(`read ${event.cache_read}, wrote ${event.cache_write}, lost ${event.cache_lost}, waste $${event.cache_waste.toFixed(2)}, write cost $${event.cost_write.toFixed(2)}`);
		console.log(`between: ${between.map(describe).join(" | ")}`);
		if (!cursor) continue;
		const message = (e: SessionEntry) => e.type === "message" ? (e.message as { model: string; provider: string; thinkingLevel?: string }) : undefined;
		const prev = message(cursor)!;
		const curr = message(current)!;
		const model = registry.find(curr.provider, curr.model);
		if (!model) {
			console.log(`model ${curr.provider}/${curr.model} not in models.json`);
			continue;
		}
		// Request n+1 as Pi built it: context up to the event's parent; request n likewise.
		let before: ReturnType<typeof sequence>;
		let after: ReturnType<typeof sequence>;
		try {
			before = sequence(await payload(registry, model, buildSessionContext(entries, cursor.parentId, byId).messages, prev.thinkingLevel));
			after = sequence(await payload(registry, model, buildSessionContext(entries, current.parentId, byId).messages, curr.thinkingLevel));
		} catch (error) {
			console.log(`payload: ${(error as Error).message}`);
			continue;
		}
		const index = before.findIndex((entry, i) => after[i]?.key !== entry.key);
		if (index < 0) {
			console.log(`payload: request n is an unchanged prefix of request n+1 (${before.length} → ${after.length} entries)`);
			continue;
		}
		console.log(`payload: diverges at entry ${index} of ${before.length} (${before[index]!.label} → ${after[index]?.label ?? "missing"})`);
		const show = (s?: string) => (s ?? "").slice(0, 300);
		console.log(`  before: ${show(before[index]!.key)}`);
		console.log(`  after:  ${show(after[index]?.key)}`);
	}
}
