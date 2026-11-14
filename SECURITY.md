# Security

Please report vulnerabilities privately through [GitHub's security advisories](https://github.com/samuelscheit/pi-harness/security/advisories/new), not in public issues.

## Trust model

The harness gives a coding agent the same access as the user who runs it. It does not sandbox the agent:

- `bash` runs commands as the user, and `tool <name>` inside bash can call every tool the agent has.
- Workflows run TypeScript in the Pi process. `agent({ files })` restricts which files a child agent may change, as a guard against mistakes, not as a security boundary.
- Dreaming and experiment commands commit to this repository, and a commit deploys to every running session.
- The dashboard listens on port 4317 on **every network interface**, so other devices on the local network can open it (it prints their URLs). It has no authentication. It checks the `Host` header (an IP address, `localhost`, or the machine's own name) against DNS rebinding, and serves read-only metrics, which include prompts and file paths from your sessions. Use it only on networks you trust, or change `server.listen` in `dashboard/server/server.ts` to bind to `127.0.0.1`.
- The installer stores the gateway token in the macOS Keychain, not in a file.

For vulnerabilities in the bundled packages, report to their upstreams as well: [Pi](https://github.com/earendil-works/pi) and [pi-lens](https://github.com/apmantza/pi-lens).
