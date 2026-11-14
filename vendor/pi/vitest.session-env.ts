/**
 * A suite started from inside a Pi session (an agent running the tests) inherits that session's
 * environment: what Pi exports to its tools and the user's own Pi configuration. Code under test
 * reads these, so a test would see the developer's session instead of its own setup; e.g. an inherited
 * PI_CACHE_RETENTION=long turns every request into a one-hour-cache request. Dropped here, in the
 * config process, before the workers that inherit its environment start. Tests set what they need.
 */
const inheritedFromPiSession = [
	// Set by Pi at startup for its child processes.
	"PI_CODING_AGENT",
	// Exported by the bash tool (packages/coding-agent/src/core/tools/bash.ts).
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	// User configuration read by pi-ai's providers and cache warming.
	"PI_CACHE_RETENTION",
];

for (const name of inheritedFromPiSession) delete process.env[name];
