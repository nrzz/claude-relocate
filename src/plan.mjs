// The plan: what is in the config folder in use, how big each kind is, where `move` would put it, whether
// there is room, and why it would refuse. `plan` prints it; `move` builds it again before it changes anything.
// Nothing is written here.
import fs from "node:fs";
import path from "node:path";
import { configInUse, xdgDirs } from "./env.mjs";
import { CLAUDE_JSON, KIND_LABEL, KINDS, MANIFEST_NAME, inventory, measure, scanSettings } from "./inventory.mjs";
import { readManifest } from "./manifest.mjs";
import { planProfiles } from "./profiles.mjs";
import { MiB, count, isEmptyDir, isInside, nearestExisting, realLoose, resolveFolder, samePath, size, statOf } from "./util.mjs";
import { splitParts, splitSupported } from "./xdg.mjs";
import { keyOf } from "./winenv.mjs";
import { VERSION } from "./version.mjs";

const problem = (code, message) => ({ code, message });

// The order the folders of a split destination are named in.
const AREAS = ["config", "state", "cache"];

// Room a copy needs beyond the bytes of the files: some of the small files take a whole block each.
const slack = (files) => 16 * MiB + files * 1024;

// Why `dest` cannot be a destination folder (it must be new or empty, and outside the origin). Returns problems.
function destinationProblems(dest, origin, label) {
  const out = [];
  // the top of a drive, and a folder that holds or is the config folder, are said once and not also "not empty"
  if (path.parse(path.resolve(dest)).root === path.resolve(dest)) return [problem("destination-is-root", `${label} ${dest} is the top of a drive. Choose a folder on it, such as ${path.join(dest, "claude")}.`)];
  const realO = realLoose(origin);
  const realD = realLoose(dest);
  if (samePath(realO, realD)) return [problem("same-folder", `${label} ${dest} is the config folder itself.`)];
  if (isInside(realO, realD)) return [problem("destination-in-origin", `${label} ${dest} is inside the config folder ${origin}. Choose a folder outside it.`)];
  if (isInside(realD, realO)) return [problem("origin-in-destination", `The config folder ${origin} is inside ${label.toLowerCase()} ${dest}. Choose a folder that does not contain it.`)];
  const st = statOf(dest);
  if (st) {
    if (st.isSymbolicLink()) out.push(problem("destination-is-link", `${label} ${dest} is a link. Choose a real folder.`));
    else if (!st.isDirectory()) out.push(problem("destination-is-file", `${label} ${dest} is a file.`));
    else if (!isEmptyDir(dest)) {
      const n = fs.readdirSync(dest).length;
      const unfinished = fs.existsSync(path.join(dest, ".claude-relocate-incomplete"));
      out.push(problem("destination-not-empty", `${label} ${dest} exists and is not empty (${count(n)} ${n === 1 ? "item" : "items"})${unfinished ? "; it holds an unfinished copy from an earlier run (.claude-relocate-incomplete), which you can delete" : ""}. Choose a new or empty folder.`));
    }
  } else {
    const anc = nearestExisting(dest);
    const sa = statOf(anc);
    if (sa && !sa.isDirectory()) out.push(problem("destination-is-file", `${label} ${dest} cannot be created: ${anc} is a file.`));
    else {
      try { fs.accessSync(anc, fs.constants.W_OK); } catch { out.push(problem("destination-unwritable", `${label} ${dest} cannot be created: ${anc} is not writable.`)); }
    }
  }
  return out;
}

// The words for a list of processes: "2 processes (claude.exe; pid 12640, 16556)".
export function describeProcesses(list) {
  const shown = list.slice(0, 5).map((p) => p.pid).join(", ");
  const names = [...new Set(list.map((p) => p.name))].join(", ");
  return `${list.length === 1 ? "1 process" : `${list.length} processes`} (${names}; pid ${shown}${list.length > 5 ? `, and ${list.length - 5} more` : ""})`;
}

