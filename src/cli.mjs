// claude-relocate: move Claude Code's config folder somewhere else, safely, and set CLAUDE_CONFIG_DIR to match.
// Commands: plan, move, verify, undo, status. It reads and writes files only; it runs no model and makes no network
// request. The only programs it starts are tasklist/ps (to see whether claude is running), reg and setx (Windows
// user environment), df or PowerShell (free space on a Node without fs.statfsSync), and `claude --version` in verify.
// The ones that ship with Windows are started by their full path (see spawn.mjs), not by a name that the working
// folder could answer.
import { runMove } from "./move.mjs";
import { buildPlan } from "./plan.mjs";
import { renderMoved, renderPlan, renderProblems, renderStatus, renderSteps, renderUndone, renderVerify } from "./render.mjs";
import { runStatus } from "./status.mjs";
import { makeSys } from "./sys.mjs";
import { runUndo } from "./undo.mjs";
import { UsageError, UserError, makeColors } from "./util.mjs";
import { runVerify } from "./verify.mjs";
import { REPO_URL, VERSION } from "./version.mjs";

export const COMMANDS = {
  plan: { bool: ["xdg", "json"], value: ["to"] },
  move: { bool: ["xdg", "link", "no-env", "ignore-running", "dry-run", "yes", "json"], value: ["to"] },
  verify: { bool: ["json"], value: [] },
  undo: { bool: ["ignore-running", "dry-run", "yes", "json"], value: [] },
  status: { bool: ["json"], value: [] },
};

const HELP = `claude-relocate ${VERSION}: move Claude Code's config folder, sessions and .claude.json to another drive or into the XDG folders, and set CLAUDE_CONFIG_DIR to match.

Usage: claude-relocate <command> [options]

  plan   [--to <folder> | --xdg]
         what is in the config folder, how big each kind is, where it would go and whether there is room
  move   (--to <folder> | --xdg) [--link] [--no-env] [--ignore-running] [--dry-run] [--yes]
         move it, keeping file times; write CLAUDE_CONFIG_DIR into your shell profiles (and the Windows user
         environment); leave a manifest so that undo can put it back. Without --yes it only shows what it would do
  verify check that the move works: the variable in each profile, the folder, the links, the session list, \`claude --version\`
  undo   [--ignore-running] [--dry-run] [--yes]
         put everything back from the manifest
  status where things are now and what each shell will see

Options:
  --to <folder>      the new config folder (new or empty)
  --xdg              $XDG_CONFIG_HOME/claude (default ~/.config/claude); on Linux and macOS the sessions and other
                     state go to $XDG_STATE_HOME/claude and the caches to $XDG_CACHE_HOME/claude, each behind a link
  --link             leave a junction (Windows) or a symbolic link at the old place, for programs that ignore the variable
  --no-env           do not write CLAUDE_CONFIG_DIR into profiles or the Windows user environment
  --ignore-running   do not refuse because a claude process is running (close it first if you can)
  --dry-run          show what would happen and change nothing
  --yes              do it (move and undo change nothing without it)
  --json             one JSON document on stdout (errors too, as {"ok": false, "error": ...})
  --no-color         no colour (NO_COLOR does the same)
  -h, --help         this text
  -v, --version      the version

Exit codes: 0 done or nothing wrong, 1 refused or something to fix, 2 wrong usage.
Environment: CLAUDE_CONFIG_DIR is the folder to move (default ~/.claude); NO_COLOR. Nothing is sent anywhere.
${REPO_URL}
`;

const ALL_FLAGS = new Set(Object.values(COMMANDS).flatMap((spec) => [...spec.bool, ...spec.value]));
const camel = (key) => key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

// argv -> { command, positional, help, version, noColor, opts }. The command comes first.
function parseArgs(argv) {
  const o = { command: null, positional: [], help: false, version: false, noColor: false, opts: {} };
  let spec = null;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith("--") && a.includes("=")) { inline = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    if (a === "-h" || a === "--help") { o.help = true; continue; }
    if (a === "-v" || a === "--version") { o.version = true; continue; }
    if (a === "--no-color") { o.noColor = true; continue; }
    if (a.startsWith("-") && a !== "-") {
      const key = a.startsWith("--") ? a.slice(2) : "";
      if (!spec) {
        if (ALL_FLAGS.has(key) || key === "json") throw new UsageError(`the command comes first: claude-relocate <plan|move|verify|undo|status> ${a} ...`);
        throw new UsageError(`unknown option ${a}`);
      }
      if (key === "json" || spec.bool.includes(key)) {
        if (inline !== null) throw new UsageError(`${a} does not take a value`);
        o.opts[camel(key)] = true;
      } else if (spec.value.includes(key)) {
        const v = inline !== null ? inline : argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : undefined;
        if (v === undefined || v === "") throw new UsageError(`${a} needs a folder, such as ${a} ${process.platform === "win32" ? "D:\\Claude" : "/mnt/data/claude"}`);
        o.opts[key] = v;
      } else if (ALL_FLAGS.has(key)) throw new UsageError(`${o.command} does not take ${a}`);
      else throw new UsageError(`unknown option ${a}`);
      continue;
    }
    if (o.command === null) {
      if (!Object.hasOwn(COMMANDS, a)) throw new UsageError(`unknown command ${a}`);
      o.command = a;
      spec = COMMANDS[a];
    } else o.positional.push(a);
  }
  return o;
}

