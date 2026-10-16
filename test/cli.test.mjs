import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { COMMANDS, main } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { CLI, everything, lexists, run, runCli, runJson, seedConfig, world } from "./helpers.mjs";

const fresh = (name, opts = {}) => seedConfig(world(name, { shell: "", ...opts }));
const sink = () => { const s = { out: "", err: "" }; return { s, stdout: { write: (x) => { s.out += x; }, isTTY: false }, stderr: { write: (x) => { s.err += x; } } }; };

test("every flag the parser accepts is in the usage line of its command, and every option is explained", async () => {
  const w = world("cli0");
  const help = (await run(["--help"], w)).out;
  for (const [command, spec] of Object.entries(COMMANDS)) {
    const line = help.split("\n").find((l) => l.startsWith(`  ${command} `));
    assert.ok(line, `${command} has a line in the help`);
    for (const flag of [...spec.bool.filter((f) => f !== "json"), ...spec.value]) assert.ok(line.includes(`--${flag}`), `${command}: --${flag} is in "${line.trim()}"`);
  }
  for (const flag of ["--to <folder>", "--xdg", "--link", "--no-env", "--ignore-running", "--dry-run", "--yes", "--json", "--no-color", "-h, --help", "-v, --version"]) assert.ok(help.includes(`  ${flag}`), flag);
  assert.match(help, /Exit codes: 0 done or nothing wrong, 1 refused or something to fix, 2 wrong usage\./);
  assert.match(help, /Nothing is sent anywhere\./);
  assert.match(help, /https:\/\/github\.com\/nrzz\/claude-relocate\n$/);
});

test("--help and -h print the help on stdout and exit 0, wherever they are; --version and -v print the version", async () => {
  const w = world("cli1");
  for (const argv of [["--help"], ["-h"], ["plan", "--help"], ["move", "-h", "--to", "x"], ["--no-color", "--help"]]) {
    const r = await run(argv, w);
    assert.equal(r.code, 0, argv.join(" "));
    assert.match(r.out, /^claude-relocate 1\.0\.0: move Claude Code's config folder, sessions and \.claude\.json to another drive or into the XDG folders/);
    assert.equal(r.err, "");
  }
  for (const argv of [["--version"], ["-v"], ["plan", "-v"]]) {
    const r = await run(argv, w);
    assert.deepEqual([r.code, r.out, r.err], [0, `${VERSION}\n`, ""], argv.join(" "));
  }
});

test("a command line that cannot be run is a usage error: exit 2, one line on stderr and a hint, nothing on stdout", async () => {
  const w = world("cli2");
  const table = [
    [[], /^claude-relocate: a command is needed\n/],
    [["bogus"], /^claude-relocate: unknown command bogus\n/],
    [["Plan"], /unknown command Plan/],
    [["plan", "extra"], /^claude-relocate: plan takes no arguments \(got "extra"\)\n/],
    [["--yes", "plan"], /^claude-relocate: the command comes first: claude-relocate <plan\|move\|verify\|undo\|status> --yes \.\.\.\n/],
    [["--to", "x", "plan"], /the command comes first: .* --to \.\.\./],
    [["plan", "--bogus"], /^claude-relocate: unknown option --bogus\n/],
    [["--bogus"], /^claude-relocate: unknown option --bogus\n/],
    [["plan", "-x"], /^claude-relocate: unknown option -x\n/],
    [["plan", "--link"], /^claude-relocate: plan does not take --link\n/],
    [["verify", "--to", "x"], /^claude-relocate: verify does not take --to\n/],
    [["status", "--yes"], /^claude-relocate: status does not take --yes\n/],
    [["undo", "--xdg"], /^claude-relocate: undo does not take --xdg\n/],
    [["plan", "--to"], /^claude-relocate: --to needs a folder, such as --to \S+\n/],
    [["plan", "--to", "--xdg"], /^claude-relocate: --to needs a folder/],
    [["plan", "--to="], /^claude-relocate: --to needs a folder/],
    [["plan", "--xdg=1"], /^claude-relocate: --xdg does not take a value\n/],
    [["plan", "--json=1"], /^claude-relocate: --json does not take a value\n/],
    [["plan", "--to", "a", "--xdg"], /^claude-relocate: use --to <folder> or --xdg, not both\n/],
    [["move", "--yes"], /^claude-relocate: move needs a destination: --to <folder>, or --xdg\n/],
  ];
  for (const [argv, re] of table) {
    const r = await run(argv, w);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.out, "", `${argv.join(" ")}: nothing on stdout`);
    assert.match(r.err, re, argv.join(" "));
    assert.ok(r.err.endsWith("Try: claude-relocate --help\n"), argv.join(" "));
  }
});

test("with --json a usage error is a JSON document on stdout: {ok: false, error}", async () => {
  const w = world("cli3");
  for (const argv of [["plan", "extra", "--json"], ["--json", "plan"], ["move", "--json"], ["bogus", "--json"]]) {
    const r = await run(argv, w);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.err, "");
    const j = JSON.parse(r.out);
    assert.deepEqual(Object.keys(j), ["ok", "error"]);
    assert.equal(j.ok, false);
    assert.ok(j.error.length > 10);
  }
});

test("an option may be written --to=<folder> as well as --to <folder>, and --no-color goes anywhere", async () => {
  const w = fresh("cli4");
  const a = await runJson(["plan", `--to=${w.dest}`], w);
  const b = await runJson(["plan", "--to", w.dest], w);
  assert.deepEqual(a.json.destination, b.json.destination);
  const c = await run(["--no-color", "plan"], w, { env: { FORCE_COLOR: "1" } });
  assert.ok(!c.out.includes("\x1b["), "--no-color beats FORCE_COLOR");
  const d = await run(["plan"], w, { env: { FORCE_COLOR: "1" } });
  assert.ok(d.out.includes("\x1b["), "FORCE_COLOR colours a pipe");
});

