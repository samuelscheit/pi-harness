import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, test } from "node:test";
import { parseShell, shellEffect } from "../extensions/metrics/shell.ts";
import { scriptWrites } from "../vendor/pi-lens/clients/inline-script-writes.ts";

const cwd = "/repo";
const writes = (command: string) => shellEffect(command, cwd).writes.sort();
const mutates = (command: string) => shellEffect(command, cwd).mutates;

describe("parseShell", () => {
	test("splits lists, pipelines and subshells, and removes quotes", () => {
		const commands = parseShell(`cd "/a b" && echo 'x; y' | tee -a out.log; (ls) || true`);
		assert.deepEqual(commands.map((c) => c.words), [["cd", "/a b"], ["echo", "x; y"], ["tee", "-a", "out.log"], ["ls"], ["true"]]);
	});

	test("redirections: targets, file descriptors and duplications", () => {
		const [cmd] = parseShell("npm test 2>&1 >log.txt 2>/dev/null &>all.txt >>append.txt <in.txt");
		assert.deepEqual(cmd!.words, ["npm", "test"]);
		assert.deepEqual(cmd!.redirects, [
			{ op: ">&", target: "1" }, { op: ">", target: "log.txt" }, { op: ">", target: "/dev/null" },
			{ op: "&>", target: "all.txt" }, { op: ">>", target: "append.txt" }, { op: "<", target: "in.txt" },
		]);
	});

	test("a digit word separated by a space is an argument, not a descriptor", () => {
		const [cmd] = parseShell("echo 2 > f");
		assert.deepEqual(cmd!.words, ["echo", "2"]);
		assert.deepEqual(cmd!.redirects, [{ op: ">", target: "f" }]);
	});

	test("heredoc bodies go to their command, including the redirection on the header line", () => {
		const commands = parseShell(`cat <<'EOF' > a.txt\nline > not-a-target\nEOF\npython3 - <<PY\nprint(1)\nPY\necho done`);
		assert.deepEqual(commands[0], { words: ["cat"], redirects: [{ op: ">", target: "a.txt" }], inputs: ["line > not-a-target"], depth: 0 });
		assert.deepEqual(commands[1]!.inputs, ["print(1)"]);
		assert.deepEqual(commands[2]!.words, ["echo", "done"]);
	});

	test("<<- strips leading tabs from the terminator; here-strings are inputs", () => {
		const commands = parseShell(`cat <<-END >x\n\tbody\n\tEND\npython3 <<< 'open("y","w")'`);
		assert.deepEqual(commands[0]!.inputs, ["\tbody"]);
		assert.deepEqual(commands[1]!.inputs, ['open("y","w")']);
	});

	test("comments, escapes, line continuations and ANSI-C strings", () => {
		const commands = parseShell(`# a comment > x\necho a\\ b \\\n  c $'tab\\there' # trailing > y`);
		assert.deepEqual(commands, [{ words: ["echo", "a b", "c", "tab\there"], redirects: [], inputs: [], depth: 0 }]);
	});

	test("${VAR} and brace expansion stay inside words; group commands separate", () => {
		const commands = parseShell("echo ${HOME}/x a{b,c} && { rm f; }");
		assert.deepEqual(commands.map((c) => c.words), [["echo", "${HOME}/x", "a{b,c}"], ["rm", "f"]]);
	});
});

