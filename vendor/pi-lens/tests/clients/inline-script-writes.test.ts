import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractWrittenPathsFromCommand,
	tokenizeShellCommand,
} from "../../clients/bash-file-access.js";
import {
	inlineScripts,
	scriptWrites,
} from "../../clients/inline-script-writes.js";

const cwd = path.resolve("/repo");
const at = (...parts: string[]) => path.join(cwd, ...parts);
const written = (command: string) =>
	extractWrittenPathsFromCommand(command, cwd).sort();

// The shape agents write most: a helper that asserts each old text once, then rewrites the file.
const EDIT_SCRIPT = `def edit(p, pairs):
    s=open(p).read()
    for a,b in pairs:
        assert s.count(a)==1,(p,a)
        s=s.replace(a,b)
    open(p,'w').write(s)

edit('views/ir.rs',[('a','b')])
edit('views/cfg.rs',[('c','d')])
s=open('views/output.rs').read()
open('views/output.rs','w').write(s)`;

describe("inline interpreter scripts are bash writes", () => {
	it("a python heredoc's edit helper names every file it rewrites, also after a cd and before a build", () => {
		expect(
			written(
				`cd crates/viz && python3 - <<'EOF'\n${EDIT_SCRIPT}\nEOF\ncd ../.. && cargo build 2>&1 | head`,
			),
		).toEqual(
			[
				at("crates/viz/views/cfg.rs"),
				at("crates/viz/views/ir.rs"),
				at("crates/viz/views/output.rs"),
			].sort(),
		);
	});

	it("unquoted and tab-stripped heredocs, `python -`, versioned and absolute interpreters", () => {
		expect(
			written(`python - <<EOF\nopen("a.ts", "w").write("x")\nEOF`),
		).toEqual([at("a.ts")]);
		expect(
			written(
				`/opt/venv/bin/python3.12 <<-'PY'\n\tfrom pathlib import Path\n\tPath("b.py").write_text("x")\n\tPY`,
			),
		).toEqual([at("b.py")]);
		expect(
			written(
				`node <<'JS'\nrequire("fs").writeFileSync("c.js", "x")\nJS\necho done`,
			),
		).toEqual([at("c.js")]);
	});

	it("-c and -e code", () => {
		expect(written(`python3 -c "open('d.txt','w').write('x')"`)).toEqual([
			at("d.txt"),
		]);
		expect(
			written(`node -e 'require("fs").writeFileSync("e.json", "{}")'`),
		).toEqual([at("e.json")]);
	});

	it("a script file's stdin is data, and reading code writes nothing", () => {
		expect(
			written(`python3 tool.py <<'EOF'\nopen("x.ts","w")\nEOF`),
		).toEqual([]);
		expect(
			written(`python3 - <<'EOF'\nprint(open("x.ts").read())\nEOF`),
		).toEqual([]);
	});

	it("two heredocs in one command go to their own commands", () => {
		expect(
			written(
				`cat > notes.md <<'A'\nopen("not-code.ts","w")\nA\npython3 - <<'B'\nopen("f.ts","w")\nB`,
			),
		).toEqual([at("f.ts"), at("notes.md")].sort());
	});

	it("a computed target is not named (opaque recovery covers it)", () => {
		expect(
			written(
				`python3 - <<'EOF'\nfor p in ["a","b"]:\n    open(p + ".ts","w")\nEOF`,
			),
		).toEqual([]);
	});

	it("the tokenizer's public segments are unchanged by heredoc bodies", () => {
		expect(
			tokenizeShellCommand(`python3 - <<'EOF'\nx = 1\nEOF\nls a`).map(
				(segment) => segment.tokens,
			),
		).toEqual([["python3", "-"], ["ls", "a"]]);
	});
});

describe("inlineScripts", () => {
	it("flags first, else stdin unless a script file is named", () => {
		expect(inlineScripts("python3", ["-c", "code"], ["stdin"])).toEqual([
			"code",
		]);
		expect(inlineScripts("deno", ["eval", "code"], [])).toEqual(["code"]);
		expect(inlineScripts("python3", ["-"], ["stdin"])).toEqual(["stdin"]);
		expect(inlineScripts("python3", ["-I", "-u"], ["stdin"])).toEqual([
			"stdin",
		]);
		expect(inlineScripts("python3", ["x.py"], ["stdin"])).toEqual([]);
		expect(inlineScripts("cat", [], ["stdin"])).toEqual([]);
	});

	it("scriptWrites resolves helper parameters from their calls", () => {
		expect(scriptWrites(EDIT_SCRIPT)).toEqual({
			paths: ["views/ir.rs", "views/cfg.rs", "views/output.rs"],
			unknown: false,
		});
	});
});
