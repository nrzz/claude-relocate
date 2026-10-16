// `move`: put the config folder (and .claude.json) somewhere else, set CLAUDE_CONFIG_DIR for the shells and the
// Windows user environment, and write relocate-manifest.json so that `undo` can put it all back.
//
// The order is built so that the original is the last thing to go:
//   1. the plan is built again and everything that would make the move wrong is a refusal, before any change
//   2. the data moves. On one drive: a rename. On another: a copy that keeps file times, checked against the
//      original (same files, same sizes, file times kept); the original stays until step 6
//   3. .claude.json that sat next to the folder (~/.claude.json) goes into the new folder
//   4. relocate-manifest.json is written in the new folder
//   5. the shell profiles and the Windows user environment get CLAUDE_CONFIG_DIR (a profile is backed up first)
//   6. after a copy, the original is removed; with --link a junction (Windows) or a symbolic link takes its place
//   7. the manifest is written again with what was done
// A failure in steps 2 to 4 puts everything back as it was. After step 5 a failure is a warning: the data is
// already in its new place and the message says what is left to do by hand.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_JSON, countSessions } from "./inventory.mjs";
import { MANIFEST_NAME, manifestFile, newManifest, readManifest, writeManifest } from "./manifest.mjs";
import { buildPlan } from "./plan.mjs";
import { writeProfile } from "./profiles.mjs";
import { COPY_INSTEAD, VerifyError, copyChildren, moveEntry, moveFile } from "./transfer.mjs";
import { UserError, exists, isoOf, uniquePath } from "./util.mjs";
import { compareSnapshots, makeLink, pruneEmpty, removeEmptyParents, removeTree, retargetLinks, snapshot } from "./walk.mjs";
import { NAME as REG_NAME, keyOf, readUserEnv, writeUserEnv } from "./winenv.mjs";

export const INCOMPLETE = ".claude-relocate-incomplete";

const problem = (code, message) => ({ code, message });

// The plain-language list of what a move will do, for --dry-run and for the run that needs --yes.
export function describeSteps(model) {
  const T = model.destination;
  const A = model.origin.configDir;
  const out = [];
  if (!T) return out;
  const how = (m) => (m === "rename" ? "renamed, not copied: same drive" : m === "copy" ? "copied and checked, then the original is deleted: another drive" : "renamed where it is on one drive, copied where it is not");
  if (T.mode === "xdg-split") {
    out.push({ action: "move", text: `Move ${A} to ${T.config} (${how(T.method)}), with these parts in the state and cache folders and a symbolic link for each in ${T.config}:` });
    for (const p of T.parts) out.push({ action: "split", text: `  ${p.path} -> ${p.to}` });
  } else out.push({ action: "move", text: `Move ${A} to ${T.config} (${how(T.method)}).` });
  if (!model.origin.claudeJsonInside && model.origin.claudeJsonExists) out.push({ action: "claude-json", text: `Move ${model.origin.claudeJson} into the new folder, as ${path.join(T.config, CLAUDE_JSON)}.` });
  out.push({ action: "manifest", text: `Write ${path.join(T.config, MANIFEST_NAME)}, which \`undo\` reads.` });
  if (model.env && !model.env.skipped) {
    for (const p of model.env.profiles) out.push({ action: "profile", text: `${p.action === "create" ? `Create ${p.file} (${p.shell} is your shell)` : p.action === "replace" ? `Update the claude-relocate block in ${p.file} (after a backup)` : `Add the claude-relocate block to ${p.file} (after a backup)`}.` });
    if (model.env.registry) out.push({ action: "registry", text: `Set CLAUDE_CONFIG_DIR=${T.config} in the Windows user environment (${model.env.registry.key}).` });
    if (!model.env.profiles.length && !model.env.registry) out.push({ action: "env", text: `Write CLAUDE_CONFIG_DIR into no profile: none of the known ones exists, and none is created for your shell. Set CLAUDE_CONFIG_DIR=${T.config} yourself.` });
  } else if (model.env && model.env.skipped) out.push({ action: "env", text: `Leave CLAUDE_CONFIG_DIR alone (--no-env). Set it to ${T.config} yourself.` });
  for (const l of model.links || []) out.push({ action: "link", text: l.kind === "file" ? `Leave a symbolic link at ${l.path} pointing to ${l.target}.` : `Leave ${model.platform === "win32" ? "a junction" : "a symbolic link"} at ${l.path} pointing to ${l.target}.` });
  return out;
}

