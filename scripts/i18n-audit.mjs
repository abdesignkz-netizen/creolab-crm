// Inventory of direct Cyrillic UI copy. Not a translation coverage percentage:
// API text, module-level label maps and customer data require a separate review.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
const entries = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes:true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!file.endsWith('.tsx')) continue;
    const source = ts.createSourceFile(file, readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node, inUi = false) {
      if (ts.isCallExpression(node) && ['t','systemText','uiText'].includes(node.expression.getText(source))) return;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) inUi = true;
      const text = ts.isJsxText(node) || (inUi && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) ? node.text.trim() : '';
      if (/[а-яё]/i.test(text)) entries.push({ file:path.relative(root,file),line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,text:text.replace(/\s+/g,' ') });
      ts.forEachChild(node, child => visit(child, inUi));
    }
    visit(source);
  }
}
walk(path.join(root,'apps/web/src'));
if (process.argv.includes('--json')) console.log(JSON.stringify(entries,null,2));
else {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.file,(counts.get(entry.file)||0)+1);
  for (const [file,count] of [...counts].sort((a,b)=>b[1]-a[1])) console.log(`${String(count).padStart(4)} ${file}`);
  console.log(`\n${entries.length} direct UI fragments in ${counts.size} files need contextual review. API copy and label maps are not included.`);
}
