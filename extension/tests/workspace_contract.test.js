const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const firefox = path.join(root, 'extension');
const chrome = path.join(root, 'extension-chrome');

function read(relativePath, base = firefox) {
  return fs.readFileSync(path.join(base, relativePath), 'utf8');
}

for (const file of [
  'lib/utils.js',
  'content/filler.js',
  'content/overlay.js',
  'content/overlay.css',
  'content/scraper.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'popup/batch.html',
  'popup/batch.css',
  'popup/batch.js',
  'icons/icon-48.svg',
  'icons/icon-96.svg',
  'WORKSPACE_API.md',
]) {
  assert.equal(read(file), read(file, chrome), `${file} must stay synchronized across browsers`);
}
const firefoxBackground = read('background/background.js');
const chromeBackground = read('background/background.js', chrome)
  .replace(/if \(typeof browser === 'undefined'\) \{\n  globalThis\.browser = chrome;\n\}\n\n\n/, '');
assert.equal(firefoxBackground, chromeBackground, 'background feature code must stay synchronized across browsers');

const overlay = read('content/overlay.js');
const filler = read('content/filler.js');
const background = firefoxBackground;
const docs = read('WORKSPACE_API.md');

for (const endpoint of [
  '/resume-versions',
  '/opportunities/upsert',
  '/application-packets',
  '/teaches',
  '/submissions/confirm',
]) {
  assert.match(overlay + docs, new RegExp(endpoint.replace(/[/.]/g, '\\$&')));
}
assert.match(background, /FETCH_RESUME_VERSION/);
assert.match(background, /resume-versions\/\$\{encodeURIComponent\(versionId\)\}\/download/);
assert.match(overlay, /new DataTransfer\(\)/);
assert.match(filler, /failures/);
assert.doesNotMatch(filler, /submit application|apply now|final submit/i);
assert.match(overlay, /Record submission/);
assert.match(overlay, /PREPARE_APPLICATION/);
assert.match(overlay, /mountReadyChip/);

console.log('workspace contract and browser parity checks passed');