// buildPlan({ env, cwd, sys, opts }) -> the plan model.
//   opts: { to, xdg, forMove, ignoreRunning, noEnv, link }
export function buildPlan({ env, cwd, sys, opts = {} }) {
  const platform = sys.platform;
  const cfg = configInUse(env, { cwd, platform });
  const home = cfg.home;
  const st = statOf(cfg.dir);
  const model = {
    schema: 1, tool: "claude-relocate", version: VERSION, platform, home,
    origin: {
      configDir: cfg.dir, source: cfg.source, exists: !!st && st.isDirectory() && !st.isSymbolicLink(), isLink: !!st && st.isSymbolicLink(), linkTarget: null,
      claudeJson: cfg.claudeJson, claudeJsonInside: cfg.claudeJsonInside, claudeJsonExists: false, claudeJsonIsLink: false, relocated: false,
    },
    kinds: [], entries: [], total: { bytes: 0, files: 0, links: 0 },
    destination: null, space: [], env: null, processes: { ok: true, list: [], error: null },
    references: [], warnings: [], problems: [],
  };

  // --- the origin ---
  if (st && st.isSymbolicLink()) {
    try { model.origin.linkTarget = fs.readlinkSync(cfg.dir); } catch { /* unreadable */ }
    model.problems.push(problem("origin-is-link", `The config folder ${cfg.dir} is a link${model.origin.linkTarget ? ` to ${model.origin.linkTarget}` : ""}. Move the folder it points to instead (run this with CLAUDE_CONFIG_DIR set to that folder), or remove the link first.`));
  } else if (!model.origin.exists) {
    model.problems.push(problem("no-config", `There is no Claude Code config folder at ${cfg.dir}, so there is nothing to move.${cfg.source === "default" ? " CLAUDE_CONFIG_DIR is not set, so ~/.claude is used." : ""}`));
  }
  const jst = statOf(cfg.claudeJson);
  model.origin.claudeJsonExists = !!jst;
  model.origin.claudeJsonIsLink = !!jst && jst.isSymbolicLink();
  if (!cfg.claudeJsonInside && jst && jst.isSymbolicLink()) {
    model.problems.push(problem("claude-json-is-link", `${cfg.claudeJson} is a link. Moving it would replace the link, so it is left to you: make it a real file first.`));
  }

  let referenced = new Set();
  if (model.origin.exists) {
    const scan = scanSettings(cfg.dir, { isDefault: cfg.source === "default" });
    referenced = scan.entries;
    model.references = scan.references;
    model.origin.relocated = fs.existsSync(path.join(cfg.dir, MANIFEST_NAME));
    const inv = inventory(cfg.dir, { referenced, claudeJsonOutside: cfg.claudeJsonInside ? "" : cfg.claudeJson });
    model.entries = inv.entries;
    model.total = inv.total;
    model.kinds = KINDS.map((kind) => ({ kind, label: KIND_LABEL[kind], ...inv.kinds[kind], destination: "" }));
    for (const e of inv.entries) if (e.type === "link" && e.kind !== "claudeJson") model.warnings.push(`${e.name} in the config folder is a link${e.target ? ` to ${e.target}` : ""}: it is moved as a link, and what it points to stays where it is.`);
    if (model.origin.relocated) {
      // links an earlier move left at the place this folder came from lead here, and will lead nowhere once it moves on
      const earlier = readManifest(path.join(cfg.dir, MANIFEST_NAME));
      const left = earlier.ok ? earlier.manifest.links.filter((l) => l.purpose !== "xdg" && typeof l.path === "string" && (statOf(l.path) || { isSymbolicLink: () => false }).isSymbolicLink()) : [];
      if (left.length) model.warnings.push(`An earlier move left ${left.length === 1 ? "a link that leads" : `${left.length} links that lead`} here (${left.map((l) => l.path).join(", ")}). ${left.length === 1 ? "It" : "They"} will lead nowhere once this folder moves: run undo first, or point ${left.length === 1 ? "it" : "them"} at the new place yourself.`);
    }
    if (model.references.length) {
      model.warnings.push(`settings.json or settings.local.json spell the config folder's path in ${model.references.length === 1 ? "1 place" : `${model.references.length} places`} (hooks or the status line). They stop working after a move unless you use --link or change them.`);
    }
  } else {
    model.kinds = KINDS.map((kind) => ({ kind, label: KIND_LABEL[kind], bytes: 0, files: 0, links: 0, entries: [], destination: "" }));
  }

  // --- running claude processes ---
  const procs = sys.processes();
  model.processes = { ok: procs.ok, list: procs.ok ? procs.processes : [], error: procs.ok ? null : procs.error };
  if (!procs.ok) model.warnings.push(`Could not check whether Claude Code is running: ${procs.error}.`);
  else if (procs.processes.length) model.warnings.push(`Claude Code or the Claude desktop app is running: ${describeProcesses(procs.processes)}. Close it before you move anything.`);
  if (opts.forMove && !opts.ignoreRunning) {
    if (!procs.ok) model.problems.push(problem("process-check-failed", `Could not check whether Claude Code is running (${procs.error}). Close Claude Code and the Claude desktop app, then use --ignore-running.`));
    else if (procs.processes.length) model.problems.push(problem("claude-running", `Claude Code or the Claude desktop app is running: ${describeProcesses(procs.processes)}. Close it, then run this again. (--ignore-running skips this check.)`));
  }

  // --- the working folder: a folder some program is standing in cannot be renamed on Windows, and a shell left in a moved folder is lost ---
  if (model.origin.exists && isInside(realLoose(cfg.dir), realLoose(cwd))) {
    const text = `The working folder ${cwd} is inside the config folder. Change to another folder first.`;
    if (opts.forMove) model.problems.push(problem("working-folder-inside", text));
    else model.warnings.push(text);
  }

  // --- the profile files that already set CLAUDE_CONFIG_DIR some other way ---
  // (read by `verify` and `status`; the plan only needs the files it would write)

  // --- the destination ---
  if (opts.to !== undefined || opts.xdg) {
    planDestination(model, { env, cwd, sys, opts, cfg, home, platform });
  }
  return model;
}

