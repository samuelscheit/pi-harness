/**
 * #4743: the retained-injection ledger's own contract, through its public
 * seam and the real degradation ledger. The host-level witness (what the
 * provider receives) is `tests/clients/context-injection-tail-stability.test.ts`;
 * these cells pin the states a scripted session cannot reach cheaply: the
 * bounds, the declines and their once-per-session records, a prefix changed in
 * place before an anchor, partitions, and an unhashable transcript.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	createInjectionLedger,
	type LedgerMessage,
	type LedgerRecord,
	type LedgerStore,
	MAX_RETAINED_BYTES,
	MAX_RETAINED_ENTRIES,
	MAX_RETAINED_SESSIONS,
	replayRecords,
} from "../../clients/context-injection-ledger.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

/** The placement rule index.ts passes in: append text to a user prompt. */
const append = (content: string | unknown[], text: string) =>
	typeof content === "string"
		? `${content}\n\n${text}`
		: [...content, { type: "text", text }];

const system: LedgerMessage = { role: "system", content: "head" };
const user = (text: string): LedgerMessage => ({ role: "user", content: text });
const assistant = (text: string): LedgerMessage => ({
	role: "assistant",
	content: text,
});

function declines(): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary().find(
			(group) => group.kind === "context-injection-retain-declined",
		)?.latestReasons ?? []
	);
}

function declineCount(): number {
	return (
		getDegradationSummary().find(
			(group) => group.kind === "context-injection-retain-declined",
		)?.count ?? 0
	);
}

beforeEach(() => {
	resetDegradationLedger();
});

