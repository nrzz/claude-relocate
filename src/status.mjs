// `status`: where things are now, and what each shell will see when it starts. Reads only.
import fs from "node:fs";
import path from "node:path";
import { configInUse, shellInUse } from "./env.mjs";
import { readProfiles } from "./profiles.mjs";
import { findManifest } from "./undo.mjs";
import { realLoose, samePath, statOf } from "./util.mjs";
import { keyOf, readUserEnv } from "./winenv.mjs";

export function runStatus({ env, cwd, sys }) {
  const cfg = configInUse(env, { cwd, platform: sys.platform });
  const free = sys.free(cfg.dir);
  const found = findManifest(env, { cwd, sys });
  const M = found.found ? found.manifest : null;
  const profiles = readProfiles(env, { home: cfg.home, platform: sys.platform });
  const st = statOf(cfg.dir);
  const isLink = !!st && st.isSymbolicLink();
  const there = !!st && fs.existsSync(cfg.dir); // follows a link: a link that leads nowhere is not a folder
  const jst = statOf(cfg.claudeJson);
  const out = {
    schema: 1, tool: "claude-relocate", platform: sys.platform,
    thisTerminal: { variable: env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : null, configDir: cfg.dir, source: cfg.source },
    configDir: { path: cfg.dir, exists: there, isLink, resolvesTo: isLink && there ? safeReal(cfg.dir) : null, freeBytes: typeof free === "number" ? free : null },
    claudeJson: { path: cfg.claudeJson, exists: !!jst, inside: cfg.claudeJsonInside, size: jst && jst.isFile() ? jst.size : null },
    moved: M ? { date: M.date, from: M.origin.configDir, to: M.destination.configDir, mode: M.mode, method: M.method, manifest: found.file, via: found.via } : null,
    links: (M ? M.links : []).map((l) => {
      const lst = statOf(l.path);
      const isLink = !!lst && lst.isSymbolicLink();
      return { path: l.path, target: l.target, purpose: l.purpose, isLink, resolves: isLink && sameSafe(l.path, l.target) };
    }),
    profiles: profiles.filter((p) => p.exists || p.block !== null).map((p) => ({ file: p.file, shell: p.shell, exists: p.exists, block: p.block, others: p.others })),
    windowsEnvironment: null,
    shell: shellInUse(env) || null,
    newTerminals: [],
  };
  if (sys.platform === "win32") {
    const r = readUserEnv(env, sys.run);
    out.windowsEnvironment = { key: keyOf(env), ok: r.ok, value: r.ok && r.exists ? r.value : null, error: r.ok ? null : r.error };
  }
  // What a shell started now will have: the user environment on Windows, then the profile of that shell.
  const rows = [];
  if (out.windowsEnvironment) rows.push({ name: "windows", value: out.windowsEnvironment.value, from: `${out.windowsEnvironment.key}: the user environment, where programs started from the Start menu or Explorer get their variables` });
  const byShell = new Map();
  for (const p of profiles) {
    if (!byShell.has(p.shell)) byShell.set(p.shell, []);
    byShell.get(p.shell).push(p);
  }
  for (const [shell, list] of byShell) {
    const withBlock = list.find((p) => p.block !== null);
    const existing = list.filter((p) => p.exists);
    if (!withBlock && !existing.length && shell !== out.shell) continue;
    rows.push({ name: shell, value: withBlock ? withBlock.block : null, from: withBlock ? withBlock.file : existing.length ? `${existing.map((p) => path.basename(p.file)).join(", ")} (no claude-relocate block)` : "no profile file" });
  }
  out.newTerminals = rows;
  return out;
}

function safeReal(p) {
  try { return realLoose(p); } catch { return null; }
}
function sameSafe(a, b) {
  try { return samePath(realLoose(a), realLoose(b)); } catch { return false; }
}
