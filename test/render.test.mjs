import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/plan.mjs";
import { header, renderMoved, renderPlan, renderProblems, renderStatus, renderSteps, renderUndone, renderVerify } from "../src/render.mjs";
import { makeColors } from "../src/util.mjs";
import { put, seedConfig, world } from "./helpers.mjs";

const plain = makeColors({}, false, false);
const color = makeColors({ FORCE_COLOR: "1" }, false, false);
const strip = (s) => s.replace(/\x1b\[\d+m/g, "");
const emoji = /\p{Extended_Pictographic}/u;

const moved = (over = {}) => ({ plan: { origin: { configDir: "/old/.claude" }, destination: { config: "/new/claude" } }, method: "rename", bytes: 16384, files: 30, stale: null, manifest: "/new/claude/relocate-manifest.json", warnings: [], incomplete: false, ...over });

test("the header names the tool, its version and the command", () => {
  assert.equal(header("verify", plain), "claude-relocate 1.0.0  verify");
  assert.equal(header("verify", color), "\x1b[1mclaude-relocate 1.0.0\x1b[0m  verify");
});

test("renderMoved: what was moved, how, how much, where the manifest is, and the two next steps", () => {
  assert.equal(renderMoved(moved(), { c: plain }), [
    "Moved /old/.claude to /new/claude",
    "  renamed, not copied: both are on the same drive",
    "  16 KB in 30 files: same files, same sizes, file times kept (checked)",
    "  manifest: /new/claude/relocate-manifest.json",
    "",
    "Open a new terminal (this one keeps the environment it started with), then run: claude-relocate verify",
    "To put everything back: claude-relocate undo",
  ].join("\n"));
});

test("renderMoved: a copy, a mixed move, a kept .claude.json, notes, and a move whose surroundings did not all work", () => {
  assert.match(renderMoved(moved({ method: "copy" }), { c: plain }), /^ {2}copied and checked, then the original was removed$/m);
  assert.match(renderMoved(moved({ method: "mixed" }), { c: plain }), /^ {2}renamed where the drive is the same, copied where it is not$/m);
  assert.match(renderMoved(moved({ files: 1, bytes: 12 }), { c: plain }), /^ {2}12 B in 1 file: /m);
  assert.match(renderMoved(moved({ stale: ".claude.json.before-relocate" }), { c: plain }), /^ {2}The folder's own older \.claude\.json is kept as \.claude\.json\.before-relocate next to the live one\.$/m);
  const notes = renderMoved(moved({ warnings: ["first note", "second note"], incomplete: true }), { c: plain });
  assert.match(notes, /^note {2}first note\nnote {2}second note\n\n✗ The move is done, but not everything around it worked \(see the notes above\)\.\nTo put everything back/m);
  assert.ok(!notes.includes("Open a new terminal"), "an incomplete move does not say all is well");
});

test("renderUndone: where the folder is back, how, and what to do in this terminal", () => {
  const r = { destination: "/new/claude", origin: "/old/.claude", method: "rename", warnings: [], incomplete: false };
  assert.equal(renderUndone(r, { c: plain }), [
    "Undone. /new/claude is back at /old/.claude",
    "  renamed, not copied: both are on the same drive",
    "",
    "Open a new terminal. If this terminal has CLAUDE_CONFIG_DIR set, it still points at the old place: unset it here too.",
  ].join("\n"));
  assert.match(renderUndone({ ...r, method: "copy" }, { c: plain }), /^ {2}copied and checked, then the copy in the new place was removed$/m);
  assert.match(renderUndone({ ...r, warnings: ["a note"], incomplete: true }, { c: plain }), /^note {2}a note\n\n✗ The folder is back, but not everything around it could be undone \(see the notes above\)\.$/m);
});

test("renderProblems: every problem as a bullet, and the promise that nothing was changed", () => {
  assert.equal(renderProblems("Not moved.", [{ code: "a", message: "first" }, { code: "b", message: "second" }], { c: plain }), "✗ Not moved.\n  - first\n  - second\nNothing was changed.");
  assert.equal(renderProblems("Not undone.", [{ message: "x" }], { c: color }), "\x1b[31m✗\x1b[0m Not undone.\n  - x\nNothing was changed.");
});

test("renderSteps: numbered steps, the parts of a split indented under their step, notes, what would be refused, and what happens next", () => {
  const r = {
    steps: [{ action: "move", text: "Move /a to /b." }, { action: "split", text: "  projects -> /s/projects" }, { action: "split", text: "  statsig -> /c/statsig" }, { action: "manifest", text: "Write the manifest." }],
    plan: { warnings: ["watch out"] },
    problems: [{ message: "claude is running" }],
  };
  assert.equal(renderSteps("move", r, { c: plain, dryRun: true }), [
    "With --dry-run, this is what would happen:",
    "  1. Move /a to /b.",
    "       projects -> /s/projects",
    "       statsig -> /c/statsig",
    "  2. Write the manifest.",
    "",
    "note  watch out",
    "",
    "✗ It would be refused:",
    "  - claude is running",
    "",
    "Nothing was changed (--dry-run).",
  ].join("\n"));
  assert.equal(renderSteps("undo", { steps: [{ action: "move", text: "Do it." }] }, { c: plain, needsYes: true }), "This will:\n  1. Do it.\n\nNothing was changed. Run it again with --yes to do this.");
});

test("renderVerify: one line per check with its level, the extra lines of a check under it, and the verdict", () => {
  const r = { ok: false, checks: [
    { id: "a", level: "ok", message: "fine" },
    { id: "b", level: "fail", message: "broken" },
    { id: "c", level: "warn", message: "odd" },
    { id: "d", level: "info", message: "fyi" },
    { id: "e", level: "skip", message: "skipped" },
    { id: "f", level: "ok", message: "3 sessions", lines: ["-p  2 sessions, newest 2026-10-01"] },
  ] };
  assert.equal(renderVerify(r, { c: plain }), [
    "claude-relocate 1.0.0  verify",
    "  ok    fine",
    "  FAIL  broken",
    "  warn  odd",
    "  info  fyi",
    "  skip  skipped",
    "  ok    3 sessions",
    "        -p  2 sessions, newest 2026-10-01",
    "",
    "✗ 1 check failed.",
    "Open a new terminal so that it starts with CLAUDE_CONFIG_DIR, then start claude there. Terminals that were open before the move keep the old environment.",
  ].join("\n"));
  assert.match(renderVerify({ ok: true, checks: [] }, { c: plain }), /^Every check passed\.$/m);
  assert.match(renderVerify({ ok: false, checks: [{ level: "fail", message: "x" }, { level: "fail", message: "y" }] }, { c: plain }), /^✗ 2 checks failed\.$/m);
  const colored = renderVerify(r, { c: color });
  assert.ok(colored.includes("\x1b[32mok  \x1b[0m") && colored.includes("\x1b[31mFAIL\x1b[0m") && colored.includes("\x1b[33mwarn\x1b[0m"));
});

test("renderStatus: each line is a sentence about one thing", () => {
  const s = {
    thisTerminal: { variable: "/new", configDir: "/new", source: "CLAUDE_CONFIG_DIR" },
    configDir: { path: "/new", exists: true, isLink: false, resolvesTo: "/new" },
    claudeJson: { path: "/new/.claude.json", exists: true, inside: true, size: 2048 },
    moved: { date: "2026-10-16T10:00:00.000Z", from: "/old", to: "/new", mode: "single", method: "rename", manifest: "/new/relocate-manifest.json", via: "CLAUDE_CONFIG_DIR" },
    links: [{ path: "/old", target: "/new", purpose: "origin", isLink: true, resolves: true }, { path: "/old2", target: "/new", purpose: "origin", isLink: true, resolves: false }, { path: "/old3", target: "/new", purpose: "origin", isLink: false, resolves: false }],
    profiles: [{ file: "/h/.bashrc", others: [{ line: 3, text: "export CLAUDE_CONFIG_DIR=/x" }] }],
    newTerminals: [{ name: "bash", value: "/new", from: "/h/.bashrc" }, { name: "zsh", value: null, from: "no profile file" }],
  };
  const out = renderStatus(s, { c: plain });
  assert.match(out, /^config folder {3}\/new {2}\(CLAUDE_CONFIG_DIR in this terminal\)$/m);
  assert.match(out, /^\.claude\.json {4}\/new\/\.claude\.json {2}\(2 KB; inside the config folder\)$/m);
  assert.match(out, /^moved {11}\/old to \/new on 2026-10-1[56] \(one folder, by rename\)$/m);
  assert.match(out, /^link {12}\/old -> \/new {2}\(resolves\)$/m);
  assert.match(out, /^link {12}\/old2 -> \/new {2}\(does not resolve\)$/m);
  assert.match(out, /^link {12}\/old3 -> \/new {2}\(is not a link now\)$/m);
  assert.match(out, /^ {2}bash {5}CLAUDE_CONFIG_DIR=\/new {2}\(\/h\/\.bashrc\)$/m);
  assert.match(out, /^ {2}zsh {6}CLAUDE_CONFIG_DIR not set {2}\(no profile file\)$/m);
  assert.match(out, /^note {2}\/h\/\.bashrc line 3 also sets CLAUDE_CONFIG_DIR: export CLAUDE_CONFIG_DIR=\/x$/m);
  assert.match(out, /^This terminal: CLAUDE_CONFIG_DIR=\/new\.$/m);
  const bare = renderStatus({ ...s, moved: null, links: [], profiles: [], newTerminals: [], claudeJson: { ...s.claudeJson, exists: false, inside: false, size: null }, thisTerminal: { variable: null, configDir: "/h/.claude", source: "default" }, configDir: { path: "/h/.claude", exists: false, isLink: false, resolvesTo: null } }, { c: plain });
  assert.match(bare, /^config folder {3}\/h\/\.claude {2}\(the default: CLAUDE_CONFIG_DIR is not set in this terminal; it does not exist\)$/m);
  assert.match(bare, /\(does not exist; next to the config folder\)$/m);
  assert.match(bare, /^ {2}nothing from claude-relocate$/m);
  assert.match(bare, /^This terminal: CLAUDE_CONFIG_DIR is not set\.$/m);
  assert.match(renderStatus({ ...s, claudeJson: { ...s.claudeJson, size: null } }, { c: plain }), /\(a link; inside the config folder\)$/m);
});

test("renderPlan with colours: the header is bold, notes are yellow, problems red, the hint dim; the text is the same without them", () => {
  const w = seedConfig(world("rd1", { shell: "" }));
  put(w.dest + "/x", "x");
  const sys = w.sys({ processes: () => ({ ok: true, processes: [{ pid: 1, name: "claude" }] }) });
  const model = buildPlan({ env: w.env, cwd: w.base, sys, opts: { to: w.dest } });
  const out = renderPlan(model, { c: color });
  assert.ok(out.includes("\x1b[1mclaude-relocate 1.0.0\x1b[0m"));
  assert.ok(out.includes("\x1b[33mnote\x1b[0m"));
  assert.ok(out.includes("\x1b[31m✗\x1b[0m"));
  assert.ok(out.includes("\x1b[2m  KIND"));
  assert.equal(strip(out), renderPlan(model, { c: plain }));
  const bare = buildPlan({ env: w.env, cwd: w.base, sys: w.sys(), opts: {} });
  assert.ok(renderPlan(bare, { c: color }).includes("\x1b[2mPass --to <folder> or --xdg to see where it would go, and the room there.\x1b[0m"));
});

test("nothing the renderers print has an emoji in it", () => {
  const w = seedConfig(world("rd2", { shell: "" }));
  const model = buildPlan({ env: w.env, cwd: w.base, sys: w.sys(), opts: { to: w.dest, link: true } });
  assert.ok(!emoji.test(renderPlan(model, { c: color })));
  assert.ok(!emoji.test(renderMoved(moved({ warnings: ["x"], incomplete: true }), { c: color })));
  assert.ok(!emoji.test(renderVerify({ ok: false, checks: [{ level: "fail", message: "x" }] }, { c: color })));
});