describe("shellEffect: writers", () => {
	test("output redirections write their target; /dev/* and descriptor duplication do not", () => {
		assert.deepEqual(writes("ls > files.txt 2>/dev/null"), ["/repo/files.txt"]);
		assert.deepEqual(writes("cmd >> log/out.log 2>&1"), ["/repo/log/out.log"]);
		assert.deepEqual(writes("cmd &> all.txt"), ["/repo/all.txt"]);
		assert.equal(mutates("npm test 2>&1 | tail -5"), false);
		assert.equal(mutates("cmd >&2"), false);
	});

	test("heredoc into a file, relative to the cd before it", () => {
		assert.deepEqual(writes(`cd /tmp/x && cat > /tmp/f8.sql <<'EOF'\nselect 1 > 0;\nEOF`), ["/tmp/f8.sql"]);
		assert.deepEqual(writes(`cd sub; cat <<EOF > notes.md\nhi\nEOF`), ["/repo/sub/notes.md"]);
	});

	test("sed -i in GNU and BSD forms; sed without -i only reads", () => {
		assert.deepEqual(writes("sed -i '' 's/a/b/' src/a.ts"), ["/repo/src/a.ts"]);
		assert.deepEqual(writes("sed -i 's/a/b/' a.ts b.ts"), ["/repo/a.ts", "/repo/b.ts"]);
		assert.deepEqual(writes("sed -i.bak -e 's/a/b/' -e 's/c/d/' x.py"), ["/repo/x.py"]);
		assert.deepEqual(writes("sed -Ei 's/a/b/' y.py"), ["/repo/y.py"]);
		assert.deepEqual(writes("sed --in-place=.orig 's/a/b/' z.py"), ["/repo/z.py"]);
		assert.equal(mutates("sed -n 1,80p src/a.ts"), false);
		assert.deepEqual(writes("sed 's/a/b/' in.ts > out.ts"), ["/repo/out.ts"]);
	});

	test("perl -pi edits its files; perl -ne does not", () => {
		assert.deepEqual(writes("perl -pi -e 's/a/b/g' lib/x.pm"), ["/repo/lib/x.pm"]);
		assert.deepEqual(writes("perl -i.bak -pe 's/a/b/' c.txt"), ["/repo/c.txt"]);
		assert.equal(mutates("perl -ne 'print if /x/' c.txt"), false);
	});

	test("file utilities: tee, cp, mv, rm, touch, mkdir, ln, install, dd, truncate", () => {
		assert.deepEqual(writes("echo x | tee -a a.log b.log"), ["/repo/a.log", "/repo/b.log"]);
		assert.deepEqual(writes("cp -r src/ /tmp/backup"), ["/tmp/backup"]);
		assert.deepEqual(writes("cp -t dest a b"), ["/repo/dest"]);
		assert.deepEqual(writes("mv old.ts new.ts"), ["/repo/new.ts", "/repo/old.ts"]);
		assert.deepEqual(writes("rm -rf build dist/"), ["/repo/build", "/repo/dist"]);
		assert.deepEqual(writes("mkdir -p a/b && touch a/b/c.ts"), ["/repo/a/b", "/repo/a/b/c.ts"]);
		assert.deepEqual(writes("ln -sf ../x.ts link.ts"), ["/repo/link.ts"]);
		assert.deepEqual(writes("install -m 755 bin/x /usr/local/bin/x"), ["/usr/local/bin/x"]);
		assert.deepEqual(writes("dd if=/dev/zero of=disk.img bs=1m count=1"), ["/repo/disk.img"]);
		assert.deepEqual(writes("truncate -s 0 log.txt"), ["/repo/log.txt"]);
		assert.equal(mutates("cp onlyone"), false);
	});

	test("git: path-taking writers name their files, tree-wide ones mutate without names, reads do neither", () => {
		assert.deepEqual(writes("git checkout -- src/a.ts"), ["/repo/src/a.ts"]);
		assert.deepEqual(writes("git restore --staged b.ts"), ["/repo/b.ts"]);
		assert.deepEqual(writes("git mv a.ts b.ts"), ["/repo/a.ts", "/repo/b.ts"]);
		assert.deepEqual(writes("git -C sub rm x.ts"), ["/repo/x.ts"]);
		for (const command of ["git apply fix.diff", "git stash", "git stash pop", "git checkout main", "git pull --rebase", "git reset --hard HEAD~1".replace("reset --hard HEAD~1", "rebase main")]) {
			assert.equal(mutates(command), true, command);
			assert.deepEqual(writes(command), [], command);
		}
		for (const command of ["git status", "git diff src/a.ts", "git log -5", "git show HEAD:src/a.ts", "git stash list", "git commit -m 'x > y'"]) {
			assert.equal(mutates(command), false, command);
		}
	});

	test("formatters write only in write mode, also behind npx/pnpm exec", () => {
		assert.deepEqual(writes("npx prettier --write src/a.ts src/b.ts"), ["/repo/src/a.ts", "/repo/src/b.ts"]);
		assert.equal(mutates("npx prettier --check src/a.ts"), false);
		assert.deepEqual(writes("pnpm exec eslint --fix lib/x.ts"), ["/repo/lib/x.ts"]);
		assert.deepEqual(writes("ruff format app.py"), ["/repo/app.py"]);
		assert.equal(mutates("ruff check app.py"), false);
		assert.deepEqual(writes("ruff check --fix app.py"), ["/repo/app.py"]);
		assert.deepEqual(writes("gofmt -w main.go"), ["/repo/main.go"]);
		assert.equal(mutates("gofmt -l ."), false);
		assert.deepEqual(writes("biome check --write src"), ["/repo/src"]);
		assert.equal(mutates("black ."), true);
	});

	test("downloads with an output file write it", () => {
		assert.deepEqual(writes("curl -sL -o out.json https://x.test/a.json"), ["/repo/out.json"]);
		assert.equal(mutates("curl -s https://x.test/a.json | jq ."), false);
		assert.deepEqual(writes("wget -O page.html https://x.test"), ["/repo/page.html"]);
	});

	test("package changes mutate without naming files; installs from the lockfile and scripts do not", () => {
		assert.equal(mutates("npm install left-pad"), true);
		assert.equal(mutates("pnpm add -D vitest"), true);
		assert.equal(mutates("npm install"), false);
		assert.equal(mutates("npm run build"), false);
	});

	test("wrappers, environment prefixes and xargs", () => {
		assert.deepEqual(writes("sudo rm /etc/x.conf"), ["/etc/x.conf"]);
		assert.deepEqual(writes("FOO=1 BAR=2 timeout 30 sed -i 's/a/b/' f.ts"), ["/repo/f.ts"]);
		assert.deepEqual(writes("env -i PATH=/bin cp a b"), ["/repo/b"]);
		assert.equal(mutates("rg -l foo | xargs sed -i 's/foo/bar/'"), true);
		assert.deepEqual(writes("rg -l foo | xargs sed -i 's/foo/bar/'"), []);
		assert.equal(mutates("find . -name '*.ts' | xargs grep -l x"), false);
		assert.equal(mutates("ls | xargs -I {} rm {}"), true);
	});

	test("a cd inside a subshell or command substitution does not outlive it", () => {
		assert.deepEqual(writes("cd apps && (cd web && bun test 2>&1 | tail -3) > ../units.log 2>&1; echo x > here.txt"), ["/repo/apps/here.txt", "/repo/units.log"]);
		assert.deepEqual(writes("x=$(cd /tmp && pwd); touch a.txt"), ["/repo/a.txt"]);
		assert.deepEqual(writes("(cd a; (cd b; touch deep.txt); touch mid.txt); touch top.txt"), ["/repo/a/b/deep.txt", "/repo/a/mid.txt", "/repo/top.txt"]);
	});

	test("bash -c and shell heredocs are analysed recursively", () => {
		assert.deepEqual(writes(`bash -c "cd sub && echo x > y.txt"`), ["/repo/sub/y.txt"]);
		assert.deepEqual(writes(`sh <<'EOF'\nrm old.txt\nEOF`), ["/repo/old.txt"]);
	});

	test("shell variables resolve when assigned in the same command line; unresolvable targets mutate without names", () => {
		assert.deepEqual(writes("Z=src/law && cat > $Z/a.lean <<EOF\nx\nEOF"), ["/repo/src/law/a.lean"]);
		assert.deepEqual(writes("export OUT=/tmp/o; echo 1 > ${OUT}/r.txt"), ["/tmp/o/r.txt"]);
		assert.deepEqual(writes("echo 1 > $PWD/here.txt"), ["/repo/here.txt"]);
		assert.deepEqual(writes(`echo 1 > "$HOME/h.txt"`), [`${homedir()}/h.txt`]);
		assert.equal(mutates("for f in *.ts; do sed -i 's/a/b/' $f; done"), true);
		assert.deepEqual(writes("for f in *.ts; do sed -i 's/a/b/' $f; done"), []);
		assert.equal(mutates("echo x > $(mktemp)"), true);
	});

	test("sed scripts, search patterns, awk and jq programs are not files", () => {
		assert.deepEqual(shellEffect("sed -i '' 's/a/b/' src/a.ts", cwd).files, ["/repo/src/a.ts"]);
		assert.deepEqual(shellEffect("sed -e 's#x/y#z#' -e 's/q/r/' in.ts", cwd).files, ["/repo/in.ts"]);
		assert.deepEqual(shellEffect("rg -n 'src/old/path' -g '*.ts' lib/", cwd).files, ["/repo/lib"]);
		assert.deepEqual(shellEffect("grep -rn foo/bar docs/", cwd).files, ["/repo/docs"]);
		assert.deepEqual(shellEffect("awk -F, '{print $1/2}' data.csv", cwd).files, ["/repo/data.csv"]);
		assert.deepEqual(shellEffect("jq .a/.b x.json", cwd).files, ["/repo/x.json"]);
		assert.deepEqual(shellEffect("perl -ne 'print if m{a/b}' f.txt", cwd).files, ["/repo/f.txt"]);
	});

	test("read-only commands mutate nothing", () => {
		for (const command of [
			"rg -n 'a > b' src/", "grep -rn '>>' .", "cat a.ts | head -50", "ls -la docs/ src", "find . -name '*.ts' -newer x",
			"wc -c tests/fixtures/law/Testgesetz.xml && head -c 3000 tests/fixtures/law/Testgesetz.xml; grep -n \"<enbez>\" tests/fixtures/law/Testgesetz.xml | head -60",
			"node -e 'console.log(1 > 0)'", "python3 -c 'print(open(\"a.txt\").read())'", "sqlite3 m.db 'select 1 where 2 > 1'",
			"echo '{\"a\": 1}' | jq '.a > 0'", "diff <(sort a) <(sort b)",
		]) {
			assert.equal(mutates(command), false, command);
		}
	});
});

