/*
Purpose: Checks source headers and named-function documentation across authored repository files.
File Dependencies: package.json.
*/


import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import ts from 'typescript';

// npm test creates these artifacts before the tests that consume them run.
const generatedDependencies = new Set(['dist/server/index.js', 'pages-dist/']);

/** Lists tracked and new authored sources while respecting the repository ignore rules. */
export function sourceFiles() {
  return [...new Set(cp.execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n'))]
    .filter(file => /\.(ts|tsx|mjs|css|html|command|yml)$/.test(file) && fs.existsSync(file));
}

/** Resolves static local module and worker references to existing project paths. */
export function dependencies(file, source) {
  const found = new Set();
  if (/\.(ts|tsx|mjs)$/.test(file)) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    /** Collects imports, re-exports, and literal module-worker URLs. */
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier?.text;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      if (ts.isNewExpression(node) && node.expression.getText(tree) === 'URL' && ts.isStringLiteral(node.arguments?.[0])) specifier = node.arguments[0].text;
      if (specifier?.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`].find(candidate => generatedDependencies.has(candidate) || (fs.existsSync(candidate) && fs.statSync(candidate).isFile()));
        if (resolved) found.add(resolved);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return [...found].sort();
}

/** Finds named functions without a nearby contract comment, excluding file headers. */
export function missingFunctionComments(file, source) {
  if (!/\.(ts|tsx|mjs)$/.test(file)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), missing = [];
  /** Associates declarations and function-valued properties with their leading comments. */
  function visit(node) {
    if (ts.isFunctionLike(node) && node.body) {
      let anchor = node, name = node.name?.getText(tree);
      if (ts.isVariableDeclaration(node.parent)) { name = node.parent.name.getText(tree); anchor = node.parent.parent.parent; }
      if (ts.isPropertyAssignment(node.parent)) { name = node.parent.name.getText(tree); anchor = node.parent; }
      if (ts.isConstructorDeclaration(node)) name = 'constructor';
      if (name) {
        const comments = ts.getLeadingCommentRanges(source, anchor.getFullStart()) ?? [];
        const last = comments.at(-1);
        const text = last ? source.slice(last.pos, last.end) : '';
        if (!last || /Purpose:|File Dependencies:/.test(text) || !/[.!?](?:\s|\*\/|$)/.test(text)) {
          missing.push({ name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return missing;
}

/** Validates machine-checkable source conventions and reports unresolved documentation coverage. */
function main() {
  const errors = [], uncovered = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const body = source.replace(/^#![^\n]*\n/, '');
    const header = body.match(/^(\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|# Purpose:[^\n]*\n# File Dependencies:[^\n]*)\n\n\n(?=\S)/);
    if (!header || !/Purpose: .+/.test(header[1]) || !/File Dependencies: .+/.test(header[1])) { errors.push(`${file}: missing header or two-blank-line spacing`); continue; }
    const declared = header[1].match(/File Dependencies:\s*([\s\S]*?)(?:\*\/|-->|$)/)?.[1].trim().replace(/\.$/, '').split(/,\s*/).filter(value => value !== 'None') ?? [];
    for (const dependency of declared) if (!generatedDependencies.has(dependency) && !fs.existsSync(dependency)) errors.push(`${file}: missing dependency ${dependency}`);
    for (const dependency of dependencies(file, source)) if (!declared.includes(dependency)) errors.push(`${file}: undocumented dependency ${dependency}`);
    if (/\/\*\* (?:Performs the .* step for the enclosing operation|Provides the .* operation for this module)/.test(source)) errors.push(`${file}: placeholder function comment`);
    const missing = missingFunctionComments(file, source).map(item => ({ file, ...item }));
    uncovered.push(...missing);
    if (!file.startsWith('tests/')) for (const item of missing) errors.push(`${file}:${item.line}: undocumented named function ${item.name}`);
  }
  if (process.argv.includes('--coverage')) console.log(JSON.stringify(uncovered, null, 2));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Source headers and dependencies pass; ${uncovered.length} test helpers use their test/harness context rather than separate contract comments.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('build/source-standards.mjs')) main();