const doc = (command, body) => ({ schema: 1, tool: "claude-relocate", version: VERSION, command, ...body });

// Runs the tool. `io` lets tests capture output and fake the machine: { stdout, stderr, env, cwd, sys }.
// Returns the exit code.
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const cwd = io.cwd || process.cwd();
  const wantJson = argv.includes("--json");
  const emit = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  const sayErr = (message, hint) => {
    if (wantJson) emit({ ok: false, error: message });
    else stderr.write(`claude-relocate: ${message}\n${hint ? `${hint}\n` : ""}`);
  };

  let o;
  try {
    o = parseArgs(argv);
    if (!o.help && !o.version) {
      if (o.command === null) throw new UsageError("a command is needed");
      if (o.positional.length) throw new UsageError(`${o.command} takes no arguments (got "${o.positional[0]}")`);
      const x = o.opts;
      if (x.to !== undefined && x.xdg) throw new UsageError("use --to <folder> or --xdg, not both");
      if (o.command === "move" && x.to === undefined && !x.xdg) throw new UsageError("move needs a destination: --to <folder>, or --xdg");
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    sayErr(e.message, "Try: claude-relocate --help");
    return 2;
  }
  if (o.help) { stdout.write(HELP); return 0; }
  if (o.version) { stdout.write(`${VERSION}\n`); return 0; }

  const sys = io.sys || makeSys();
  const c = makeColors(env, !!stdout.isTTY, o.noColor);
  const json = !!o.opts.json;
  const log = json ? () => {} : (line) => stdout.write(`${line}\n`);
  const opts = o.opts;

  try {
    switch (o.command) {
      case "plan": {
        const model = buildPlan({ env, cwd, sys, opts: { to: opts.to, xdg: !!opts.xdg } });
        const ok = model.problems.length === 0;
        if (json) emit(doc("plan", { ok, ...model }));
        else stdout.write(`${renderPlan(model, { c })}\n`);
        return ok ? 0 : 1;
      }
      case "move": {
        if (!json) log(c.bold(`claude-relocate ${VERSION}`) + "  move");
        const r = runMove({ env, cwd, sys, opts: { to: opts.to, xdg: !!opts.xdg, link: !!opts.link, noEnv: !!opts.noEnv, ignoreRunning: !!opts.ignoreRunning, dryRun: !!opts.dryRun, yes: !!opts.yes }, log });
        return finish("move", r, { json, emit, stdout, stderr, c, moved: renderMoved });
      }
      case "undo": {
        if (!json) log(c.bold(`claude-relocate ${VERSION}`) + "  undo");
        const r = runUndo({ env, cwd, sys, opts: { ignoreRunning: !!opts.ignoreRunning, dryRun: !!opts.dryRun, yes: !!opts.yes }, log });
        return finish("undo", r, { json, emit, stdout, stderr, c, moved: renderUndone });
      }
      case "verify": {
        const r = runVerify({ env, cwd, sys });
        if (json) emit(doc("verify", { ...r }));
        else stdout.write(`${renderVerify(r, { c })}\n`);
        return r.ok ? 0 : 1;
      }
      case "status": {
        const s = runStatus({ env, cwd, sys });
        if (json) emit(doc("status", { ok: true, ...s }));
        else stdout.write(`${renderStatus(s, { c })}\n`);
        return 0;
      }
      default:
        throw new UsageError(`unknown command ${o.command}`);
    }
  } catch (e) {
    if (e instanceof UserError) {
      if (json) emit({ ok: false, error: e.message, code: e.code });
      else stderr.write(`${c.red("✗")} ${e.message}\n`);
      return 1;
    }
    if (json) emit({ ok: false, error: `claude-relocate hit an unexpected error: ${e && e.message ? e.message : e}` });
    else stderr.write(`${c.red("✗")} claude-relocate hit an unexpected error: ${e && e.stack ? e.stack : e}\n`);
    return 1; // 2 is for wrong usage
  }
}

// The output and exit code of move and undo, whichever way they ended.
function finish(command, r, { json, emit, stdout, stderr, c, moved }) {
  if (r.refused) {
    if (json) emit(doc(command, { ok: false, refused: true, dryRun: !!r.dryRun, error: r.problems[0].message, problems: r.problems, steps: r.steps, plan: r.plan }));
    else if (r.dryRun) stdout.write(`${renderSteps(command, r, { c, dryRun: true })}\n`);
    else stderr.write(`${renderProblems(command === "move" ? "Not moved." : "Not undone.", r.problems, { c })}\n`);
    return 1;
  }
  if (r.dryRun) {
    if (json) emit(doc(command, { ok: true, dryRun: true, steps: r.steps, plan: r.plan }));
    else stdout.write(`${renderSteps(command, r, { c, dryRun: true })}\n`);
    return 0;
  }
  if (r.needsYes) {
    if (json) emit(doc(command, { ok: false, needsYes: true, error: "Nothing was changed. Run it again with --yes to do this.", steps: r.steps, plan: r.plan }));
    else stderr.write(`${renderSteps(command, r, { c, needsYes: true })}\n`);
    return 1;
  }
  if (json) emit(doc(command, { ...stripPlan(r), ok: !r.incomplete }));
  else stdout.write(`${moved(r, { c })}\n`);
  return r.incomplete ? 1 : 0;
}

function stripPlan(r) {
  const { plan, ...rest } = r;
  return { ...rest, plan: plan ? { origin: plan.origin, destination: plan.destination, env: plan.env, total: plan.total } : undefined };
}

