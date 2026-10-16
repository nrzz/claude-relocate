// The package itself: what it says it is, what it imports, which Node it needs, which files start processes, that
// nothing touches the network, and that the README and the workflows say what the code does.
// (There is no .gitattributes on purpose: Anthropic's plugin directory cannot validate a repository that has one, and the files are LF already.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { CLI, ROOT } from "./helpers.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const json = (rel) => JSON.parse(read(rel));
const files = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));
const sources = () => [...files("src", ".mjs"), ...files("bin", ".mjs")];

const pkg = json("package.json");

test("package.json: name, version, bin, engines, no dependencies, tests run with node --test", () => {
  assert.equal(pkg.name, "claude-relocate");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.private, undefined, "published, not private");
  assert.deepEqual(pkg.bin, { "claude-relocate": "bin/claude-relocate.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.deepEqual(pkg.scripts, { test: "node --test" });
  assert.deepEqual(pkg.files, ["bin", "src", "README.md", "LICENSE"]);
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed and exists`);
  assert.equal(pkg.repository, "github:nrzz/claude-relocate");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-relocate#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-relocate/issues");
  assert.match(pkg.description, /^Move Claude Code's config folder to another drive or into the XDG folders/);
  assert.match(pkg.description, /Zero tokens\.$/);
  for (const k of ["claude", "claude-code", "anthropic", "CLAUDE_CONFIG_DIR", "xdg", "relocate"]) assert.ok(pkg.keywords.includes(k), k);
});

test("the version is written once in the code, and the package, the changelog and the README agree with it", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\] - 20\\d\\d-\\d\\d-\\d\\d$`, "m"));
  assert.match(read("CHANGELOG.md"), new RegExp(`^\\[${VERSION.replace(/\./g, "\\.")}\\]: https://github\\.com/nrzz/claude-relocate/releases/tag/v${VERSION.replace(/\./g, "\\.")}$`, "m"));
  const mentioned = [...read("README.md").matchAll(/claude-relocate (\d+\.\d+\.\d+)(?=[ :])/g)].map((m) => m[1]);
  assert.ok(mentioned.length >= 5, "the README's examples print the version");
  assert.deepEqual([...new Set(mentioned)], [VERSION], "and it is this one");
  assert.match(read("src/cli.mjs"), /\$\{VERSION\}/, "the help prints it");
  assert.equal(read("src/version.mjs").match(/VERSION = "(.+)"/)[1], VERSION);
});

