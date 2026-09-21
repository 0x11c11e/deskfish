// Refuse a .vsix that carries anything private or unneeded. `npm run package` runs it after vsce.
// Why: .vscodeignore is an exclude list, so anything new and unlisted ships; the private handbook
// shipped inside every package from 2026-09-05 to 2026-09-10 that way.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const file = process.argv[2] ?? 'deskfish.vsix';
if (!fs.existsSync(file)) { console.error(`check-vsix: ${file} not found`); process.exit(2); }
let listing;
try { listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }); }
catch { listing = execFileSync('python3', ['-c', `import zipfile,sys;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))`, file], { encoding: 'utf8' }); }
const names = listing.split('\n').filter(Boolean);
// `dist/web/remote.*` and `web/remote.html`: the relay page is its own artifact (a megabyte of
// WebAssembly for a page neither the extension nor the gateway ever serves), attached to the release.
const forbidden = /^extension\/(handbook|website|demo|growth|site|src|test|app|relay|node_modules|\.git[^/]*|\.github|\.vscode|dist\/app)\/|^extension\/(web\/remote\.html|dist\/web\/(remote\.(js|html)|bodies\.mjs))$|^extension\/CLAUDE\.md$|\.vsix$|\.env$|\.map$/;
const bad = names.filter((n) => forbidden.test(n));
if (bad.length) { console.error(`check-vsix: ${file} contains ${bad.length} file(s) that must not ship:\n  ${bad.slice(0, 20).join('\n  ')}`); process.exit(1); }
console.log(`check-vsix: ${file} is clean (${names.length} files)`);
