// The environment variable through which a bash command's `tool` reaches the session's bridge
// (bridge.ts), on its own: leftovers.ts reads it too, and bridge.ts imports leftovers.ts.
export const SOCKET_ENV = "PI_TOOL_SOCKET";