// What can be found wrong with the profile files and the registry before anything is changed.
function preflight(model, problems, sys, env) {
  if (!model.env || model.env.skipped) return;
  for (const p of model.env.profiles) {
    if (!p.exists) continue;
    try { fs.accessSync(p.file, fs.constants.W_OK); } catch { problems.push(problem("profile-unwritable", `${p.file} cannot be written. Fix its permissions, or leave profiles alone with --no-env.`)); }
  }
  if (model.env.registry) {
    const r = readUserEnv(env, sys.run);
    if (!r.ok) problems.push(problem("registry-unavailable", `The Windows user environment cannot be read (${r.error}). Leave it alone with --no-env.`));
  }
}

// runMove({ env, cwd, sys, opts, log }) -> { ok, plan, steps, ... }.
//   { ok: false, refused: true, problems }      the move would be wrong; nothing was changed
//   { ok: true, dryRun: true }                  --dry-run: what would happen
//   { ok: false, needsYes: true }               nothing was changed; --yes is needed
//   { ok: true, method, bytes, files, ... }     done
export function runMove({ env, cwd, sys, opts, log = () => {} }) {
  const model = buildPlan({ env, cwd, sys, opts: { ...opts, forMove: true } });
  const problems = model.problems.slice();
  if (model.destination) preflight(model, problems, sys, env);
  const steps = describeSteps(model);
  if (problems.length) return { ok: false, refused: true, dryRun: !!opts.dryRun, problems, plan: model, steps };
  if (opts.dryRun) return { ok: true, dryRun: true, plan: model, steps };
  if (!opts.yes) return { ok: false, needsYes: true, plan: model, steps };
  return execute(model, opts, sys, env, log, steps);
}

