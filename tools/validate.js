#!/usr/bin/env node
// validate.js — the executable check on this Agent Plugins package.
//
// Dependency-free (node built-ins only). Exits 1 on any failure, with one
// clear message per failure. Checks the SKILL.md format rules (ADR-11), the
// two manifests, and that every markdown link — inline or reference-style,
// in SKILL.md and references/ alike — resolves.
//
// Known limit, recorded in README: the published Agent Plugins JSON Schemas
// and `skills-ref validate` could not be reached from the authoring
// environment; this script enforces the rules ADR-11 states directly.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const failures = [];

function fail(msg) {
  failures.push(msg);
}

// --- tiny strict YAML-subset parser: `key: value` lines only -------------
// Returns { ok, data, error }. Anything fancier than a scalar per line
// (lists, nesting, multi-line values) is a parse error on purpose: the
// frontmatter contract is flat.
function parseFrontmatter(lines) {
  const data = {};
  for (const line of lines) {
    if ('' === line.trim()) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s+(\S.*)$/.exec(line);
    if (!m) {
      return { ok: false, data, error: `unparseable frontmatter line: ${JSON.stringify(line)}` };
    }
    const key = m[1];
    let value = m[2].trim();
    // Strip one level of matching quotes.
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key in data) return { ok: false, data, error: `duplicate frontmatter key: ${key}` };
    data[key] = value;
  }
  return { ok: true, data };
}

// --- shared text checks ---------------------------------------------------

// Local absolute paths (and ~/) leaked from the authoring machine. Only
// flagged when preceded by start-of-line, whitespace, quote, backtick or an
// opening paren, so URL path segments (…tabnas.dev/homepage) never match:
// their prefix character is part of the URL, not a boundary.
const PATH_LEAK = /(^|[\s"'`(])((?:\/(?:workspace|home|Users|root|tmp|opt)\/)|~\/)/m;

function checkPathLeaks(label, text) {
  const m = PATH_LEAK.exec(text);
  if (m) {
    fail(`${label}: local absolute path '${m[2]}…' leaked into the text`);
  }
}

// Markdown links: inline [text](target), reference usages [text][label], and
// reference definitions [label]: target. Fenced code blocks and inline code
// spans are stripped first so JSON examples and regex literals (e.g.
// `[a-z][a-z0-9-]+`) cannot false-positive as links.
function checkLinks(label, rawText, baseDir) {
  const text = rawText
    .replace(/```[\s\S]*?```/g, '')
    .replace(/``[^`]+``/g, '')
    .replace(/`[^`\n]+`/g, '');

  const defs = new Map();
  let m;
  const defRe = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]+(\S+)/gm;
  while (null !== (m = defRe.exec(text))) defs.set(m[1].toLowerCase(), m[2]);

  const targets = [...defs.values()];
  const inlineRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  while (null !== (m = inlineRe.exec(text))) targets.push(m[1]);

  const useRe = /\[[^\]]*\]\[([^\]]+)\]/g;
  while (null !== (m = useRe.exec(text))) {
    if (!defs.has(m[1].toLowerCase())) {
      fail(`${label}: reference-style link [...][${m[1]}] has no matching [${m[1]}]: definition`);
    }
  }

  for (const target of targets) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const rel = target.split('#')[0];
    if ('' === rel) continue;
    const resolved = path.resolve(baseDir, rel);
    if (!fs.existsSync(resolved)) {
      fail(`${label}: link target does not exist: ${target}`);
    }
  }
}

function mdFilesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFilesUnder(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// --- skills ---------------------------------------------------------------

const SKILLS_DIR = path.join(ROOT, 'skills');
const MAX_FILE_LINES = 500; // ADR-11: "under 500 lines" — the whole file, strictly
const MAX_NAME = 64;
const MAX_DESC = 1024;

// A description must say WHAT the skill does...
const WHAT_VERBS = /\b(author|write|create|build|scaffold|debug|diagnose|test|pin|run|validate|upgrade|audit|fix|parse|bring|teach)\b/i;
// ...and WHEN to use it.
const WHEN_CUE = /\buse (this skill )?when\b/i;

let skillDirs = [];
if (!fs.existsSync(SKILLS_DIR) || !fs.statSync(SKILLS_DIR).isDirectory()) {
  fail('skills/ directory missing');
} else {
  skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (0 === skillDirs.length) fail('skills/ contains no skill directories');
}

for (const dir of skillDirs) {
  const skillDir = path.join(SKILLS_DIR, dir);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const label = `skills/${dir}/SKILL.md`;

  if (!fs.existsSync(skillPath)) {
    fail(`${label}: missing`);
    continue;
  }
  const text = fs.readFileSync(skillPath, 'utf8');
  const lines = text.split('\n');

  // Line budget: the WHOLE file, strictly under 500 lines. A trailing
  // newline makes split() yield one empty final element — not a line.
  const fileLines = lines.slice();
  if ('' === fileLines[fileLines.length - 1]) fileLines.pop();
  if (fileLines.length >= MAX_FILE_LINES) {
    fail(`${label}: file is ${fileLines.length} lines; ADR-11's budget is under ${MAX_FILE_LINES} — push depth into references/`);
  }

  // Frontmatter block: first line '---', up to the next '---'.
  if ('---' !== lines[0]) {
    fail(`${label}: does not start with '---' frontmatter`);
    continue;
  }
  const end = lines.indexOf('---', 1);
  if (-1 === end) {
    fail(`${label}: frontmatter never closes`);
    continue;
  }
  const fm = parseFrontmatter(lines.slice(1, end));
  if (!fm.ok) {
    fail(`${label}: ${fm.error}`);
    continue;
  }
  const { name, description } = fm.data;

  // name rules
  if (!name) {
    fail(`${label}: frontmatter 'name' is required`);
  } else {
    if (name !== dir) fail(`${label}: name '${name}' must equal directory name '${dir}'`);
    if (name.length > MAX_NAME) fail(`${label}: name exceeds ${MAX_NAME} chars (${name.length})`);
    if (!/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
      fail(`${label}: name '${name}' must be lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen`);
    }
  }

  // description rules
  if (!description) {
    fail(`${label}: frontmatter 'description' is required`);
  } else {
    if (description.length > MAX_DESC) {
      fail(`${label}: description exceeds ${MAX_DESC} chars (${description.length})`);
    }
    if (!WHAT_VERBS.test(description)) {
      fail(`${label}: description must state WHAT the skill does (no action verb found)`);
    }
    if (!WHEN_CUE.test(description)) {
      fail(`${label}: description must state WHEN to use it (no 'Use when ...' cue found)`);
    }
  }

  // body rules
  const body = lines.slice(end + 1).join('\n');

  // The untrusted-input constraint must be a real sentence, not scattered
  // keywords: one period- or newline-delimited segment carrying "never",
  // "instructions" and "data"/"content" together.
  const hasConstraint = body.split(/[.\n]/).some((seg) =>
    /never/i.test(seg) && /instructions/i.test(seg) && /(data|content)/i.test(seg));
  if (!hasConstraint) {
    fail(`${label}: missing the untrusted-input constraint (one sentence must state that parsed content/data is never instructions)`);
  }

  checkPathLeaks(label, body);
  checkLinks(label, body, skillDir);

  // Companion markdown (references/, assets docs, …): same link and
  // path-leak discipline.
  for (const md of mdFilesUnder(skillDir)) {
    if (md === skillPath) continue;
    const relLabel = `skills/${dir}/${path.relative(skillDir, md)}`;
    const mdText = fs.readFileSync(md, 'utf8');
    checkPathLeaks(relLabel, mdText);
    checkLinks(relLabel, mdText, path.dirname(md));
  }
}

// --- manifests ------------------------------------------------------------

function readJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    fail(`${rel}: missing`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`${rel}: does not parse as JSON (${e.message})`);
    return null;
  }
}

const plugin = readJson('plugin.json');
if (plugin) {
  if ('tabnas' !== plugin.name) fail(`plugin.json: name must be 'tabnas' (got ${JSON.stringify(plugin.name)})`);
  if (!/^\d+\.\d+\.\d+$/.test(String(plugin.version))) fail(`plugin.json: version must be exact semver (got ${JSON.stringify(plugin.version)})`);
  if (!plugin.description) fail('plugin.json: description is required');
  if ('MIT' !== plugin.license) fail(`plugin.json: license must be MIT (got ${JSON.stringify(plugin.license)})`);
}

const mcp = readJson('mcp.json');
if (mcp) {
  // Collect server entries wherever the manifest keeps them.
  const servers = (mcp.servers && 'object' === typeof mcp.servers) ? mcp.servers : mcp;
  let sawStdio = false;
  let sawHosted = false;
  for (const [sname, s] of Object.entries(servers)) {
    if (null === s || 'object' !== typeof s) continue;
    if ('stdio' === s.type || Array.isArray(s.command)) {
      sawStdio = true;
      const cmd = Array.isArray(s.command) ? s.command : [];
      // Positional contract: ["npx","--yes","@tabnas/mcp@x.y.z","mcp"].
      if (!('npx' === cmd[0] && '--yes' === cmd[1])) {
        fail(`mcp.json: stdio server '${sname}' command must start ["npx","--yes"] (a stdio server owns stdin, so npx must never prompt)`);
      }
      if (!/^@tabnas\/mcp@\d+\.\d+\.\d+$/.test(String(cmd[2]))) {
        fail(`mcp.json: stdio server '${sname}' command[2] must be an exact pin @tabnas/mcp@x.y.z (got ${JSON.stringify(cmd[2])})`);
      }
      if ('mcp' !== cmd[3]) {
        fail(`mcp.json: stdio server '${sname}' command[3] must be "mcp" — the CLI subcommand that starts the stdio server; without it npx runs the bare CLI and prints usage instead of serving`);
      }
    }
    if ('streamable-http' === s.type || 'string' === typeof s.url) {
      sawHosted = true;
      if (!/^https:\/\//.test(String(s.url))) {
        fail(`mcp.json: hosted server '${sname}' url must be https (got ${JSON.stringify(s.url)})`);
      }
    }
  }
  if (!sawStdio) fail('mcp.json: no stdio server entry found');
  if (!sawHosted) fail('mcp.json: no streamable-http (hosted) server entry found');
}

// --- report ---------------------------------------------------------------

if (failures.length) {
  console.error(`validate: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`validate: OK — ${skillDirs.length} skills, plugin.json, mcp.json`);
