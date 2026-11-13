// The `tool` command inside the agent's bash calls (see bridge.ts): sends its arguments to the
// bash call's socket and prints the answer. Plain JavaScript, so Node starts it without type stripping.

import { connect } from "node:net";

const socketPath = process.env.PI_TOOL_SOCKET;
if (!socketPath) {
	process.stderr.write("tool: works only inside the agent's bash tool\n");
	process.exit(2);
}

const argv = process.argv.slice(2);
// `-` (`--args -`, `tool edit -`) reads stdin; nothing else does, so `tool` in a `while read` loop leaves the loop's input alone.
let stdin;
if (argv.includes("-")) {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	stdin = Buffer.concat(chunks).toString("utf8");
}

const chunks = [];
const socket = connect(socketPath);
socket.on("error", (error) => {
	process.stderr.write(`tool: cannot reach the agent (${error.message}); the bash call that started this command has ended\n`);
	process.exit(2);
});
socket.on("data", (chunk) => chunks.push(chunk));
socket.on("end", () => {
	socket.end();
	const raw = Buffer.concat(chunks).toString("utf8");
	let response;
	try {
		response = JSON.parse(raw);
	} catch {
		process.stderr.write("tool: the agent ended the call without an answer\n");
		process.exit(1);
	}
	process.stdout.write(response.stdout, () => process.stderr.write(response.stderr, () => process.exit(response.code)));
});
// One line, and the socket stays open: closing it is how the agent learns this command was killed.
socket.write(`${JSON.stringify({ argv, cwd: process.cwd(), ...(stdin === undefined ? {} : { stdin }) })}\n`);