function planDestination(model, { env, cwd, sys, opts, cfg, home, platform }) {
  const origin = cfg.dir;
  let target;
  if (opts.xdg) {
    const x = xdgDirs(env, platform);
    const split = splitSupported(platform);
    target = { requested: "xdg", mode: split ? "xdg-split" : "single", config: x.config, state: split ? x.state : null, cache: split ? x.cache : null, parts: [] };
    if (!split) model.warnings.push(platform === "win32"
      ? "On Windows --xdg puts everything in one folder, $XDG_CONFIG_HOME/claude (the state and cache folders are for Linux and macOS)."
      : "The split into state and cache folders is switched off in this version, so --xdg puts everything in one folder.");
  } else {
    target = { requested: "to", mode: "single", config: resolveFolder(opts.to, cwd, home), state: null, cache: null, parts: [] };
  }
  const problems = model.problems;
  if (model.origin.exists) problems.push(...destinationProblems(target.config, origin, "The destination"));

  if (target.mode === "xdg-split" && model.origin.exists) {
    target.parts = splitParts(origin, target).map((p) => {
      const m = measure(p.from);
      return { ...p, bytes: m.bytes, files: m.files };
    });
    for (const area of ["state", "cache"]) {
      const base = target[area];
      if (samePath(realLoose(base), realLoose(origin)) || isInside(realLoose(origin), realLoose(base))) problems.push(problem("destination-in-origin", `The ${area} folder ${base} is the config folder or inside it. Choose another with XDG_${area.toUpperCase()}_HOME.`));
      else if (isInside(realLoose(base), realLoose(origin))) problems.push(problem("origin-in-destination", `The config folder ${origin} is inside the ${area} folder ${base}. Choose another with XDG_${area.toUpperCase()}_HOME.`));
    }
    for (const p of target.parts) {
      const st = statOf(p.to);
      if (st && !(st.isDirectory() && !st.isSymbolicLink() && isEmptyDir(p.to))) problems.push(problem("destination-not-empty", `${p.to} exists, so ${p.path} cannot be moved there. Move it away, or choose another ${p.area} folder with XDG_${p.area.toUpperCase()}_HOME.`));
    }
  }

  // --- which kinds go where ---
  const partPaths = new Set(target.parts.map((p) => p.path));
  const areaOf = (entryName) => (partPaths.has(entryName) ? target.parts.find((p) => p.path === entryName).area : "config");
  for (const k of model.kinds) {
    const areas = [...new Set(k.entries.map(areaOf))].sort((a, b) => AREAS.indexOf(a) - AREAS.indexOf(b));
    k.destination = areas.length ? areas.join(" and ") : "config";
  }
  const sizeOfParts = target.parts.reduce((n, p) => n + p.bytes, 0);
  const filesOfParts = target.parts.reduce((n, p) => n + p.files, 0);

  // --- method and room, per drive ---
  const originDrive = sys.drive(origin);
  const groups = [];
  const configBytes = model.total.bytes - sizeOfParts;
  const configFiles = model.total.files - filesOfParts;
  groups.push({ area: "config", path: target.config, bytes: configBytes, files: configFiles });
  if (target.mode === "xdg-split") {
    groups.push({ area: "state", path: target.state, bytes: target.parts.filter((p) => p.area === "state").reduce((n, p) => n + p.bytes, 0), files: target.parts.filter((p) => p.area === "state").reduce((n, p) => n + p.files, 0) });
    groups.push({ area: "cache", path: target.cache, bytes: target.parts.filter((p) => p.area === "cache").reduce((n, p) => n + p.bytes, 0), files: target.parts.filter((p) => p.area === "cache").reduce((n, p) => n + p.files, 0) });
  }
  const byDrive = new Map();
  for (const g of groups) {
    const drive = sys.drive(g.path);
    g.drive = drive;
    g.method = drive && originDrive && drive === originDrive ? "rename" : "copy";
    if (!byDrive.has(drive)) byDrive.set(drive, { drive, paths: [], copyBytes: 0, copyFiles: 0 });
    const d = byDrive.get(drive);
    d.paths.push(g.path);
    if (g.method === "copy") { d.copyBytes += g.bytes; d.copyFiles += g.files; }
  }
  for (const d of byDrive.values()) {
    const need = d.copyBytes > 0 || d.copyFiles > 0 ? d.copyBytes + slack(d.copyFiles) : 1 * MiB;
    const free = sys.free(d.paths[0]);
    const ok = free === null || free >= need;
    model.space.push({ path: d.paths[0], paths: d.paths, copy: d.copyBytes > 0 || d.copyFiles > 0, needBytes: need, freeBytes: free, ok });
    if (free === null) model.warnings.push(`Could not read the free space where ${d.paths[0]} is.`);
    else if (!ok) problems.push(problem("not-enough-space", `Not enough free space for ${d.paths[0]}: about ${size(need)} needed, ${size(free)} free${d.copyBytes > 0 ? " (a copy to another drive needs the room twice, until the original is removed)" : ""}.`));
  }
  const methods = new Set(groups.map((g) => g.method));
  target.method = methods.size === 1 ? [...methods][0] : "mixed";
  target.groups = groups;
  target.claudeJson = path.join(target.config, CLAUDE_JSON);
  target.existedBefore = !!statOf(target.config);
  target.stateExisted = !!(target.state && statOf(target.state));
  target.cacheExisted = !!(target.cache && statOf(target.cache));
  model.destination = target;

  // --- what else `move` writes ---
  const planned = opts.noEnv ? [] : planProfiles(env, { home, platform });
  const profiles = planned.filter((p) => p.action !== "skip");
  const notWritten = planned.filter((p) => p.action === "skip").map((p) => ({ file: p.file, shell: p.shell, reason: p.skip }));
  for (const n of notWritten) model.warnings.push(`${n.file} ${n.reason}, so claude-relocate leaves it alone. Set CLAUDE_CONFIG_DIR=${target.config} in it yourself.`);
  if (profiles.length && /[\r\n\0]/.test(target.config)) problems.push(problem("bad-folder-name", `The destination ${JSON.stringify(target.config)} has a line break or a null character in its name; a shell profile cannot hold that. Choose another name, or leave profiles alone with --no-env.`));
  model.env = {
    skipped: !!opts.noEnv,
    profiles,
    notWritten,
    registry: platform === "win32" && !opts.noEnv ? { key: keyOf(env), name: "CLAUDE_CONFIG_DIR", value: target.config } : null,
    variable: target.config,
  };
  if (opts.link) {
    model.links = [{ path: origin, target: target.config, kind: "dir", purpose: "origin" }];
    if (!model.origin.claudeJsonInside && model.origin.claudeJsonExists) model.links.push({ path: model.origin.claudeJson, target: path.join(target.config, CLAUDE_JSON), kind: "file", purpose: "claude-json" });
  } else model.links = [];
}
