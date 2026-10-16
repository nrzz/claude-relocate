// `verify`: after a move, check that what was set up will work. For every claim it reads the real thing: the
// variable in each profile and in the Windows user environment, the destination folder with its .claude.json, the
// links, and (when claude is on PATH) `claude --version` run with CLAUDE_CONFIG_DIR pointing at the destination.
// It changes nothing. Terminals that were already open keep the environment they started with, so it ends by
// saying to open a new one.
import fs from "node:fs";
import path from "node:path";
import { configInUse } from "./env.mjs";
import { listSessions } from "./inventory.mjs";
import { readProfiles } from "./profiles.mjs";
import { findManifest } from "./undo.mjs";
import { isoOf, localDay, plural, realLoose, samePath, size, statOf } from "./util.mjs";
import { readUserEnv } from "./winenv.mjs";

const envGet = (env, name) => {
  if (env[name] !== undefined) return env[name];
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? env[k] : undefined;
};

// The first `name` (claude) on PATH, as a file path, or null. On Windows the extensions in PATHEXT are tried.
export function findOnPath(name, env, platform = process.platform) {
  const dirs = String(envGet(env, "PATH") || "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? String(envGet(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch { /* not here */ }
    }
  }
  return null;
}

// `claude --version` with CLAUDE_CONFIG_DIR=dir. Returns { ok, file, output, error }.
export function claudeVersion(env, dir, sys) {
  const file = findOnPath("claude", env, sys.platform);
  if (!file) return { ok: false, found: false, file: null, output: "", error: "claude is not on PATH" };
  const childEnv = { ...env, CLAUDE_CONFIG_DIR: dir, DISABLE_AUTOUPDATER: "1" };
  const shim = sys.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const r = shim
    ? sys.run(`"${file}" --version`, [], { env: childEnv, shell: true, timeout: 60000 })
    : sys.run(file, ["--version"], { env: childEnv, timeout: 60000 });
  const output = String(r.stdout || "").trim().split(/\r?\n/)[0] || "";
  if (r.error || r.status !== 0) return { ok: false, found: true, file, output, error: `claude --version failed (${(r.error && r.error.message) || String(r.stderr || "").trim().slice(0, 120) || `exit ${r.status}`})` };
  return { ok: true, found: true, file, output, error: null };
}