test("every command has a --json form with the same four first fields", async () => {
  const w = fresh("cli5");
  for (const argv of [["plan"], ["verify"], ["status"], ["move", "--to", w.dest, "--dry-run"], ["undo", "--dry-run"]]) {
    const r = await runJson(argv, w);
    assert.ok(r.json, `${argv[0]}: ${r.all}`);
    assert.deepEqual(Object.keys(r.json).slice(0, 4), ["schema", "tool", "version", "command"], argv[0]);
    assert.deepEqual([r.json.schema, r.json.tool, r.json.version, r.json.command], [1, "claude-relocate", VERSION, argv[0]]);
    assert.equal(typeof r.json.ok, "boolean");
    assert.equal(r.err, "", `${argv[0]}: JSON mode writes only to stdout`);
  }
});

test("exit codes: 0 when nothing is wrong, 1 when refused or something is wrong, 2 for a usage error and for a bug", async () => {
  const w = fresh("cli6");
  assert.equal((await run(["plan"], w)).code, 0);
  assert.equal((await run(["status"], w)).code, 0);
  assert.equal((await run(["verify"], w)).code, 0);
  assert.equal((await run(["move", "--to", w.dest], w)).code, 1, "without --yes");
  assert.equal((await run(["move", "--to", w.dest, "--dry-run"], w)).code, 0);
  assert.equal((await run(["undo"], w)).code, 1, "nothing to undo");
  assert.equal((await run(["plan", "--to", w.cfg], w)).code, 1, "a destination that is refused");
  assert.equal((await run(["nope"], w)).code, 2);
  const broken = w.sys({ processes: () => { throw new TypeError("boom"); } });
  const r = await run(["plan"], w, { sys: broken });
  assert.equal(r.code, 1, "an error of the program's own is not 'wrong usage' (2)");
  assert.match(r.err, /^✗ claude-relocate hit an unexpected error: TypeError: boom/);
  const j = await run(["plan", "--json"], w, { sys: broken });
  assert.equal(j.code, 1);
  assert.match(JSON.parse(j.out).error, /^claude-relocate hit an unexpected error: boom$/);
});

test("main() writes to the streams it is given", async () => {
  const { s, stdout, stderr } = sink();
  assert.equal(await main(["--version"], { stdout, stderr }), 0);
  assert.equal(s.out, `${VERSION}\n`);
});

test("the program itself (bin/claude-relocate.mjs, a child process): version, help, a usage error, plan --json", () => {
  const w = fresh("cli7");
  const v = runCli(["--version"], { cwd: w.base, env: w.env });
  assert.deepEqual([v.code, v.out, v.err], [0, `${VERSION}\n`, ""]);
  const h = runCli(["--help"], { cwd: w.base, env: w.env });
  assert.equal(h.code, 0);
  assert.match(h.out, /^claude-relocate 1\.0\.0: /);
  const u = runCli(["plan", "--nope"], { cwd: w.base, env: w.env });
  assert.deepEqual([u.code, u.out], [2, ""]);
  assert.match(u.err, /^claude-relocate: unknown option --nope\n/);
  const p = runCli(["plan", "--json", "--to", w.dest], { cwd: w.base, env: w.env });
  assert.equal(p.code, 0, p.all);
  const j = JSON.parse(p.out);
  assert.deepEqual([j.ok, j.command, j.destination.config], [true, "plan", w.dest]);
});

test("the program itself: move and undo through the real entry point, with the real process check", () => {
  // --ignore-running because the machine running the tests may well have a claude process of its own
  const w = fresh("cli8");
  const before = everything(w);
  const m = runCli(["move", "--to", w.dest, "--yes", "--no-env", "--ignore-running"], { cwd: w.base, env: w.env });
  assert.equal(m.code, 0, m.all);
  assert.match(m.out, /^Moved .* to .*$/m);
  assert.ok(!lexists(w.cfg) && lexists(path.join(w.dest, "settings.json")));
  const env = { ...w.env, CLAUDE_CONFIG_DIR: w.dest };
  const v = runCli(["verify", "--json"], { cwd: w.base, env });
  assert.ok(JSON.parse(v.out).checks.length >= 5, v.all);
  const u = runCli(["undo", "--yes", "--ignore-running"], { cwd: w.base, env });
  assert.equal(u.code, 0, u.all);
  assert.match(u.out, /^Undone\. /m);
  assert.deepEqual(Object.keys(everything(w)), Object.keys(before));
  assert.ok(lexists(path.join(w.cfg, "settings.json")) && !lexists(w.dest));
});

test("with a real process check and no --ignore-running, move either runs or is refused for a stated reason, and never half way", () => {
  const w = fresh("cli9");
  const before = everything(w);
  const m = runCli(["move", "--to", w.dest, "--yes", "--no-env", "--json"], { cwd: w.base, env: w.env });
  const j = JSON.parse(m.out);
  if (m.code === 0) assert.equal(j.ok, true);
  else {
    assert.equal(j.ok, false);
    assert.ok(j.problems[0].code === "claude-running" || j.problems[0].code === "process-check-failed", JSON.stringify(j.problems));
    assert.deepEqual(everything(w), before);
  }
});

test("a pipe that closes early is not an error: the entry point ends quietly (EPIPE)", async () => {
  const w = fresh("cli10");
  const child = spawn(process.execPath, [CLI, "--help"], { env: w.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.once("data", () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(err, "");
  assert.ok(code === 0 || code === null, `exit ${code}`);
});
