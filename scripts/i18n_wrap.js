// Wrap user-facing strings in t() using the TypeScript AST: JSX text, label-like attributes, string/ternary/template
// children, and toast/confirm/prompt arguments. Usage: node i18n_wrap.js dry|apply out.json file.tsx...
const ts = require('typescript'); const fs = require('fs'); const path = require('path');
const [,, mode, outJson, ...files] = process.argv;
const SRC = path.resolve(__dirname, '..', 'ui', 'src');
const SKIP_TAGS = new Set(['code', 'kbd', 'pre', 'samp', 'style', 'script', 'Markdown']);
const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'label', 'hint', 'description', 'alt', 'aria-description', 'tooltip', 'subtitle', 'caption', 'legend', 'heading', 'help', 'note', 'empty', 'emptyText', 'confirmText', 'summary', 'detail', 'message', 'text', 'okLabel', 'cancelLabel', 'action', 'badge']);
const CALLS = new Set(['toast', 'toastError', 'confirm', 'prompt', 'alert']);
const keys = new Map(); const review = []; const tableKeys = new Map();
const LABEL_PROPS = new Set(['label', 'title', 'hint', 'description', 'desc', 'text', 'placeholder', 'help', 'subtitle', 'caption', 'blurb', 'tooltip', 'empty', 'heading', 'summary', 'note']);
const PASS2 = process.env.PASS2 === '1';
const natural = s => {
  const x = s.trim();
  if (!/[A-Za-z]{2,}/.test(x) || /&[a-z#0-9]+;/i.test(x)) return false;
  if (/^https?:\/\//.test(x) || /^[#/.@$]/.test(x) || /\{\w+\}/.test(x) && !/\s/.test(x)) return false;
  if (!/\s/.test(x)) return /^(Add|Use|Off|On|All|New|Yes|No|Run|Set|Go|Up|Now|Me|Ask|Try|Day|Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(x) || (x.length >= 4 && /^[A-Z]/.test(x) && /[a-z]/.test(x) && !/[_.]/.test(x));
  if (/^[A-Z0-9 _\-./:]+$/.test(x) && x.length < 6) return false;
  return true;
};
const q = s => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '') + "'";  // multi-line literals stay one line
const varName = (expr, used) => {
  const seen = used.__by || (used.__by = new Map()); const src = expr.getText();
  if (seen.has(src)) return seen.get(src);
  let n = null;
  if (ts.isIdentifier(expr)) n = expr.text;
  else if (ts.isPropertyAccessExpression(expr)) n = expr.name.text;
  else if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'toLocaleString' && ts.isIdentifier(expr.expression.expression)) n = expr.expression.expression.text;
  if (!n || !/^[a-zA-Z_]\w*$/.test(n) || used.has(n)) { let i = 0; while (used.has('v' + i)) i++; n = 'v' + i; }
  used.add(n); seen.set(src, n); return n;
};
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = []; const fileKeys = new Set();
  const hasLocalT = (() => { let found = false; const walk = n => { if ((ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === 't') found = true; ts.forEachChild(n, walk); }; walk(sf); return found; })();
  const importsT = /import \{[^}]*\bt\b[^}]*\} from '(\.\.\/)*(\.\/)?i18n'/.test(text);
  const T = importsT ? 't' : hasLocalT ? 'tx' : 't';
  const inT = n => { for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && /^(t|tn|tx)$/.test(p.expression.text)) return true; return false; };
  const tagOf = el => { const t = ts.isJsxElement(el) ? el.openingElement.tagName : ts.isJsxSelfClosingElement(el) ? el.tagName : null; return t ? t.getText() : ''; };
  const add = (start, end, repl, key) => { edits.push({ start, end, repl }); fileKeys.add(key); keys.set(key, (keys.get(key) || new Set()).add(path.relative(SRC, file))); };
  const wrapLiteral = node => {  // StringLiteral | NoSubstitutionTemplateLiteral | TemplateExpression → replacement text or null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!natural(node.text)) return null;
      return { repl: `${T}(${q(node.text)})`, key: node.text };
    }
    if (ts.isTemplateExpression(node)) {
      const used = new Set(); let key = node.head.text; const vars = [];
      for (const span of node.templateSpans) { const before = used.size; const n = varName(span.expression, used); if (used.size > before) vars.push(`${n}: ${span.expression.getText()}`); key += `{${n}}` + span.literal.text; }
      if (!natural(key.replace(/\{\w+\}/g, 'x'))) return null;
      return { repl: `${T}(${q(key)}, { ${vars.join(', ')} })`, key };
    }
    return null;
  };
  const leaves = (e, out = []) => {  // string-ish leaves of ternary / ?? / || chains
    if (ts.isParenthesizedExpression(e)) return leaves(e.expression, out);
    if (ts.isConditionalExpression(e)) { leaves(e.whenTrue, out); leaves(e.whenFalse, out); return out; }
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) { leaves(e.left, out); leaves(e.right, out); return out; }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) out.push(e);
    return out;
  };
  const plain = e => {  // an expression safe to hand to t() as a variable: no JSX, no string/ternary/template content of its own
    let ok = true;
    const w = n => { if (!ok) return; if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /[A-Za-z]/.test(n.text)) || ts.isTemplateExpression(n) || ts.isConditionalExpression(n) || ts.isArrowFunction(n)) ok = false; else ts.forEachChild(n, w); };
    w(e); return ok;
  };
  const merged = new Set();
  const tryMerge = el => {  // children: JsxText and JsxExpression only, at least one natural text, every expression plain
    const kids = el.children; if (!kids || kids.length < 2) return false;
    if (!kids.every(c => ts.isJsxText(c) || (ts.isJsxExpression(c) && c.expression))) return false;
    if (SKIP_TAGS.has(tagOf(el)) || inT(kids[0])) return false;
    const texts = kids.filter(ts.isJsxText); if (!texts.some(c => natural(text.slice(c.pos, c.end)))) return false;
    const exprs = kids.filter(ts.isJsxExpression);
    if (!exprs.every(c => (ts.isStringLiteral(c.expression) && !/[A-Za-z]/.test(c.expression.text)) || plain(c.expression))) return false;
    const used = new Set(); const vars = []; let key = '';
    for (const c of kids) {
      if (ts.isJsxText(c)) key += text.slice(c.pos, c.end).replace(/\s+/g, ' ');
      else if (ts.isStringLiteral(c.expression)) key += c.expression.text;
      else { const before = used.size; const n = varName(c.expression, used); if (used.size > before) vars.push(`${n}: ${c.expression.getText()}`); key += `{${n}}`; }
    }
    const norm = key.trim().replace(/\s+/g, ' '); if (!natural(norm.replace(/\{\w+\}/g, 'x'))) return false;
    const start = kids[0].pos, end = kids[kids.length - 1].end; const raw = text.slice(start, end);
    const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
    add(start, end, `${lead}{${T}(${q(norm)}${vars.length ? `, { ${vars.join(', ')} }` : ''})}${trail}`, norm);
    for (const c of kids) merged.add(c); return true;
  };
  const propAccess = e => { if (ts.isParenthesizedExpression(e)) return propAccess(e.expression); return ts.isPropertyAccessExpression(e) && LABEL_PROPS.has(e.name.text) && (ts.isIdentifier(e.expression) || ts.isPropertyAccessExpression(e.expression)) ? e : null; };
  const wrapProp = e => { const pa = propAccess(e); if (pa && !inT(pa)) { edits.push({ start: pa.getStart(), end: pa.end, repl: `${T}(${pa.getText()})` }); return true; } return false; };
  const collectTable = node => {  // module-level object literals: the strings their label-like properties hold
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && LABEL_PROPS.has(node.name.text) && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) && natural(node.initializer.text)) {
      tableKeys.set(node.initializer.text, (tableKeys.get(node.initializer.text) || new Set()).add(path.relative(SRC, file)));
    }
  };
  const walk = node => {
    if (PASS2) {
      collectTable(node);
      if (ts.isJsxExpression(node) && node.expression && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && !SKIP_TAGS.has(tagOf(node.parent))) {
        if (wrapProp(node.expression)) return;
        if (ts.isConditionalExpression(node.expression)) { wrapProp(node.expression.whenTrue); wrapProp(node.expression.whenFalse); }
        if (ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) { wrapProp(node.expression.left); }
      }
      if (ts.isJsxAttribute(node) && node.initializer && ATTRS.has(node.name.getText()) && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        if (wrapProp(node.initializer.expression)) return;
      }
    }
    if ((ts.isJsxElement(node)) && tryMerge(node)) return;
    if (merged.has(node)) return;
    if (ts.isJsxText(node)) {
      const parent = node.parent; const tag = tagOf(parent);
      if (!SKIP_TAGS.has(tag) && !inT(node)) {
        const raw = text.slice(node.pos, node.end); const core = raw.trim();
        if (core && natural(core)) {
          const lead = raw.slice(0, raw.indexOf(core)); const trail = raw.slice(raw.indexOf(core) + core.length);
          const norm = core.replace(/\s+/g, ' ');
          add(node.pos, node.end, `${lead}{${T}(${q(norm)})}${trail}`, norm);
          const sibs = parent.children ? parent.children.filter(c => ts.isJsxExpression(c)) : [];
          if (sibs.length) review.push(`${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(node.pos).line + 1}: mixed → ${norm.slice(0, 70)}`);
        } else if (core && /^[a-z]{2,}$/.test(core)) review.push(`${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(node.pos).line + 1}: skipped word "${core}"`);
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && ATTRS.has(node.name.getText()) && !inT(node)) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) { const w = wrapLiteral(init); if (w) add(init.getStart(), init.end, `{${w.repl}}`, w.key); }
      else if (ts.isJsxExpression(init) && init.expression) for (const leaf of leaves(init.expression)) { const w = wrapLiteral(leaf); if (w) add(leaf.getStart(), leaf.end, w.repl, w.key); }
      return;
    } else if (ts.isJsxExpression(node) && node.expression && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && !inT(node)) {
      if (!SKIP_TAGS.has(tagOf(node.parent))) for (const leaf of leaves(node.expression)) { const w = wrapLiteral(leaf); if (w) add(leaf.getStart(), leaf.end, w.repl, w.key); }
      ts.forEachChild(node, walk); return;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CALLS.has(node.expression.text) && node.arguments.length && !inT(node)) {
      const a = node.arguments[0]; const w = wrapLiteral(a); if (w) add(a.getStart(), a.end, w.repl, w.key);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  let out = text; edits.sort((a, b) => b.start - a.start);
  let last = Infinity; const applied = edits.filter(e => { if (e.end > last) return false; last = e.start; return true; });
  for (const e of applied) out = out.slice(0, e.start) + e.repl + out.slice(e.end);
  if (applied.length && !/from '(\.\.\/)*(\.\/)?i18n'/.test(out)) {
    const rel = path.relative(path.dirname(file), path.join(SRC, 'i18n')).replace(/\\/g, '/');
    const imports = sf.statements.filter(ts.isImportDeclaration); const at = imports.length ? imports[imports.length - 1].end : 0;
    const line = `\nimport { t${hasLocalT ? ' as tx' : ''} } from '${rel.startsWith('.') ? rel : './' + rel}';`;
    out = out.slice(0, at) + line + out.slice(at);
  } else if (applied.length && hasLocalT && !importsT && !/\bt as tx\b/.test(out)) {
    out = out.replace(/import \{([^}]*)\} from '((?:\.\.\/)*(?:\.\/)?i18n)';/, (m, names, p) => `import {${names.replace(/\bt\b(?! as)/, 't as tx')}} from '${p}';`);
  }
  console.log(`${path.relative(SRC, file)}: ${applied.length} wrapped, ${fileKeys.size} keys${hasLocalT ? ' (local t → tx)' : ''}`);
  if (mode === 'apply') fs.writeFileSync(file, out);
}
fs.writeFileSync(outJson, JSON.stringify({ keys: [...keys.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), tables: Object.fromEntries([...tableKeys].map(([k, v]) => [k, [...v]])), review }, null, 1));
if (PASS2) console.log(`table strings: ${tableKeys.size}`);
console.log(`total keys: ${keys.size}, review items: ${review.length}`);
