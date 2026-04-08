/**
 * Bumps manifest.json + versions.json in lockstep with package.json.
 *
 * Wired into `npm version` via the "version" script in package.json, so
 * `npm version 0.2.0` will:
 *   1. Bump package.json (npm does this)
 *   2. Run this script — which writes the same version into manifest.json
 *      and adds a row to versions.json mapping it to the current minAppVersion
 *   3. Stage manifest.json + versions.json so npm's auto-commit picks them up
 *
 * Release flow after running `npm version <new>`:
 *   git push --follow-tags
 * The release.yml workflow takes over from there.
 */
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("Run via `npm version`, not directly.");
  process.exit(1);
}

// Update manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// Update versions.json — maps each plugin version to the minimum Obsidian
// version it supports. Obsidian uses this to gate which users can install
// a given release.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Bumped to ${targetVersion} (min Obsidian ${minAppVersion}).`);
