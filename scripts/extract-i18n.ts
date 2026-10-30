/**
 * Collects every  t('area.key', 'English text')  call in the web app into locales/en.json and reports
 * keys that are missing from (or untranslated in) hi.json and gu.json.
 *   npm run i18n:extract            -> rewrite en.json, print coverage
 *   npm run i18n:extract -- --check -> exit 1 when hi/gu miss any key
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'apps/web/src');
const files: string[] = [];
(function walk(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'locales' && f !== 'test') walk(p); } else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)) files.push(p);
  }
})(root);

const Q = String.fromCharCode(39, 34, 96);
const RE = new RegExp(String.raw`(?<![\w.])t\(\s*([` + Q + String.raw`])([\w.\-]+)\1\s*,\s*([` + Q + String.raw`])((?:\\.|(?!\3)[^\\])*)\3`, 'g');
const found = new Map<string, string>();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(RE)) {
    const key = m[2]!;
    const text = m[4]!.split('\\n').join('\n').replace(new RegExp(String.raw`\\([` + Q + String.raw`\\])`, 'g'), '$1');
    if (found.has(key) && found.get(key) !== text) console.warn(`! key "${key}" has different defaults (${f})`);
    found.set(key, text);
  }
}
const sorted = Object.fromEntries([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
const dir = join(root, 'locales');
writeFileSync(join(dir, 'en.json'), JSON.stringify(sorted, null, 2) + '\n');

let missing = 0;
for (const lang of ['hi', 'gu']) {
  const cur = JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8')) as Record<string, string>;
  const miss = Object.keys(sorted).filter((k) => !cur[k]);
  const extra = Object.keys(cur).filter((k) => !(k in sorted));
  console.log(`${lang}: ${Object.keys(sorted).length - miss.length}/${Object.keys(sorted).length} translated${extra.length ? `, ${extra.length} unused keys` : ''}`);
  missing += miss.length;
}
console.log(`en: ${found.size} keys from ${files.length} files`);
if (process.argv.includes('--check') && missing > 0) process.exit(1);
