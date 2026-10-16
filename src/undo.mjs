// `undo`: read relocate-manifest.json and put it all back: the links come out, the state and cache parts return
// to the config folder, the config folder returns to where it came from, .claude.json goes back next to the
// folder if that is where it was, the profile blocks and the Windows user environment value go.
//
// The data comes back first and the environment last, so that a failure half way leaves CLAUDE_CONFIG_DIR
// pointing at a folder that still has everything. A move that was made on top of an earlier one
// (the folder was itself the destination of a move) restores the earlier manifest, so two undos go back two moves.
import fs from "node:fs";
import path from "node:path";
import { configInUse } from "./env.mjs";
import { CLAUDE_JSON } from "./inventory.mjs";
import { manifestFile, readManifest, writeManifest } from "./manifest.mjs";
import { describeProcesses } from "./plan.mjs";
import { readProfiles, removeProfile } from "./profiles.mjs";
import { COPY_INSTEAD, VerifyError, copyChildren, moveEntry, moveFile } from "./transfer.mjs";
import { MiB, UserError, exists, isEmptyDir, realLoose, samePath, size, statOf } from "./util.mjs";
import { compareSnapshots, makeLink, pruneEmpty, removeEmptyParents, removeTree, retargetLinks, snapshot } from "./walk.mjs";
import { readUserEnv, removeUserEnv, writeUserEnv } from "./winenv.mjs";

const problem = (code, message) => ({ code, message });

// Where a manifest might be: the config folder in use, then the folders our profile blocks and the Windows user
// environment name (a terminal opened before the move still has the old environment, and the old folder may be
// gone or be a link). { found: true, file, dir, via, manifest } or { found: false, tried, errors }.
export function findManifest(env, { cwd, sys }) {
  const cfg = configInUse(env, { cwd, platform: sys.platform });
  const candidates = [{ dir: cfg.dir, via: cfg.source === "CLAUDE_CONFIG_DIR" ? "CLAUDE_CONFIG_DIR" : "the default folder" }];
  for (const p of readProfiles(env, { home: cfg.home, platform: sys.platform })) if (p.block) candidates.push({ dir: p.block, via: `the block in ${p.file}` });
  if (sys.platform === "win32") {
    const r = readUserEnv(env, sys.run);
    if (r.ok && r.exists && r.value) candidates.push({ dir: r.value, via: "the Windows user environment" });
  }
  const tried = [];
  const errors = [];
  const seen = new Set();
  for (const c of candidates) {
    const file = manifestFile(path.resolve(c.dir));
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tried.push(file);
    if (!exists(file)) continue;
    const r = readManifest(file);
    if (r.ok) return { found: true, file, dir: path.resolve(c.dir), via: c.via, manifest: r.manifest };
    errors.push(`${file} ${r.error}`);
  }
  return { found: false, tried, errors };
}

export function describeUndoSteps(M, { sameDrive }) {
  const out = [];
  const A = M.origin.configDir;
  const B = M.destination.configDir;
  for (const l of M.links.filter((x) => x.purpose !== "xdg")) out.push({ action: "unlink", text: `Remove the link ${l.path}.` });
  if (M.mode === "xdg-split") out.push({ action: "unsplit", text: `Move the ${M.parts.length} state and cache parts (${M.parts.map((p) => p.path).join(", ")}) back into ${B}, replacing their links.` });
  if (!M.origin.claudeJsonInside) out.push({ action: "claude-json", text: `Move ${path.join(B, CLAUDE_JSON)} back to ${M.origin.claudeJson}.` });
  out.push({ action: "move", text: `Move ${B} back to ${A} (${sameDrive ? "renamed, not copied: same drive" : "copied and checked, then the copy in the new place is deleted: another drive"}).` });
  if (M.previous) out.push({ action: "previous", text: `Put back the manifest this folder had before (an earlier move), so that \`undo\` can go back one more step.` });
  for (const p of M.profiles) out.push({ action: "profile", text: `Take the claude-relocate block out of ${p.file}${p.created ? " (the file was created by the move and is deleted if nothing else is in it)" : ""}, after a backup.` });
  if (M.registry) out.push({ action: "registry", text: M.registry.previous !== null ? `Put the Windows user environment value back to ${M.registry.previous}.` : `Remove CLAUDE_CONFIG_DIR from the Windows user environment (${M.registry.key}).` });
  return out;
}

