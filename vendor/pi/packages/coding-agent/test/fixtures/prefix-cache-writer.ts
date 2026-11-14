// Touches shared prefix cache records from a separate process: argv = registry dir, writer index, rounds, keys.
import { PrefixCacheRegistry } from "../../src/core/prefix-cache.ts";

const [dir, writer, rounds, keys] = process.argv.slice(2);
const registry = new PrefixCacheRegistry(dir!);
const model = { provider: "p", id: "m" };
let last = 0;
for (let round = 0; round < Number(rounds); round++) {
	for (let key = 0; key < Number(keys); key++) {
		last = Date.now();
		registry.touch(
			model,
			"hash",
			{ key: `k${key}`, entryId: `e${key}`, end: 1 },
			{
				tokens: 100 + key,
				cache: Number(writer) % 2 === 0 ? "write" : "read",
				at: last,
				ttlMs: 60_000,
			},
		);
	}
}
process.stdout.write(String(last));