export function runVerify({ env, cwd, sys }) {
  const checks = [];
  const add = (id, level, message, extra = {}) => checks.push({ id, level, message, ...extra });
  const cfg = configInUse(env, { cwd, platform: sys.platform });
  const found = findManifest(env, { cwd, sys });
  const M = found.found ? found.manifest : null;
  const dest = M ? M.destination.configDir : cfg.dir;
  const home = cfg.home;

  if (M) add("manifest", "info", `Moved by claude-relocate on ${localDay(Date.parse(M.date))}: ${M.origin.configDir} is now ${M.destination.configDir} (${M.mode === "xdg-split" ? "split into config, state and cache folders" : "one folder"}). Manifest: ${found.file}.`);
  else add("manifest", "info", `No relocate-manifest.json found (looked at ${found.tried.join(", ")}), so this checks the config folder Claude Code uses now: ${cfg.dir}${cfg.source === "default" ? " (CLAUDE_CONFIG_DIR is not set)" : " (from CLAUDE_CONFIG_DIR)"}.`);

  // the folder and .claude.json
  const st = statOf(dest);
  if (st && st.isDirectory()) add("destination", "ok", `${dest} exists.`);
  else add("destination", "fail", `${dest} is not a folder.`);
  const jsonFile = M ? M.destination.claudeJson : cfg.claudeJson;
  const jst = statOf(jsonFile);
  if (jst && jst.isFile()) add("claude-json", "ok", `${jsonFile} exists (${size(jst.size)}).`);
  else if (jst && jst.isSymbolicLink()) add("claude-json", "ok", `${jsonFile} is a link that resolves.`);
  else if (M && M.origin.claudeJsonExisted) add("claude-json", "fail", `${jsonFile} is missing; it was moved there.`);
  else add("claude-json", "info", `${jsonFile} does not exist yet; Claude Code creates it the first time it runs.`);

  // the session list: the transcripts the folder holds, read through whatever links lead to them
  const sessions = listSessions(dest);
  const carried = M && M.sessions && typeof M.sessions.sessions === "number" ? M.sessions : null;
  if (!sessions.exists) {
    if (carried && carried.sessions > 0) add("sessions", "fail", `${sessions.path} is missing; the move carried ${plural(carried.sessions, "session")}.`);
    else add("sessions", "info", `${sessions.path} does not exist yet; Claude Code creates it with the first session.`);
  } else if (!sessions.readable) add("sessions", "fail", `${sessions.path} cannot be read${sessions.isLink ? " (a link that does not resolve)" : ""}.`);
  else if (!sessions.sessions) add("sessions", carried && carried.sessions > 0 ? "warn" : "info", `${sessions.path} holds no sessions${carried && carried.sessions > 0 ? `; the move carried ${plural(carried.sessions, "session")} (Claude Code's cleanup deletes old ones)` : ""}.`);
  else {
    const lines = sessions.projects.slice(0, 5).map((p) => `${p.name}  ${plural(p.sessions, "session")}, newest ${localDay(p.newestMs)}`);
    if (sessions.projects.length > 5) lines.push(`... and ${plural(sessions.projects.length - 5, "more project")}`);
    add("sessions", "ok", `${plural(sessions.sessions, "session")} in ${plural(sessions.projects.length, "project")} under ${sessions.path}${carried ? `; the move carried ${carried.sessions}` : ""}; newest ${localDay(sessions.newestMs)}.`, { lines });
  }

  // the profiles
  const profiles = readProfiles(env, { home, platform: sys.platform });
  if (M) {
    for (const rec of M.profiles) {
      const p = profiles.find((x) => x.file === rec.file);
      const value = p ? p.block : null;
      if (value !== null && samePath(value, dest)) add("profile", "ok", `${rec.file} sets CLAUDE_CONFIG_DIR=${value}.`, { file: rec.file });
      else add("profile", "fail", value === null ? `${rec.file} has no claude-relocate block (it was added by the move).` : `${rec.file} sets CLAUDE_CONFIG_DIR=${value}, not ${dest}.`, { file: rec.file });
    }
    if (!M.profiles.length && !M.registry) add("profile", "info", "The move wrote CLAUDE_CONFIG_DIR into no profile (--no-env, or no profile for your shell). Set CLAUDE_CONFIG_DIR yourself.");
  } else {
    for (const p of profiles.filter((x) => x.block !== null)) add("profile", "info", `${p.file} sets CLAUDE_CONFIG_DIR=${p.block} (claude-relocate block).`, { file: p.file });
  }
  for (const p of profiles) for (const o of p.others) add("profile-other", "warn", `${p.file} line ${o.line} also sets CLAUDE_CONFIG_DIR (${o.text}); the later line wins.`, { file: p.file, line: o.line });

  // the Windows user environment
  if (sys.platform === "win32") {
    const r = readUserEnv(env, sys.run);
    if (!r.ok) add("registry", "fail", `The Windows user environment cannot be read (${r.error}).`);
    else if (M && M.registry) {
      if (r.exists && samePath(r.value, dest)) add("registry", "ok", `The Windows user environment sets CLAUDE_CONFIG_DIR=${r.value}.`);
      else add("registry", "fail", r.exists ? `The Windows user environment sets CLAUDE_CONFIG_DIR=${r.value}, not ${dest}.` : "The Windows user environment has no CLAUDE_CONFIG_DIR (the move set it).");
    } else add("registry", "info", r.exists ? `The Windows user environment sets CLAUDE_CONFIG_DIR=${r.value}.` : "The Windows user environment does not set CLAUDE_CONFIG_DIR.");
  }

  // the links
  if (M) {
    for (const l of M.links) {
      const lst = statOf(l.path);
      if (!lst || !lst.isSymbolicLink()) { add("link", "fail", `${l.path} is not a link any more (it should point to ${l.target}).`, { path: l.path }); continue; }
      let resolves = false;
      try { resolves = samePath(realLoose(l.path), realLoose(l.target)) && fs.existsSync(l.path); } catch { /* does not resolve */ }
      add("link", resolves ? "ok" : "fail", resolves ? `${l.path} -> ${l.target} resolves.` : `${l.path} does not resolve to ${l.target}.`, { path: l.path });
    }
  }

  // the old place, made again: a program that ignores CLAUDE_CONFIG_DIR writes there (undo refuses while it is not empty)
  if (M && !samePath(realLoose(M.origin.configDir), realLoose(dest))) {
    const folder = statOf(M.origin.configDir);
    const items = folder && folder.isDirectory() && !folder.isSymbolicLink() ? fs.readdirSync(M.origin.configDir).length : 0;
    const json = !M.origin.claudeJsonInside ? statOf(M.origin.claudeJson) : null;
    const jsonAgain = !!json && !json.isSymbolicLink();
    // the manifest knows when the move itself left the old place as it is: that is not a program writing there
    const kept = M.originalKept ? "the move kept it because it changed after the copy was checked" : M.leftBehind ? `the move could not remove ${plural(M.leftBehind, "item")} of it` : null;
    const bits = [];
    if (items) bits.push(kept ? `${M.origin.configDir} still holds ${plural(items, "item")} (${kept})` : `${M.origin.configDir} exists again and holds ${plural(items, "item")}`);
    if (jsonAgain) bits.push(M.originalKept ? `${M.origin.claudeJson} was kept with it` : M.jsonLeft ? `${M.origin.claudeJson} is still there: the move could not remove it` : `${M.origin.claudeJson} was made again${items ? " next to it" : ""}`);
    const leftOver = !!(kept || M.jsonLeft);
    const advice = M.originalKept ? "Copy what you need from it into the new folder, then delete it" : leftOver ? "Delete what is left by hand once you do not need it" : "A program that ignores CLAUDE_CONFIG_DIR may be writing there";
    if (bits.length) add("old-place", "warn", `${bits.join(", and ")}; Claude Code now uses ${dest}. ${advice}; undo refuses while ${bits.length > 1 ? "they are" : "it is"} there${leftOver ? "." : "; move --link makes such programs use the new folder."}`, { path: M.origin.configDir });
  }

  // the real claude
  const v = claudeVersion(env, dest, sys);
  if (!v.found) add("claude", "skip", "claude is not on PATH, so `claude --version` was not run.");
  else if (v.ok) add("claude", "ok", `claude --version with CLAUDE_CONFIG_DIR=${dest}: ${v.output} (${v.file}).`);
  else add("claude", "fail", `${v.error} (${v.file}).`);

  // this terminal
  const now = envGet(env, "CLAUDE_CONFIG_DIR");
  if (now && samePath(path.resolve(cwd, now), dest)) add("terminal", "ok", "This terminal already has CLAUDE_CONFIG_DIR set to the destination.");
  else add("terminal", "info", `This terminal ${now ? `has CLAUDE_CONFIG_DIR=${now}` : "does not have CLAUDE_CONFIG_DIR set"}: it started before the move, or the variable is set some other way.`);

  const ok = !checks.some((c) => c.level === "fail");
  const sessionList = { path: sessions.path, exists: sessions.exists, readable: sessions.readable, isLink: sessions.isLink, sessions: sessions.sessions, projects: sessions.projects.slice(0, 20).map((p) => ({ name: p.name, sessions: p.sessions, newest: isoOf(p.newestMs) })), newest: sessions.newestMs === null ? null : isoOf(sessions.newestMs) };
  return { ok, checks, sessions: sessionList, manifest: M, destination: dest, found: found.found ? { file: found.file, via: found.via } : null };
}

