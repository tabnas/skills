#!/usr/bin/env node
/* Copyright (c) 2026 tabnas, MIT License */

/* sync-mcp-pin.js — rewrite the @tabnas/mcp pin from the registry.
 *
 * mcp.json pins @tabnas/mcp exactly, and that pin is load-bearing: a bare
 * spec would resolve `latest` at install time and could pair these skills
 * with a server whose tools or schemas have moved. README.md said "the
 * release process writes each new exact version into mcp.json" — but no
 * such step existed, so the pin was maintained by hand and drifted to
 * 0.1.0, a version that was tagged but never published. Every documented
 * `npx --yes @tabnas/mcp@0.1.0 mcp` 404'd.
 *
 * This is that step. Derive the pin; do not remember it.
 *
 * Usage:
 *   node tools/sync-mcp-pin.js            # dry run — report what would change
 *   node tools/sync-mcp-pin.js --apply    # rewrite mcp.json and the READMEs
 *   node tools/sync-mcp-pin.js --version 0.2.0 --apply   # pin explicitly
 *
 * Dependency-free, matching tools/validate.js. Exits 1 when a dry run finds
 * drift, so CI can run it as a gate as well as a generator.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = '@tabnas/mcp';
const APPLY = process.argv.includes('--apply');
const vFlag = process.argv.indexOf('--version');
const PINNED = vFlag > -1 ? process.argv[vFlag + 1] : null;

// Files carrying the pin. mcp.json is the contract; the READMEs document it,
// and a README showing a version nobody can install is the same bug.
const TARGETS = ['mcp.json', 'README.md'];

function published() {
  if (PINNED) return PINNED;
  try {
    return execFileSync('npm', ['view', PKG, 'version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    console.error(`sync-mcp-pin: could not reach the registry for ${PKG}.`);
    console.error('Pass --version x.y.z to set the pin without a lookup.');
    process.exit(2);
  }
}

const want = published();
if (!/^\d+\.\d+\.\d+$/.test(want)) {
  console.error(`sync-mcp-pin: '${want}' is not an exact semver version`);
  process.exit(2);
}

const rx = new RegExp(String.raw`${PKG.replace('/', '\\/')}@\d+\.\d+\.\d+`, 'g');
let drift = 0;

for (const rel of TARGETS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const before = fs.readFileSync(p, 'utf8');
  const found = [...new Set(before.match(rx) || [])];
  const stale = found.filter((f) => f !== `${PKG}@${want}`);
  if (!stale.length) { console.log(`current: ${rel}`); continue; }
  drift += stale.length;
  if (!APPLY) {
    console.log(`would:   ${rel}  ${stale.join(', ')} -> ${PKG}@${want}`);
    continue;
  }
  fs.writeFileSync(p, before.replace(rx, `${PKG}@${want}`));
  console.log(`wrote:   ${rel}  -> ${PKG}@${want}`);
}

if (!APPLY && drift) {
  console.error(`\nsync-mcp-pin: ${drift} stale pin(s). Re-run with --apply.`);
  process.exit(1);
}
console.log(`\nsync-mcp-pin: pin is ${PKG}@${want}`);
