const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const overlay = read('extension/content/overlay.js');
const scraper = read('extension/content/scraper.js');
const popup = read('extension/popup/popup.html');
const popupLogic = read('extension/popup/popup.js');
const batch = read('extension/popup/batch.js');
const background = read('extension/background/background.js');
const dashboard = read('backend/dashboard/dashboard.js');
const dashboardMarkup = read('backend/dashboard/index.html');
const dashboardLogo = read('backend/dashboard/logo.svg');
const firefoxManifest = JSON.parse(read('extension/manifest.json'));
const chromeManifest = JSON.parse(read('extension-chrome/manifest.json'));
const visualSources = [
  read('backend/dashboard/dashboard.css'),
  read('extension/popup/popup.css'),
  read('extension/popup/batch.css'),
  read('extension/content/overlay.css'),
  read('extension/content/overlay.js'),
  read('extension/content/filler.js'),
  read('extension/icons/icon-48.svg'),
  read('extension/icons/icon-96.svg'),
  dashboardLogo,
].join('\n').toLowerCase();

assert.match(overlay, /Start filling job/);
assert.match(overlay, /Problem log/);
assert.match(overlay, /autoapply_issue_log/);
assert.match(overlay, /function recordIssue/);
assert.match(overlay, /function startJobPagePromptWatcher/);
assert.match(overlay, /page_text: pageText/);
assert.match(overlay, /function detectGenericAuthStep/);
assert.match(overlay, /function executeGenericAuthStep/);
assert.match(overlay, /Continue sign in/);
assert.match(overlay, /Sign in automatically/);
assert.match(overlay, /autoapply_training_mode/);
assert.match(overlay, /function startTrainingRecorder/);
assert.match(overlay, /Train by watching/);
assert.match(overlay, /\/teaches/);
assert.match(overlay, /function undoLastFill/);
assert.match(overlay, /review_required/);
assert.match(overlay, /Open tracked application/);
assert.doesNotMatch(overlay, />Save Packet</);

assert.match(popup, /Prepare application/);
assert.doesNotMatch(popup, /tab-dashboard|Profile & Info|Fixes Mac upload issue/);
assert.match(popupLogic, /Local answers only/);
assert.doesNotMatch(popupLogic, /backendReady && profileReady && aiReady && pageReady/);

assert.match(batch, /PREPARE_APPLICATION/);
assert.match(batch, /browser\.storage\.local/);
assert.doesNotMatch(batch, /START_AUTOPILOT/);
assert.match(background, /OPEN_WORKSPACE_RECORD/);
assert.match(batch, /OPEN_WORKSPACE_RECORD/);
assert.match(scraper, /extractVisiblePageText/);
assert.match(scraper, /page_text: pageText/);
assert.match(scraper, /context: extractFieldContext/);

assert.match(dashboard, /\/api\/workspace\/opportunities\?limit=500/);
assert.doesNotMatch(dashboard, /\/api\/applications\/\?limit=500/);
assert.match(dashboard, /function closeAddJob/);
assert.match(dashboardMarkup, /data-close-add-job/);
assert.doesNotMatch(dashboardMarkup, /class="icon-button" value="cancel"/);
assert.match(dashboard, /autoapply-theme/);
assert.match(popupLogic, /autoapply_theme/);
assert.match(batch, /autoapply_theme/);
assert.match(overlay, /autoapply_theme/);
assert.match(overlay, /const BRAND_MARK =/);
assert.doesNotMatch(overlay, /autoapply-logo-icon">A/);
assert.match(dashboardMarkup, /dashboard\/static\/logo\.svg/);
assert.doesNotMatch(dashboardMarkup, /class="brand-mark">A/);

assert.match(visualSources, /#3157d5/);
assert.match(visualSources, /#ea6a4f/);
assert.match(visualSources, /#0b1018/);
assert.match(visualSources, /#1b2740/);
assert.match(visualSources, /#526ce7/);
assert.doesNotMatch(visualSources, /#ff8a4c|#4fd1c5/);
assert.doesNotMatch(visualSources, /#8b91ff|#667eea|#764ba2|rgba\(139\s*,\s*145\s*,\s*255|rgba\(102\s*,\s*126\s*,\s*234/);

for (const [directory, manifest] of [['extension', firefoxManifest], ['extension-chrome', chromeManifest]]) {
  const iconPaths = new Set([
    ...Object.values(manifest.icons || {}),
    ...Object.values((manifest.action || manifest.browser_action || {}).default_icon || {}),
  ]);
  for (const iconPath of iconPaths) {
    assert.ok(fs.existsSync(path.join(root, directory, iconPath)), `${directory}/${iconPath} must exist`);
  }
}

for (const file of ['icons/icon-48.svg', 'icons/icon-96.svg', 'popup/popup.css', 'popup/batch.css', 'content/overlay.css', 'content/overlay.js']) {
  assert.equal(read(`extension/${file}`), read(`extension-chrome/${file}`), `${file} must stay in sync across browser packages`);
}
for (const svg of [dashboardLogo, read('extension/icons/icon-48.svg'), read('extension/icons/icon-96.svg')]) {
  assert.match(svg, /^<svg[\s\S]*<\/svg>\s*$/);
  assert.match(svg, /viewBox="0 0 48 48"/);
}

console.log('usability workflow contract checks passed');