function execute(model, opts, sys, env, log, steps) {
  const A = model.origin.configDir;
  const AJ = model.origin.claudeJson;
  const jsonOutside = !model.origin.claudeJsonInside && model.origin.claudeJsonExists;
  const T = model.destination;
  const B = T.config;
  const now = sys.now();
  const warnings = [];
  let incomplete = false;
  const failed = (message) => { warnings.push(message); incomplete = true; };
  const ctx = { skipped: [], copyFile: sys.copyFile, rewrite: { from: A, to: B } };
  const stA = fs.lstatSync(A);
  const snapA = snapshot(A);
  // what is carried: the folder, and the .claude.json that sat next to it
  const carried = { bytes: snapA.bytes + (jsonOutside ? fs.lstatSync(AJ).size : 0), files: snapA.files + (jsonOutside ? 1 : 0), ...countSessions(snapA) };
  const methods = new Set();
  const done = []; // split moves and links made so far, so that a failure can put them back
  const links = [];

  // The first folder made on the way to each place (mkdir tells), so that a rollback and `undo` can remove what this move made.
  const created = { config: fs.mkdirSync(path.dirname(B), { recursive: true }) || null, state: null, cache: null };
  if (T.state) created.state = fs.mkdirSync(T.state, { recursive: true }) || null;
  if (T.cache) created.cache = fs.mkdirSync(T.cache, { recursive: true }) || null;
  const pruneCreated = () => { for (const key of ["state", "cache", "config"]) if (created[key]) pruneEmpty(created[key]); };

  const emptyB = () => { for (const n of fs.readdirSync(B)) removeTree(path.join(B, n)); };

  // ---- 2. the data ----

  // One drive: the folder is renamed. Returns false when the rename cannot be done here (then it is copied).
  function renameWhole() {
    const emptyInTheWay = exists(B);
    if (emptyInTheWay) fs.rmdirSync(B);
    try {
      sys.rename(A, B);
    } catch (e) {
      if (emptyInTheWay && !exists(B)) fs.mkdirSync(B);
      if (COPY_INSTEAD.has(e.code)) return false;
      throw e;
    }
    // the folder goes back where it came from (links first re-aimed at the old place again)
    const renameBack = () => {
      try {
        sys.rename(B, A);
        retargetLinks(A, B, { from: B, to: A });
        if (emptyInTheWay) fs.mkdirSync(B);
      } catch (err) { warnings.push(`Could not rename ${B} back to ${A} (${err.code || err.message}); everything is in ${B}.`); }
    };
    const same = compareSnapshots(snapA, snapshot(B));
    if (!same.ok) {
      renameBack();
      throw new VerifyError(`After the rename, ${B} does not match what was in ${A} (${same.count} difference${same.count === 1 ? "" : "s"}, first: ${same.mismatches[0].path}: ${same.mismatches[0].problem}).`, same.mismatches);
    }
    // links inside that pointed into the old place now point into the new one
    try {
      retargetLinks(B, A, { from: A, to: B });
    } catch (err) {
      renameBack();
      throw err;
    }
    return true;
  }

  // Another drive: everything is copied, the copy is checked, and the original stays for now.
  function copyWhole() {
    fs.mkdirSync(B, { recursive: true });
    fs.writeFileSync(path.join(B, INCOMPLETE), "claude-relocate is copying into this folder. If this file is still here, the copy was interrupted: delete the folder.\n");
    try {
      copyChildren(A, B, { ...ctx, onEntry: (name) => log(`  copying ${name}`) });
      const same = compareSnapshots(snapA, snapshot(B), { rewrite: { from: A, to: B }, ignore: (rel) => rel === INCOMPLETE });
      if (!same.ok) throw new VerifyError(`The copy in ${B} does not match ${A} (${same.count} difference${same.count === 1 ? "" : "s"}, first: ${same.mismatches[0].path}: ${same.mismatches[0].problem}). Nothing in ${A} was changed.`, same.mismatches);
      fs.rmSync(path.join(B, INCOMPLETE), { force: true });
      fs.utimesSync(B, stA.atimeMs / 1000, stA.mtimeMs / 1000);
    } catch (e) {
      try { if (T.existedBefore) emptyB(); else removeTree(B); } catch (err) { warnings.push(`Could not remove the partial copy in ${B} (${err.code || err.message}); it holds a ${INCOMPLETE} file. Delete it by hand.`); }
      throw e;
    }
  }

  function moveSingle() {
    if (T.groups[0].method === "rename") {
      log(`  renaming ${A} to ${B}`);
      if (renameWhole()) return "rename";
      log("  the folder cannot be renamed here; copying it instead");
    }
    log(`  copying ${A} to ${B}`);
    copyWhole();
    return "copy";
  }

  // The state and cache parts go to their own folders, each replaced by a symbolic link; the rest goes to B.
  function moveSplit() {
    fs.mkdirSync(B, { recursive: true });
    const walk = (rel) => {
      const dirA = rel ? path.join(A, ...rel.split("/")) : A;
      const dirB = rel ? path.join(B, ...rel.split("/")) : B;
      for (const name of fs.readdirSync(dirA)) {
        const r = rel ? `${rel}/${name}` : name;
        const from = path.join(dirA, name);
        const part = T.parts.find((p) => p.path === r);
        if (part) {
          log(`  moving ${r} to the ${part.area} folder`);
          methods.add(moveEntry(from, part.to, sys, { ...ctx, absoluteInside: true }).method);
          done.push({ from, to: part.to });
          fs.mkdirSync(path.dirname(part.link), { recursive: true });
          makeLink(part.to, part.link, "dir");
          done.push({ link: part.link });
          links.push({ path: part.link, target: part.to, kind: "dir", purpose: "xdg" });
        } else if (T.parts.some((p) => p.path.startsWith(`${r}/`))) {
          const st = fs.lstatSync(from);
          fs.mkdirSync(path.join(dirB, name));
          walk(r);
          fs.utimesSync(path.join(dirB, name), st.atimeMs / 1000, st.mtimeMs / 1000);
          fs.rmdirSync(from);
        } else {
          log(`  moving ${r}`);
          methods.add(moveEntry(from, path.join(dirB, name), sys, ctx).method);
          done.push({ from, to: path.join(dirB, name) });
        }
      }
    };
    walk("");
    // links that pointed into the old folder now point into the new one (or, in a part, at the same place by its new path)
    retargetLinks(B, A, { from: A, to: B });
    for (const p of T.parts) retargetLinks(p.to, p.from, { from: A, to: B, absoluteInside: true });
    try { fs.rmdirSync(A); } catch { warnings.push(`${A} still holds files that were not moved.`); }
    fs.utimesSync(B, stA.atimeMs / 1000, stA.mtimeMs / 1000);
    return methods.size === 1 ? [...methods][0] : "mixed";
  }

  // Puts the data back as it was, for a failure before the new place is in use.
  let jsonMoved = false;
  let previousManifest = null;
  function putBack(method) {
    // a failure inside the single-folder rename or copy has already cleaned up after itself
    if (T.mode === "single" && method === undefined) return;
    try {
      if (jsonMoved && method !== "copy") {
        // .claude.json goes back next to the folder, and the folder's own old one gets its name back
        moveFile(path.join(B, CLAUDE_JSON), AJ, sys);
        if (stale) fs.renameSync(path.join(B, stale), path.join(B, CLAUDE_JSON));
      }
      if (T.mode === "single" && method === "rename") {
        // the folder goes back first; its manifest is put right afterwards (the one an earlier move left, or none)
        sys.rename(B, A);
        retargetLinks(A, B, { from: B, to: A });
        try { if (previousManifest) writeManifest(A, previousManifest); else fs.rmSync(path.join(A, MANIFEST_NAME), { force: true }); } catch { /* the manifest is not data */ }
        if (T.existedBefore) fs.mkdirSync(B);
      } else if (T.mode === "single") {
        if (T.existedBefore) emptyB(); else removeTree(B);
      } else {
        for (const d of [...done].reverse()) {
          if (d.link) fs.rmSync(d.link, { force: true });
          else {
            moveEntry(d.to, d.from, sys, { ...ctx, rewrite: { from: B, to: A } });
            for (const base of [T.state, T.cache]) if (base) removeEmptyParents(path.dirname(d.to), base);
          }
        }
        if (!exists(A)) fs.mkdirSync(A);
        if (!T.existedBefore) removeTree(B);
      }
    } catch (e) {
      warnings.push(`Could not put everything back after the failure (${e.code || e.message}). Look in ${B} and ${A}.`);
    }
  }

  // What the person is told when the data could not be moved: the cause, and where everything is now.
  function stopped(e) {
    if (e instanceof UserError) { if (warnings.length) e.message = `${e.message} ${warnings.join(" ")}`; return e; }
    return new UserError(`The move stopped: ${e && e.message ? e.message : e}. ${warnings.length ? warnings.join(" ") : `${A} is as it was.`}`, "move-failed");
  }

  let method;
  let stale = null;
  try {
    previousManifest = (() => { const r = readManifest(manifestFile(A)); return r.ok ? r.manifest : null; })();
    method = T.mode === "single" ? moveSingle() : moveSplit();

    // ---- 3. .claude.json from next to the folder ----
    if (jsonOutside) {
      const dst = path.join(B, CLAUDE_JSON);
      let keep = null;
      if (exists(dst)) {
        keep = uniquePath(path.join(B, `${CLAUDE_JSON}.before-relocate`));
        fs.renameSync(dst, keep);
        stale = path.basename(keep);
      }
      log(`  moving ${AJ} into ${B}`);
      try {
        moveFile(AJ, dst, sys, { keepOriginal: method === "copy" });
      } catch (e) {
        if (keep && !exists(dst)) fs.renameSync(keep, dst);
        stale = null;
        throw e;
      }
      jsonMoved = true;
    }
  } catch (e) {
    putBack(method);
    pruneCreated();
    throw stopped(e);
  }

  // ---- 4. the manifest ----
  const manifest = newManifest({
    date: isoOf(now), platform: sys.platform, mode: T.mode, method,
    origin: { configDir: A, configDirSource: model.origin.source, claudeJson: AJ, claudeJsonInside: model.origin.claudeJsonInside, claudeJsonExisted: model.origin.claudeJsonExists },
    destination: { configDir: B, claudeJson: path.join(B, CLAUDE_JSON), existedBefore: !!T.existedBefore, state: T.state, cache: T.cache, stateExisted: !!T.stateExisted, cacheExisted: !!T.cacheExisted, created },
    parts: T.parts.map((p) => ({ path: p.path, area: p.area, from: p.from, to: p.to, link: p.link })),
    stale: stale ? { claudeJson: stale } : null,
    bytes: carried.bytes, files: carried.files, sessions: { sessions: carried.sessions, projects: carried.projects },
    profiles: [], registry: null, links: links.slice(),
    options: { link: !!opts.link, noEnv: !!opts.noEnv, xdg: !!opts.xdg },
    previous: previousManifest,
  });
  try {
    writeManifest(B, manifest);
  } catch (e) {
    putBack(method);
    pruneCreated();
    throw stopped(e);
  }

  // ---- 5. CLAUDE_CONFIG_DIR for new terminals ----
  if (!opts.noEnv) {
    for (const p of model.env.profiles) {
      try {
        const rec = writeProfile(p, B, { home: model.home, now });
        manifest.profiles.push(rec);
        log(`  ${rec.created ? "created" : "updated"} ${rec.file}${rec.backup ? ` (backup: ${rec.backup})` : ""}`);
      } catch (e) {
        failed(`Could not write ${p.file}: ${e instanceof UserError ? e.message : e.code || e.message}. Put CLAUDE_CONFIG_DIR=${B} in it yourself.`);
      }
    }
    if (model.env.registry) {
      const prev = readUserEnv(env, sys.run);
      const w = writeUserEnv(B, env, sys.run);
      if (w.ok) {
        manifest.registry = { key: keyOf(env), name: REG_NAME, value: B, previous: prev.ok && prev.exists ? prev.value : null, previousType: prev.ok && prev.exists ? prev.type : null };
        log(`  set CLAUDE_CONFIG_DIR in the Windows user environment (${keyOf(env)})`);
      } else failed(`Could not set CLAUDE_CONFIG_DIR in the Windows user environment: ${w.error}. Set it to ${B} yourself.`);
    }
  }
  writeManifest(B, manifest);

  // ---- 6. the original goes; a link may take its place ----
  if (T.mode === "single" && method === "copy") {
    log(`  removing the original ${A}`);
    const aside = uniquePath(`${A}.claude-relocate-old`);
    let target = A;
    try { fs.renameSync(A, aside); target = aside; } catch { /* something holds it: remove it where it is */ }
    try {
      removeTree(target);
    } catch (e) {
      failed(`Could not remove all of ${target} (${e.code || e.message}). Everything is in ${B}; delete what is left by hand.`);
    }
    if (jsonOutside) {
      try { fs.rmSync(AJ, { force: true }); } catch (e) { failed(`Could not remove ${AJ} (${e.code || e.message}).`); }
    }
  }
  if (opts.link) {
    if (!exists(A)) {
      try {
        makeLink(B, A, "dir");
        manifest.links.push({ path: A, target: B, kind: "dir", purpose: "origin" });
        log(`  linked ${A} to ${B}`);
      } catch (e) { failed(`Could not link ${A} to ${B} (${e.code || e.message}).`); }
    } else failed(`${A} still exists, so it was not replaced by a link.`);
    if (jsonOutside) {
      try {
        makeLink(path.join(B, CLAUDE_JSON), AJ, "file");
        manifest.links.push({ path: AJ, target: path.join(B, CLAUDE_JSON), kind: "file", purpose: "claude-json" });
        log(`  linked ${AJ} to ${path.join(B, CLAUDE_JSON)}`);
      } catch (e) {
        failed(`Could not link ${AJ}: ${e.code === "EPERM" || e.code === "EACCES" ? "Windows makes a file link only with Developer Mode on or as an administrator" : e.code || e.message}. A program that ignores CLAUDE_CONFIG_DIR will start with a new .claude.json, without your settings.`);
      }
    }
  }
  if (ctx.skipped.length) warnings.push(`${ctx.skipped.length} special file${ctx.skipped.length === 1 ? "" : "s"} (sockets or pipes) could not be copied and ${ctx.skipped.length === 1 ? "was" : "were"} left out: ${ctx.skipped.slice(0, 3).join(", ")}${ctx.skipped.length > 3 ? " ..." : ""}.`);
  writeManifest(B, manifest);

  return {
    ok: true, dryRun: false, plan: model, steps, method, mode: T.mode,
    bytes: carried.bytes, files: carried.files,
    verified: { files: carried.files, bytes: carried.bytes, differences: 0 },
    manifest: manifestFile(B), manifestData: manifest, stale,
    warnings, incomplete,
  };
}