describe("shellEffect: inline scripts", () => {
	test("Python heredoc rewriting a file through a variable, relative to the cd", () => {
		const command = `cd /w/apps/my && python3 - <<'EOF'\np="app/(dashboard)/planner/PlannerTable.tsx"; s=open(p).read()\ns=s.replace("a","b")\nopen(p,"w").write(s)\nEOF`;
		assert.deepEqual(shellEffect(command, cwd).writes, ["/w/apps/my/app/(dashboard)/planner/PlannerTable.tsx"]);
	});

	test("pathlib write_text through a variable and inline", () => {
		const command = `python3 -I - <<'EOF'\nimport pathlib\np=pathlib.Path("docker-compose.dev.yml"); s=p.read_text()\ns=s.replace("x", "y")\np.write_text(s)\npathlib.Path('b.txt').write_text("1")\nEOF`;
		assert.deepEqual(writes(command), ["/repo/b.txt", "/repo/docker-compose.dev.yml"]);
	});

	test("an interpreter named through a variable", () => {
		assert.deepEqual(writes(`V=/w/venv/bin/python3; $V -I - <<'EOF'\np=pathlib.Path("zf.yaml")\np.write_text(s)\nEOF`), ["/repo/zf.yaml"]);
		assert.equal(mutates(`$UNSET - <<'EOF'\nopen("x","w")\nEOF`), false);
	});

	test("a script that only reads, or replaces in strings, does not mutate", () => {
		const command = `python3 - <<'EOF'\nf='src/beck.ts'; s=open(f).read()\ns=s.replace('a','b')\nprint(s.count('x'))\nEOF`;
		assert.equal(mutates(command), false);
		assert.equal(mutates(`python3 -c "import json; print(json.load(open('a.json'))['x'])"`), false);
	});

	test("edit helpers resolve their path parameter from the calls", () => {
		const python = `def sub(path, pairs, imp=True):\n    s=open(path).read()\n    for a,b in pairs:\n        s=s.replace(a,b)\n    open(path,'w').write(s)\nsub("lib/a.ts", [("x","y")])\nsub('lib/b.ts', [])`;
		assert.deepEqual(scriptWrites(python), { paths: ["lib/a.ts", "lib/b.ts"], unknown: false });
		const pathlib = `def ed(f, old, new):\n    p = Path(f)\n    t = p.read_text()\n    p.write_text(t.replace(old, new))\ned("src/x.lean", "a", "b")`;
		assert.deepEqual(scriptWrites(pathlib), { paths: ["src/x.lean"], unknown: false });
		const js = "const edit = (file, a, b) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(a, b));\nedit('a.md', 'x', 'y');";
		assert.deepEqual(scriptWrites(js), { paths: ["a.md"], unknown: false });
		assert.deepEqual(scriptWrites(`def w(p):\n    open(p, "w")\nfor f in files:\n    w(f)`), { paths: [], unknown: true });
		assert.deepEqual(scriptWrites(`def w(p):\n    open(p, "w")`), { paths: [], unknown: true });
	});

	test("computed targets mutate without a name", () => {
		const command = `python3 - <<'PY'\nfor p in ['a.ts','b.ts']:\n    s=open(p).read()\n    open(p,'w').write(s)\nPY`;
		assert.equal(mutates(command), true);
		assert.deepEqual(writes(command), []);
		assert.equal(mutates(`python3 -c "import sys;f=sys.argv[1];open(f,'w').write('x')" a.ts`), true);
	});

	test("node -e and heredoc scripts", () => {
		assert.deepEqual(writes(`node -e "require('fs').writeFileSync('out/a.json', '{}')"`), ["/repo/out/a.json"]);
		assert.deepEqual(writes(`node - <<'EOF'\nconst fs = require("fs");\nconst f = "x.md";\nfs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("a", "b"));\nEOF`), ["/repo/x.md"]);
		assert.deepEqual(writes(`bun -e 'await Bun.write("b.txt", "1")'`), ["/repo/b.txt"]);
		assert.equal(mutates(`node -e "console.log(require('fs').readFileSync('a').length)"`), false);
	});
});