test("no lock file, no node_modules, nothing that installs", () => {
  for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "node_modules"]) assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} must not exist`);
});

test("every source file is .mjs and imports only node built-ins it needs and the package itself", () => {
  const list = sources();
  assert.ok(list.length >= 20);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "src")).filter((n) => !n.endsWith(".mjs")), []);
  const allowed = new Set(["node:fs", "node:os", "node:path", "node:child_process"]);
  const used = new Set();
  for (const f of list) {
    const text = read(f);
    for (const m of text.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
      const spec = m[1];
      if (spec.startsWith("./") || spec.startsWith("../")) { assert.ok(fs.existsSync(path.join(ROOT, path.dirname(f), spec)), `${f}: ${spec} exists`); continue; }
      assert.ok(allowed.has(spec), `${f} imports ${spec}`);
      used.add(spec);
    }
    assert.doesNotMatch(text, /\brequire\(|\bimport\(/, `${f} has no dynamic loading`);
  }
  assert.deepEqual([...used].sort(), ["node:child_process", "node:fs", "node:os", "node:path"]);
});

test("only spawn.mjs starts processes, and only the files that look at the machine use it; nothing can reach the network", () => {
  const startsProcesses = [];
  const usesSpawn = [];
  for (const f of sources()) {
    const text = read(f);
    if (/from "node:child_process"/.test(text)) startsProcesses.push(path.basename(f));
    if (/from "\.\/spawn\.mjs"/.test(text)) usesSpawn.push(path.basename(f));
  }
  assert.deepEqual(startsProcesses, ["spawn.mjs"], "the one place that imports child_process");
  assert.deepEqual(usesSpawn.sort(), ["procs.mjs", "space.mjs", "sys.mjs", "winenv.mjs"], "and exactly these four go through it");
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|node:(http|https|http2|net|tls|dns|dgram|worker_threads|cluster|vm)\b|\bprocess\.binding\b|\beval\s*\(|new Function\s*\(/;
  for (const f of sources()) assert.doesNotMatch(read(f), banned, f);
});

test("only APIs that exist in Node 18 are used", () => {
  const newer = [
    [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(\d/, "Array copy-methods (Node 20)"],
    [/\bObject\.groupBy\b|\bMap\.groupBy\b/, "groupBy (Node 21)"],
    [/\bArray\.fromAsync\b/, "Array.fromAsync (Node 22)"],
    [/\bPromise\.withResolvers\b/, "Promise.withResolvers (Node 22)"],
    [/import\.meta\.(dirname|filename)\b/, "import.meta.dirname/filename (Node 20.11)"],
    [/\bfs\.(glob|globSync)\b/, "fs.glob (Node 22)"],
    [/\.(isWellFormed|toWellFormed)\(/, "String well-formed methods (Node 20)"],
    [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods (Node 22)"],
    [/process\.getBuiltinModule|process\.loadEnvFile|util\.styleText|\bstyleText\b/, "newer process/util APIs"],
    [/\bimport\s[^;]*\swith\s*\{/, "import attributes"],
  ];
  for (const f of sources()) {
    const text = read(f);
    for (const [re, what] of newer) assert.doesNotMatch(text, re, `${f}: ${what}`);
  }
});

test("the entry point is a thin script that runs main() and ends quietly on a closed pipe", () => {
  const bin = read("bin/claude-relocate.mjs");
  assert.ok(bin.startsWith("#!/usr/bin/env node\n"));
  assert.match(bin, /import \{ main \} from "\.\.\/src\/cli\.mjs";/);
  assert.match(bin, /EPIPE/);
  assert.equal(path.basename(CLI), "claude-relocate.mjs");
});

test("the license, the conduct file, the policies and the changelog are there", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE"), /^Copyright \(c\) 2026 Naresh Prabu$/m);
  for (const f of ["CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", "ROADMAP.md", "CHANGELOG.md"]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.match(read("SECURITY.md"), /github\.com\/nrzz\/claude-relocate\/security\/advisories\/new/);
  assert.match(read("CONTRIBUTING.md"), /good first issue/);
  const roadmap = read("ROADMAP.md");
  assert.ok((roadmap.match(/^- \*\*/gm) || []).length >= 3 && (roadmap.match(/^- \*\*/gm) || []).length <= 5, "three to five next steps");
  assert.match(roadmap, /good first issue #\d+/);
});

test("the CI workflows: the suite on three systems and four Node versions, the real-binary checks on two systems", () => {
  const ci = read(".github/workflows/test.yml");
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /node: 18/);
  assert.match(ci, /uses: actions\/checkout@\S+/);
  assert.match(ci, /uses: actions\/setup-node@\S+/);
  assert.match(ci, /run: npm test/);
  assert.match(ci, /npm pack/, "the packed tarball is installed and run on the three systems");
  const e2e = read(".github/workflows/e2e.yml");
  for (const part of ["name: e2e", "os: [ubuntu-latest, macos-latest]", "npm install -g @anthropic-ai/claude-code", "continue-on-error: true", "E2E_CLAUDE: claude", "test/e2e-claude.test.mjs", "schedule:", "workflow_dispatch"]) assert.ok(e2e.includes(part), part);
  assert.match(e2e, /uses: actions\/checkout@\S+/);
  assert.match(read(".github/dependabot.yml"), /package-ecosystem: github-actions\n\s+directory: \/\n\s+schedule:\n\s+interval: weekly/);
});

test("issue templates for a bug and a feature, blank issues off, discussions and private reporting linked; a pull request template", () => {
  for (const f of ["bug_report.yml", "feature_request.yml", "config.yml"]) assert.ok(fs.existsSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE", f)), f);
  const config = read(".github/ISSUE_TEMPLATE/config.yml");
  assert.match(config, /blank_issues_enabled: false/);
  assert.match(config, /github\.com\/nrzz\/claude-relocate\/discussions/);
  assert.match(config, /github\.com\/nrzz\/claude-relocate\/security\/advisories\/new/);
  assert.match(read(".github/ISSUE_TEMPLATE/bug_report.yml"), /labels: \["bug"\]/);
  assert.match(read(".github/PULL_REQUEST_TEMPLATE.md"), /npm test/);
});

test("the README has the sections the house keeps, in order, with Privacy under How it works", () => {
  const readme = read("README.md");
  const order = ["## What you get", "## What it costs in tokens", "## Install", "## Use", "## How it works", "### Privacy", "## What was verified, and how", "## Not verified", "## Files", "## Contributing", "## Part of the Claude Code toolkit", "## License"];
  let at = -1;
  for (const h of order) {
    const i = readme.indexOf(`\n${h}\n`);
    assert.ok(i > at, `${h} comes after the one before it`);
    at = i;
  }
  assert.match(readme, /^# claude-relocate\n\n\[!\[test\]\(https:\/\/github\.com\/nrzz\/claude-relocate\/actions\/workflows\/test\.yml\/badge\.svg\)\]\(https:\/\/github\.com\/nrzz\/claude-relocate\/actions\/workflows\/test\.yml\)[^\n]*license: MIT[^\n]*node >= 18[^\n]*dependencies: none[^\n]*\n\n/);
  assert.ok(!/\p{Extended_Pictographic}/u.test(readme), "no emoji");
  assert.ok(!/\bsimply\b/i.test(readme), "no 'simply'");
});

test("the README names the problem, the install line, every command and every option, and a section per command", () => {
  const readme = read("README.md");
  for (const n of ["1455", "2350", "57998", "30538"]) assert.ok(readme.includes(`anthropics/claude-code/issues/${n}`), `#${n} is linked`);
  assert.ok(readme.includes("npx -y github:nrzz/claude-relocate plan"));
  assert.ok(readme.includes("git clone https://github.com/nrzz/claude-relocate"));
  assert.ok(!readme.includes("/plugin install"), "there is no plugin");
  for (const command of Object.keys(COMMANDS)) {
    assert.ok(readme.includes(`\n### \`${command}\`\n`), `a section for ${command}`);
    assert.ok(readme.includes(`claude-relocate ${command}`), `${command} is shown`);
  }
  const flags = new Set(Object.values(COMMANDS).flatMap((spec) => [...spec.bool, ...spec.value]));
  for (const flag of [...flags, "no-color"]) assert.ok(readme.includes(`\`--${flag}`), `--${flag}`);
  assert.ok(readme.includes("`--help`") || readme.includes("--help"), "--help");
});