describe("context-injection ledger (#4743)", () => {
	it("hands pi's own list back when nothing is retained", () => {
		const ledger = createInjectionLedger();
		const raw = [system, user("question")];
		// Identity, not equality: index.ts returns `undefined` (pi keeps its
		// list) only when the rebuild is pi's own array.
		expect(ledger.rebuild("s1", raw, append).messages).toBe(raw);
	});

	it("re-sends a user-text entry on the prompt it extended, and an after entry after its anchor", () => {
		const ledger = createInjectionLedger();
		const first = [system, user("question")];
		expect(
			ledger.rebuild("s1", first, append).retain({
				kind: "user-text",
				text: "FINDING-A",
			}),
		).toBeUndefined();
		const second = [...first, assistant("calls a tool"), user("tool output")];
		const rebuilt = ledger.rebuild("s1", second, append);
		expect(rebuilt.messages[1]).toEqual(user("question\n\nFINDING-A"));
		expect(rebuilt.retainedPositions).toEqual([1]);
		expect(
			rebuilt.retain({ kind: "after", messages: [user("FINDING-B")] }),
		).toBeUndefined();

		const third = [...second, assistant("answer")];
		const again = ledger.rebuild("s1", third, append);
		expect(again.messages.map((message) => message.content)).toEqual([
			"head",
			"question\n\nFINDING-A",
			"calls a tool",
			"tool output",
			"FINDING-B",
			"answer",
		]);
		expect(again.retainedPositions).toEqual([1, 4]);
		expect(again.reemitted).toBe(2);
	});

	it("never mutates pi's transcript", () => {
		const ledger = createInjectionLedger();
		const first = Object.freeze([
			Object.freeze(system),
			Object.freeze(user("question")),
		]);
		ledger
			.rebuild("s1", first, append)
			.retain({ kind: "user-text", text: "FINDING" });
		const rebuilt = ledger.rebuild("s1", first, append);
		expect(rebuilt.messages[1]?.content).toBe("question\n\nFINDING");
		expect(first[1]?.content).toBe("question");
	});

	it("drops an entry for good once the transcript before its anchor changes, even when the anchor message itself is unchanged", () => {
		const ledger = createInjectionLedger();
		const raw = [
			system,
			user("old"),
			assistant("old answer"),
			user("question"),
		];
		ledger
			.rebuild("s1", raw, append)
			.retain({ kind: "user-text", text: "FINDING" });
		// A one-for-one compaction: index 1 becomes the summary, the anchor keeps
		// its index and its own bytes. An anchor-only check would re-send here.
		const compacted = [system, user("summary"), raw[2], raw[3]];
		const rebuilt = ledger.rebuild("s1", compacted, append);
		expect(rebuilt.messages).toBe(compacted);
		expect(rebuilt.pruned).toBe(1);
		expect(ledger.size("s1")).toBe(0);
		// Deleted, not hidden: the original transcript no longer brings it back.
		expect(ledger.rebuild("s1", raw, append).messages).toBe(raw);
	});

	it("keeps sessions apart: one session's entry never lands in another's identical transcript", () => {
		const ledger = createInjectionLedger();
		const raw = [system, user("question")];
		ledger
			.rebuild("primary", raw, append)
			.retain({ kind: "user-text", text: "PRIMARY-ONLY" });
		expect(ledger.rebuild("secondary", raw, append).messages).toBe(raw);
		expect(ledger.size("primary")).toBe(1);
	});

	it("declines past the entry cap, delivers once, and records one row per session", () => {
		const ledger = createInjectionLedger();
		let raw: LedgerMessage[] = [system];
		for (let index = 0; index < MAX_RETAINED_ENTRIES; index++) {
			raw = [...raw, user(`q${index}`)];
			expect(
				ledger
					.rebuild("s1", raw, append)
					.retain({ kind: "after", messages: [user(`f${index}`)] }),
			).toBeUndefined();
		}
		for (const extra of ["x", "y"]) {
			raw = [...raw, user(extra)];
			expect(
				ledger
					.rebuild("s1", raw, append)
					.retain({ kind: "after", messages: [user(extra)] }),
			).toBe("entry-cap");
		}
		expect(ledger.size("s1")).toBe(MAX_RETAINED_ENTRIES);
		expect(declineCount()).toBe(1);
		expect(declines()[0]?.subject).toBe("entry-cap:s1");
	});

	it("declines an injection that would pass the byte cap", () => {
		const ledger = createInjectionLedger();
		const raw = [system, user("question")];
		const rebuilt = ledger.rebuild("s1", raw, append);
		expect(
			rebuilt.retain({
				kind: "user-text",
				text: "x".repeat(MAX_RETAINED_BYTES + 1),
			}),
		).toBe("byte-cap");
		expect(ledger.size("s1")).toBe(0);
		expect(declines()[0]?.subject).toBe("byte-cap:s1");
	});

	it("retains nothing without a session id", () => {
		const ledger = createInjectionLedger();
		const raw = [system, user("question")];
		const rebuilt = ledger.rebuild(undefined, raw, append);
		expect(rebuilt.messages).toBe(raw);
		expect(rebuilt.retain({ kind: "user-text", text: "FINDING" })).toBe(
			"no-session-id",
		);
		expect(declines()[0]?.subject).toBe("no-session-id:<no-session>");
	});

	it("re-sends nothing and clears the session when the transcript cannot be hashed", () => {
		const ledger = createInjectionLedger();
		const raw = [system, user("question")];
		ledger
			.rebuild("s1", raw, append)
			.retain({ kind: "user-text", text: "FINDING" });
		const cyclic: Record<string, unknown> = { role: "user" };
		cyclic.content = cyclic;
		const rebuilt = ledger.rebuild(
			"s1",
			[...raw, cyclic as LedgerMessage],
			append,
		);
		expect(rebuilt.reemitted).toBe(0);
		expect(rebuilt.declined).toBe("transcript-not-hashable");
		expect(ledger.size("s1")).toBe(0);
		expect(declines()[0]?.subject).toBe("transcript-not-hashable:s1");
	});

	it("holds at most MAX_RETAINED_SESSIONS sessions, evicting the least recently used", () => {
		const ledger = createInjectionLedger();
		const raw = [system, user("question")];
		for (let index = 0; index <= MAX_RETAINED_SESSIONS; index++)
			ledger
				.rebuild(`s${index}`, raw, append)
				.retain({ kind: "user-text", text: "FINDING" });
		expect(ledger.size("s0")).toBe(0);
		expect(ledger.size(`s${MAX_RETAINED_SESSIONS}`)).toBe(1);
	});

	it("clearSession forgets one session only", () => {
		const ledger = createInjectionLedger();
		const raw = [system, user("question")];
		for (const id of ["a", "b"])
			ledger.rebuild(id, raw, append).retain({ kind: "user-text", text: id });
		ledger.clearSession("a");
		expect(ledger.size("a")).toBe(0);
		expect(ledger.size("b")).toBe(1);
	});

	it("holds() sees text a valid entry carries and nothing a pruned or foreign entry carried (#5240)", () => {
		// RECURRENCE GUARDED: #5240. A per-prompt repeat of an already retained
		// blocker was retained as a new entry each prompt, until the 64-entry cap.
		const ledger = createInjectionLedger();
		const first = [system, user("question")];
		const rebuild = ledger.rebuild("s1", first, append);
		expect(rebuild.holds("BLOCKER-TEXT")).toBe(false);
		rebuild.retain({
			kind: "user-text",
			text: "head\n\nBLOCKER-TEXT\nmore lines",
		});
		const second = [...first, assistant("answer"), user("next prompt")];
		const next = ledger.rebuild("s1", second, append);
		expect(next.holds("BLOCKER-TEXT\nmore lines")).toBe(true);
		expect(next.holds("OTHER-TEXT")).toBe(false);
		expect(ledger.rebuild("other", second, append).holds("BLOCKER-TEXT")).toBe(
			false,
		);
		next.retain({
			kind: "after",
			messages: [user("AFTER-BLOCKER")],
		});
		expect(
			ledger
				.rebuild("s1", [...second, assistant("a2")], append)
				.holds("AFTER-BLOCKER"),
		).toBe(true);
		// A compaction rewrites the prefix: the entry is pruned, so it holds nothing.
		const compacted = ledger.rebuild(
			"s1",
			[system, user("summary of the conversation")],
			append,
		);
		expect(compacted.holds("BLOCKER-TEXT")).toBe(false);
		expect(compacted.holds("AFTER-BLOCKER")).toBe(false);
	});
});

