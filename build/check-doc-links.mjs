/*
Purpose: Checks local documentation links and image references without contacting external services.
File Dependencies: AGENTS.md, README.md, STRUCTURE.md, TODO.md, docs/PROJECT_DOC.md.
*/


import fs from 'node:fs';
import path from 'node:path';

/** Enumerates committed documentation candidates without entering generated build directories. */
function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : file.endsWith('.md') ? [file] : [];
  });
}

/** Computes ordinary GitHub-style heading anchors for the project's Markdown headings. */
function anchors(source) {
  const ids = new Set(), counts = new Map();
  for (const match of source.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6} (.+)$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replaceAll(' ', '-').trim();
    const count = counts.get(base) ?? 0;
    ids.add(count ? `${base}-${count}` : base); counts.set(base, count + 1);
  }
  return ids;
}

/** Reports broken relative paths and Markdown anchors, including missing screenshot files. */
function main() {
  const errors = [];
  const files = ['README.md', 'AGENTS.md', 'STRUCTURE.md', 'TODO.md', ...markdownFiles('docs')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].replace(/^<|>$/g, '');
      if (/^(https?:|mailto:|data:)/.test(link)) continue;
      const [relative, fragment] = link.split('#');
      const target = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : path.resolve(file);
      if (!fs.existsSync(target)) { errors.push(`${file}: missing ${link}`); continue; }
      if (fragment && target.endsWith('.md') && !anchors(fs.readFileSync(target, 'utf8')).has(decodeURIComponent(fragment))) errors.push(`${file}: missing heading ${link}`);
    }
  }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Local links and image references pass in ${files.length} Markdown files.`);
}

main();