export function runUndo({ env, cwd, sys, opts, log = () => {} }) {
  const found = findManifest(env, { cwd, sys });
  if (!found.found) {
    const lines = [`No relocate-manifest.json found, so there is nothing to undo. Looked at: ${found.tried.join(", ")}.`];
    if (found.errors.length) lines.push(`Found but not usable: ${found.errors.join("; ")}.`);
    lines.push("A move writes it into the new folder. If you moved the folder by hand, set CLAUDE_CONFIG_DIR to it and run this again.");
    return { ok: false, refused: true, problems: [problem("no-manifest", lines.join(" "))], steps: [] };
  }
  const M = found.manifest;
  const A = M.origin.configDir;
  const B = M.destination.configDir;
  const AJ = M.origin.claudeJson;
  const problems = [];

  // --- what is in the way ---
  if (!opts.ignoreRunning) {
    const p = sys.processes();
    if (!p.ok) problems.push(problem("process-check-failed", `Could not check whether Claude Code is running (${p.error}). Close Claude Code and the Claude desktop app, then use --ignore-running.`));
    else if (p.processes.length) problems.push(problem("claude-running", `Claude Code or the Claude desktop app is running: ${describeProcesses(p.processes)}. Close it, then run this again. (--ignore-running skips this check.)`));
  }
  const stB = statOf(B);
  if (!stB || !stB.isDirectory()) problems.push(problem("destination-missing", `${B}, where the manifest says the config folder went, is not a folder any more.`));
  const stA = statOf(A);
  if (stA) {
    if (stA.isSymbolicLink()) {
      if (!samePath(realLoose(A), realLoose(B))) problems.push(problem("origin-in-use", `${A} is a link to somewhere other than ${B}. Remove it or move it away, then run this again.`));
    } else if (!stA.isDirectory()) problems.push(problem("origin-in-use", `${A} is a file. Move it away, then run this again.`));
    else if (!isEmptyDir(A)) problems.push(problem("origin-in-use", `${A} exists and is not empty (something created it after the move). Move it away, then run this again.`));
  }
  const liveJson = path.join(B, CLAUDE_JSON);
  if (!M.origin.claudeJsonInside && exists(liveJson)) {
    const st = statOf(AJ);
    if (st && !(st.isSymbolicLink() && samePath(realLoose(AJ), realLoose(liveJson)))) problems.push(problem("claude-json-in-use", `${AJ} exists (something created it after the move), and ${liveJson} has to go back there. Move one of them away, then run this again.`));
  }
  const sameDrive = !!sys.drive(A) && sys.drive(A) === sys.drive(B);
  let need = 0;
  if (!sameDrive && stB) {
    const snap = exists(B) ? snapshot(B) : { bytes: 0, files: 0 };
    need = snap.bytes + snap.files * 1024 + 16 * MiB;
    const free = sys.free(A);
    if (free !== null && free < need) problems.push(problem("not-enough-space", `Not enough free space at ${A}: about ${size(need)} needed, ${size(free)} free.`));
  }
  const steps = describeUndoSteps(M, { sameDrive });
  if (problems.length) return { ok: false, refused: true, problems, steps, manifest: M, found };
  if (opts.dryRun) return { ok: true, dryRun: true, steps, manifest: M, found };
  if (!opts.yes) return { ok: false, needsYes: true, steps, manifest: M, found };

  // --- do it ---
  const warnings = [];
  let incomplete = false;
  const failed = (message) => { warnings.push(message); incomplete = true; };
  const ctx = { skipped: [], copyFile: sys.copyFile, rewrite: { from: B, to: A } };
  const removedLinks = [];
  const restoreLinks = () => {
    for (const l of removedLinks) { try { if (!exists(l.path)) fs.symlinkSync(l.target, l.path, l.type); } catch { /* best effort */ } }
  };

  // 1. the links at the old places
  for (const l of M.links.filter((x) => x.purpose !== "xdg")) {
    const st = statOf(l.path);
    if (st && st.isSymbolicLink()) {
      const type = l.kind === "file" ? "file" : sys.platform === "win32" ? "junction" : "dir";
      fs.rmSync(l.path, { force: true });
      removedLinks.push({ path: l.path, target: l.target, type });
      log(`  removed the link ${l.path}`);
    }
  }

  let method;
  try {
    // 2. the state and cache parts come home
    for (const p of [...M.parts].reverse()) {
      const linkPath = path.join(B, ...p.path.split("/"));
      const st = statOf(linkPath);
      const hadLink = !!st && st.isSymbolicLink();
      if (hadLink) fs.rmSync(linkPath, { force: true });
      if (exists(p.to)) {
        log(`  moving ${p.path} back from the ${p.area} folder`);
        try {
          moveEntry(p.to, linkPath, sys, { ...ctx, rewrite: { from: p.to, to: linkPath }, absoluteInside: false });
          retargetLinks(linkPath, p.to, { from: p.to, to: linkPath });
          // a folder the move made inside the state or cache folder on the way (plugins/ for plugins/cache)
          const base = p.area === "state" ? M.destination.state : M.destination.cache;
          if (base) removeEmptyParents(path.dirname(p.to), base);
        } catch (e) {
          if (hadLink && !exists(linkPath)) { try { makeLink(p.to, linkPath, "dir"); } catch { /* best effort */ } }
          throw e;
        }
      }
    }

    // 3. .claude.json goes back next to the folder when that is where it was
    if (!M.origin.claudeJsonInside && exists(liveJson)) {
      log(`  moving ${liveJson} back to ${AJ}`);
      if (statOf(AJ) && statOf(AJ).isSymbolicLink()) fs.rmSync(AJ, { force: true });
      moveFile(liveJson, AJ, sys);
      if (M.stale && M.stale.claudeJson && exists(path.join(B, M.stale.claudeJson))) fs.renameSync(path.join(B, M.stale.claudeJson), liveJson);
    }

    // 4. the config folder goes home (with its manifest, which is taken out of the folder afterwards, so that a
    //    failure on the way leaves the manifest where `undo` can read it again)
    fs.mkdirSync(path.dirname(A), { recursive: true });
    const emptyInTheWay = exists(A);
    if (emptyInTheWay) fs.rmdirSync(A);
    method = "copy";
    if (sameDrive) {
      try {
        sys.rename(B, A);
        method = "rename";
      } catch (e) {
        if (emptyInTheWay && !exists(A)) fs.mkdirSync(A);
        if (!COPY_INSTEAD.has(e.code)) throw e;
        if (emptyInTheWay) fs.rmdirSync(A);
      }
    }
    if (method === "rename") {
      log(`  renamed ${B} to ${A}`);
      retargetLinks(A, B, { from: B, to: A });
    } else {
      log(`  copying ${B} back to ${A}`);
      const before = snapshot(B);
      fs.mkdirSync(A);
      try {
        copyChildren(B, A, ctx);
        const same = compareSnapshots(before, snapshot(A), { rewrite: { from: B, to: A } });
        if (!same.ok) throw new VerifyError(`The copy in ${A} does not match ${B} (${same.count} difference${same.count === 1 ? "" : "s"}, first: ${same.mismatches[0].path}: ${same.mismatches[0].problem}). Nothing in ${B} was changed.`, same.mismatches);
      } catch (e) {
        try { removeTree(A); } catch { /* best effort */ }
        throw e;
      }
      // the copy in A is complete and checked: a folder that cannot be removed completely is a note, not a failure
      try { removeTree(B); } catch (e) { failed(`${A} is complete, but ${B} could not be removed completely (${e.code || e.message}). Delete what is left of it by hand.`); }
    }
    fs.rmSync(manifestFile(A), { force: true });
    if (M.destination.existedBefore) { try { fs.mkdirSync(B); } catch { /* it exists again */ } }
    if (M.previous) writeManifest(A, M.previous);
  } catch (e) {
    restoreLinks();
    if (e instanceof UserError) throw e;
    throw new UserError(`The undo stopped: ${e && e.message ? e.message : e}. What has not been put back yet is still in ${B}, with its relocate-manifest.json. Fix the cause and run undo again.`, "undo-failed");
  }
  // the folders the move made on the way, once they are empty again
  if (M.mode === "xdg-split") {
    if (!M.destination.stateExisted && M.destination.state) pruneEmpty(M.destination.state);
    if (!M.destination.cacheExisted && M.destination.cache) pruneEmpty(M.destination.cache);
  }
  for (const key of ["state", "cache", "config"]) {
    const top = M.destination.created && M.destination.created[key];
    if (typeof top === "string" && path.isAbsolute(top)) pruneEmpty(top);
  }

  // 5. the environment
  const profileResults = [];
  for (const rec of M.profiles) {
    try {
      const r = removeProfile(rec, { now: sys.now() });
      profileResults.push(r);
      if (r.problem) failed(`Could not take the block out of ${r.file}: it ${r.note}. Delete the lines between "# claude-relocate start" and "# claude-relocate end" by hand.`);
      else if (r.removed) log(`  took the block out of ${r.file}${r.deleted ? " (the file was ours and is deleted)" : ""}${r.backup ? ` (backup: ${r.backup})` : ""}`);
      else log(`  ${r.file}: ${r.note}`);
    } catch (e) {
      failed(`Could not take the block out of ${rec.file}: ${e.code || e.message}. Delete the lines between "# claude-relocate start" and "# claude-relocate end" by hand.`);
    }
  }
  let registry = null;
  if (M.registry) {
    const r = M.registry.previous !== null && M.registry.previous !== undefined
      ? writeUserEnv(M.registry.previous, env, sys.run, M.registry.previousType || "REG_SZ")
      : removeUserEnv(env, sys.run);
    registry = { ok: r.ok, restored: M.registry.previous ?? null };
    if (r.ok) log(M.registry.previous !== null && M.registry.previous !== undefined ? `  put the Windows user environment value back to ${M.registry.previous}` : "  removed CLAUDE_CONFIG_DIR from the Windows user environment");
    else failed(`Could not change the Windows user environment: ${r.error}. Remove CLAUDE_CONFIG_DIR from it yourself.`);
  }
  if (ctx.skipped.length) warnings.push(`${ctx.skipped.length} special file${ctx.skipped.length === 1 ? "" : "s"} could not be copied and ${ctx.skipped.length === 1 ? "was" : "were"} left out.`);
  return { ok: true, dryRun: false, steps, manifest: M, found, method, profiles: profileResults, registry, warnings, incomplete, origin: A, destination: B };
}
