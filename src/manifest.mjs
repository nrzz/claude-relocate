// relocate-manifest.json: what `move` did, kept in the destination folder so that `undo` can put it all back.
//
//   schema, tool, version, date          which tool wrote it, when
//   platform, mode ("single" | "xdg-split"), method ("rename" | "copy")
//   origin       { configDir, configDirSource, claudeJson, claudeJsonInside }
//   destination  { configDir, claudeJson, existedBefore }
//   parts        [{ path, area: "state" | "cache", from, to, link }] (xdg-split only: what went to the state and cache folders)
//   stale        { claudeJson: name } the config folder's own old .claude.json, kept under another name, when the
//                one that was live sat outside the folder
//   bytes, files what was moved
//   profiles     [{ file, shell, syntax, action, previous, sepAdded, created, mkdirs, backup, markAdded }]
//                (markAdded: a UTF-8 byte-order mark went in with a non-ASCII folder name, and comes out again)
//   registry     { key, name, value, previous } or null
//   links        [{ path, target, kind: "dir" | "file", purpose: "origin" | "claude-json" | "xdg" }]
//   relativeLinks [{ path, was }] links inside the folder with a relative target that reaches out of it, which the move
//                wrote as absolute links so that they keep working; path is below the config folder, undo writes `was` back
//   leftBehind   (only when set) how many items a copy could not remove from the old place, such as a file another
//                program held open; undo says so when that folder is still there
//   options      { link, noEnv, xdg }
//   previous     the manifest this folder had before (when the folder was itself the destination of an earlier
//                move), so that two undos go back two moves
import fs from "node:fs";
import path from "node:path";
import { MANIFEST_NAME } from "./inventory.mjs";
import { tryParse, writeFileAtomic } from "./util.mjs";
import { VERSION } from "./version.mjs";

export { MANIFEST_NAME };
export const SCHEMA = 1;

export function newManifest(fields) {
  return { schema: SCHEMA, tool: "claude-relocate", version: VERSION, ...fields };
}

export const manifestFile = (dir) => path.join(dir, MANIFEST_NAME);

// { ok, manifest } or { ok: false, error }
export function readManifest(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return { ok: false, error: `cannot be read (${e.code || e.message})` }; }
  const m = tryParse(raw.replace(/^﻿/, ""));
  const problem = check(m);
  return problem ? { ok: false, error: problem } : { ok: true, manifest: m };
}

// Why this is not a manifest this version can use, or "" if it is one.
export function check(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "is not a JSON object";
  if (m.tool !== "claude-relocate") return "was not written by claude-relocate";
  if (m.schema !== SCHEMA) return `has schema ${JSON.stringify(m.schema)}; this version reads schema ${SCHEMA}`;
  for (const k of ["origin", "destination"]) if (!m[k] || typeof m[k] !== "object") return `has no ${k}`;
  for (const k of ["configDir"]) {
    if (typeof m.origin[k] !== "string" || !path.isAbsolute(m.origin[k])) return `has an origin.${k} that is not an absolute path`;
    if (typeof m.destination[k] !== "string" || !path.isAbsolute(m.destination[k])) return `has a destination.${k} that is not an absolute path`;
  }
  if (!["single", "xdg-split"].includes(m.mode)) return `has the mode ${JSON.stringify(m.mode)}`;
  if (!Array.isArray(m.parts) || !Array.isArray(m.profiles) || !Array.isArray(m.links)) return "has a list (parts, profiles or links) that is not a list";
  return "";
}

export function writeManifest(dir, manifest) {
  writeFileAtomic(manifestFile(dir), `${JSON.stringify(manifest, null, 2)}\n`);
}
