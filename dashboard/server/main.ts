// node dashboard/server/main.ts [--port <n>] [--detach]   (`npm run dashboard`)
// Builds the frontend when its sources changed, then serves the dashboard in the foreground, or
// with --detach starts it in the background (unless one runs) and prints its URL.

import { build, launch } from "./launch.ts";
import { DEFAULT_PORT, lanUrls, startDashboard } from "./server.ts";

const at = process.argv.indexOf("--port");
const port = at > 0 ? Number(process.argv[at + 1]) : DEFAULT_PORT;
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`--port: not a port: ${process.argv[at + 1]}`);
if (process.argv.includes("--detach")) {
	const { url, started } = await launch({ port });
	process.stdout.write(`${started ? "Started" : "Already running"}: ${[url, ...lanUrls(port)].join("  ")}\n`);
} else {
	await build((line) => process.stdout.write(`${line}\n`));
	const dashboard = await startDashboard({ port });
	process.stdout.write(`Pi harness usage dashboard: ${[dashboard.url, ...dashboard.lan].join("  ")}\n`);
}