describe("context-injection ledger persistence (pi-harness)", () => {
	/** A session's records, as the session file keeps them. */
	function memoryStore(records: LedgerRecord[] = []): LedgerStore & {
		records: LedgerRecord[];
		loads: number;
	} {
		const store = {
			records,
			loads: 0,
			load: () => {
				store.loads += 1;
				return [...store.records];
			},
			save: (record: LedgerRecord) => {
				store.records.push(record);
			},
		};
		return store;
	}

	it("a new ledger (reload, restarted pi) re-sends exactly what the old one did", () => {
		const store = memoryStore();
		const first = [system, user("question")];
		const before = createInjectionLedger();
		before.rebuild("s1", first, append, store).retain({ kind: "user-text", text: "FINDING-A" });
		const second = [...first, assistant("calls a tool"), user("tool output")];
		before.rebuild("s1", second, append, store).retain({ kind: "after", messages: [user("FINDING-B")] });
		const third = [...second, assistant("answer")];
		const expected = before.rebuild("s1", third, append, store).messages;
		expect(store.records.map((record) => record.op)).toEqual(["retain", "retain"]);

		expect(store.loads).toBe(1);
		const after = createInjectionLedger();
		const restored = after.rebuild("s1", third, append, store);
		expect(restored.messages).toEqual(expected);
		expect(restored.reemitted).toBe(2);
		after.rebuild("s1", third, append, store);
		expect(store.loads).toBe(2);
		// The records survive a JSON round trip, as session entries do.
		const json = memoryStore(JSON.parse(JSON.stringify(store.records)));
		expect(createInjectionLedger().rebuild("s1", third, append, json).messages).toEqual(expected);
	});

	it("restored entries are checked like any other: a changed transcript prunes them and records a clear", () => {
		const store = memoryStore();
		const raw = [system, user("old"), assistant("old answer"), user("question")];
		createInjectionLedger().rebuild("s1", raw, append, store).retain({ kind: "user-text", text: "FINDING" });
		const compacted = [system, user("summary"), raw[2]!, raw[3]!];
		const rebuilt = createInjectionLedger().rebuild("s1", compacted, append, store);
		expect(rebuilt.messages).toBe(compacted);
		expect(rebuilt.pruned).toBe(1);
		expect(store.records.at(-1)).toEqual({ op: "clear" });
		expect(createInjectionLedger().rebuild("s1", raw, append, store).messages).toBe(raw);
	});

	it("clearSession records a clear only when something was held or stored", () => {
		const store = memoryStore();
		const ledger = createInjectionLedger();
		ledger.clearSession("s1", store);
		expect(store.records).toEqual([]);
		const raw = [system, user("question")];
		ledger.rebuild("s1", raw, append, store).retain({ kind: "user-text", text: "FINDING" });
		ledger.clearSession("s1", store);
		ledger.clearSession("s1", store);
		expect(store.records.map((record) => record.op)).toEqual(["retain", "clear"]);
		expect(createInjectionLedger().rebuild("s1", raw, append, store).messages).toBe(raw);

		// A fresh ledger switched off clears what the store still holds, once.
		const held = memoryStore([{ op: "retain", entry: { kind: "user-text", anchor: 1, prefixDigest: "x", text: "T", bytes: 1 } }]);
		const off = createInjectionLedger();
		off.clearSession("s1", held);
		off.clearSession("s1", held);
		expect(held.records.map((record) => record.op)).toEqual(["retain", "clear"]);
	});

	it("replayRecords keeps the entries after the last clear, in order", () => {
		const entry = (text: string) => ({ op: "retain" as const, entry: { kind: "user-text" as const, anchor: 0, prefixDigest: "d", text, bytes: 1 } });
		const texts = (records: LedgerRecord[]) => replayRecords(records).map((e) => (e.kind === "user-text" ? e.text : ""));
		expect(texts([entry("a"), { op: "clear" }, entry("b"), entry("c")])).toEqual(["b", "c"]);
		expect(texts([entry("a"), { op: "clear" }])).toEqual([]);
		expect(texts([])).toEqual([]);
	});

	it("restores at most MAX_RETAINED_ENTRIES, the newest", () => {
		const raw = [system, user("question")];
		const store = memoryStore();
		const ledger = createInjectionLedger();
		for (let i = 0; i < MAX_RETAINED_ENTRIES; i++)
			ledger.rebuild("s1", raw, append, store).retain({ kind: "user-text", text: `F${i}` });
		store.records.unshift({ op: "retain", entry: { kind: "user-text", anchor: 1, prefixDigest: "stale", text: "OLD", bytes: 3 } });
		const restored = createInjectionLedger();
		restored.rebuild("s1", raw, append, store);
		expect(restored.size("s1")).toBe(MAX_RETAINED_ENTRIES);
	});
});