describe("scriptWrites", () => {
	test("open modes: w, a, x and + write; r does not; keyword mode too", () => {
		assert.deepEqual(scriptWrites(`open("a","w"); open('b', 'a'); open("c", mode="x"); open("d", "r+"); open("e"); open("f", "rb")`).paths, ["a", "b", "c", "d"]);
	});

	test("the latest assignment before the write wins", () => {
		assert.deepEqual(scriptWrites(`p = "one.ts"\nopen(p, "w")\np = "two.ts"\nopen(p, "w")`).paths, ["one.ts", "two.ts"]);
	});

	test("os, shutil and Path operations", () => {
		const result = scriptWrites(`import os, shutil\nos.remove("a")\nshutil.copy("src.txt", "dst.txt")\nshutil.move("m1", "m2")\nshutil.rmtree("build")\nPath("q").unlink()`);
		assert.deepEqual(result.paths.sort(), ["a", "build", "dst.txt", "m1", "m2", "q"]);
		assert.equal(result.unknown, false);
	});

	test("str.replace and str.rename-like calls on non-paths are ignored; Path.replace counts", () => {
		assert.deepEqual(scriptWrites(`s = open("a").read()\ns = s.replace("x", "y")`), { paths: [], unknown: false });
		assert.deepEqual(scriptWrites(`p = Path("a.txt")\np.replace("b.txt")`).paths, ["a.txt"]);
	});

	test("f-strings and template literals are unknown targets", () => {
		assert.deepEqual(scriptWrites(`open(f"{d}/x.json", "w")`), { paths: [], unknown: true });
		assert.deepEqual(scriptWrites("fs.writeFileSync(`${dir}/x`, s)"), { paths: [], unknown: true });
		assert.deepEqual(scriptWrites("fs.writeFileSync(`plain.txt`, s)"), { paths: ["plain.txt"], unknown: false });
	});

	test("Node fs variants and Ruby File.write", () => {
		const result = scriptWrites(`fs.appendFileSync("log", "x"); fs.renameSync("a", "b"); await fs.promises.writeFile("p", ""); fs.rmSync("dir", {recursive: true}); File.write("r.rb", "x")`);
		assert.deepEqual(result.paths.sort(), ["a", "b", "dir", "log", "p", "r.rb"]);
	});
});
