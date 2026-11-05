import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const defaults = ['ai-artifacts', 'AGENTS.md', 'README.md', '.pi/skills/feature-verification'];

// CI runs as `runner`, an ordinary word in these docs, so the workflow names a word that cannot appear.
const username = process.env.CHECK_DOCS_USERNAME || os.userInfo().username;

const home = os.homedir();

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const identityPatterns = [
  ['leak-home', new RegExp(escapeRegex(home), 'g')],
  ['leak-username', new RegExp(`\\b${escapeRegex(username)}\\b`, 'g')],
];

const docsPatterns = [
  ...identityPatterns,
  ['leak-home-path', /\/(?:Users|home)\/[\w.-]+/g],
  ['leak-email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g],
  ['leak-token', /token=[A-Za-z0-9_-]{16,}/g],
];

const pagePatterns = [
  ...identityPatterns,
  ['leak-at', /@/g],
  ['leak-token', /token=/g],
  ['leak-home-path', /\/Users\//g],
];

let findings = 0;

function report(file, text, offset, rule, match) {
  const line = text.slice(0, offset).split('\n').length;
  console.error(`${file}:${line}: ${rule}: ${match}`);
  findings++;
}

function checkPatterns(file, text, patterns) {
  for (const [rule, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) report(file, text, match.index, rule, match[0]);
  }
}

const blank = text => text.replace(/[^\n]/g, ' ');

// Code does not render links, so blank it out while keeping offsets and line numbers.
function withoutCode(text) {
  let fence;

  const prose = text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = undefined;

      return blank(line);
    }

    if (marker) {
      fence = marker;

      return blank(line);
    }

    return line;
  }).join('\n');

  return prose.replace(/(`+)[\s\S]*?[^`]\1(?!`)/g, blank);
}

function links(text) {
  return [...withoutCode(text).matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)];
}

function checkLinks(file, text) {
  for (const match of links(text)) {
    const target = match[1] ?? match[2];

    if (/^(?:#|[A-Za-z][A-Za-z0-9+.-]*:|\/)/.test(target)) continue;
    const pathname = target.split(/[?#]/)[0];
    let decoded;

    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      report(file, text, match.index, 'broken-link', target);
      continue;
    }

    if (!existsSync(path.resolve(path.dirname(file), decoded))) report(file, text, match.index, 'broken-link', target);
  }
}

function checkAdr(file, text) {
  const index = path.join(path.dirname(file), 'INDEX.md');

  if (!existsSync(index) || !readFileSync(index, 'utf8').includes(path.basename(file))) {
    report(file, text, 0, 'adr-index', 'ADR filename missing from INDEX.md');
  }
}

function checkIndex(file, text) {
  const names = readdirSync(path.dirname(file));

  for (const match of text.matchAll(/\bADR-\d{4}\b/g)) {
    if (!names.some(name => name.startsWith(`${match[0]}-`) && name.endsWith('.md') && statSync(path.join(path.dirname(file), name)).isFile())) {
      report(file, text, match.index, 'index-target', match[0]);
    }
  }
}

function collectFiles(entry, files) {
  if (statSync(entry).isDirectory()) {
    for (const name of readdirSync(entry)) collectFiles(path.join(entry, name), files);
  } else if (entry.endsWith('.md')) files.add(path.resolve(entry));
}

function checkDocs(entries) {
  const files = new Set();

  for (const entry of entries) collectFiles(entry, files);

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    checkPatterns(file, text, docsPatterns);
    checkLinks(file, text);
    const normalized = file.split(path.sep).join('/');

    if (/\/ai-artifacts\/docs\/adr\/ADR-\d{4}-[^/]+\.md$/.test(normalized)) checkAdr(file, text);

    if (normalized.endsWith('/ai-artifacts/docs/adr/INDEX.md')) checkIndex(file, text);
  }

  if (!findings) console.log(`ok ${files.size} files`);
}

try {
  const args = process.argv.slice(2);

  if (args[0] === '--page' && args[1] === '-' && args.length === 2) {
    checkPatterns('stdin', readFileSync(0, 'utf8'), pagePatterns);

    if (!findings) console.log('ok page');
  } else if (args.some(arg => arg.startsWith('-'))) {
    report('arguments', '', 0, 'usage', 'node scripts/check-docs.js [paths...] | --page -');
  } else {
    checkDocs(args.length ? args : defaults.filter(entry => existsSync(entry)));
  }
} catch (error) {
  report('check-docs', '', 0, 'io', error.message);
}

process.exitCode = findings ? 1 : 0;