test("the costs table has one row per command, every one 0 tokens", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("\n## What it costs in tokens\n"), readme.indexOf("\n## Install\n"));
  const rows = section.split("\n").filter((l) => /^\| `/.test(l));
  assert.deepEqual(rows.map((l) => /^\| `claude-relocate (\w+)/.exec(l)[1]), Object.keys(COMMANDS));
  for (const row of rows) assert.match(row, /\| 0 \|/, row);
  assert.match(section, /Nothing runs a model/);
});

test("Part of the toolkit: the lines of the other tools, the setup page and the star line, word for word", () => {
  const readme = read("README.md");
  const tail = readme.slice(readme.indexOf("\n## Part of the Claude Code toolkit\n"), readme.indexOf("\n## License\n"));
  const lines = tail.split("\n").filter((l) => l.startsWith("- ["));
  assert.deepEqual(lines, [
    "- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself",
    "- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers",
    "- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD",
    "- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits",
    "- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes",
    "- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings",
    "- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it",
    "- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command",
    "- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay",
    "- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them",
    "- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history",
    "- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep",
    "- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does",
    "- [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor): a commented settings.jsonc that builds settings.json, the merged settings with their source, a lint against the schema",
    "- [claude-automode-doctor](https://github.com/nrzz/claude-automode-doctor): what auto mode and its classifier decided, from your transcripts, plus a lint of the autoMode settings",
    "- [claude-mcp-check](https://github.com/nrzz/claude-mcp-check): every MCP server Claude Code would load, from which file, whether it starts, and what its tools cost",
  ]);
  assert.ok(tail.includes("Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):"));
  assert.ok(tail.includes("Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on."));
  assert.ok(tail.includes("If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases."));
});

test("the README's Files table lists what the repository holds", () => {
  const readme = read("README.md");
  const table = readme.slice(readme.indexOf("\n## Files\n"), readme.indexOf("\n## Contributing\n"));
  for (const f of ["bin/claude-relocate.mjs", "src/cli.mjs", "src/move.mjs", "src/undo.mjs", "src/plan.mjs", "src/verify.mjs", "src/profiles.mjs", "src/winenv.mjs", "test/", ".github/workflows/"]) assert.ok(table.includes(`\`${f}`), `Files lists ${f}`);
});

test("a test never points at the real Claude folder, the real home or the real registry key", () => {
  assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.HOME), "the config folder is inside the throwaway home");
  assert.match(path.basename(process.env.HOME), /^cr-guard-/, "which is the guard's folder");
  assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.match(process.env.CLAUDE_RELOCATE_REG_KEY, /claude-relocate-test/);
  assert.ok(!/^(CLAUDE_CODE_|ANTHROPIC_)/.test(Object.keys(process.env).find((k) => /^(CLAUDE_CODE_|ANTHROPIC_)/.test(k)) || ""), "no key or session variable of the machine");
});

test("the README has no placeholder left in it, and every relative link in it leads to a file that exists", () => {
  const readme = read("README.md");
  assert.ok(!readme.includes("@@"), "no @@ placeholder");
  for (const m of readme.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `${m[1]} exists`);
});
