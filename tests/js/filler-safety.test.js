#!/usr/bin/env node

/* Dependency-free behavioral tests for the shared extension navigation guard. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function control({ text = '', type = 'button', attrs = {}, visible = true } = {}) {
  let clicked = false;
  return {
    tagName: 'BUTTON',
    textContent: text,
    value: '',
    type,
    disabled: false,
    offsetParent: visible ? {} : null,
    classList: { contains: () => false },
    getAttribute(name) {
      if (name === 'type') return Object.hasOwn(attrs, name) ? attrs[name] : type;
      return attrs[name] || null;
    },
    hasAttribute(name) {
      return Object.hasOwn(attrs, name);
    },
    closest: () => null,
    click() { clicked = true; },
    get clicked() { return clicked; },
  };
}

function loadFiller(relativeFile, controls) {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', relativeFile), 'utf8');
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === 'button' || selector === '[role="button"]' || selector === 'a[role="button"]') {
        return controls;
      }
      if (selector === 'input[type="button"]' || selector === 'input[type="submit"]' || selector === 'input[type="image"]') {
        return [];
      }
      if (selector.includes('input:not')) return [];
      return [];
    },
  };
  const context = {
    window: {},
    document,
    console,
    CSS: { escape: (value) => value },
    getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)' }),
    AutoApplyUtils: { debounce: (fn) => fn },
    MutationObserver: class {},
  };
  vm.runInNewContext(source, context, { filename: relativeFile });
  return context.window.__autoapply_filler;
}

for (const file of ['extension/content/filler.js', 'extension-chrome/content/filler.js']) {
  {
    const next = control({ text: 'Continue', type: 'button' });
    const filler = loadFiller(file, [next]);
    assert.equal(filler.clickNextButton(), true, `${file}: an explicit button-type continue control advances`);
    assert.equal(next.clicked, true, `${file}: safe continue control was clicked`);
  }

  for (const unsafe of [
    control({ text: 'Submit application', type: 'button' }),
    control({ text: 'Apply now', type: 'button' }),
    control({ text: 'Finish', type: 'button' }),
    control({ text: 'Next', type: 'submit' }),
  ]) {
    const filler = loadFiller(file, [unsafe]);
    assert.equal(filler.clickNextButton(), false, `${file}: submit-like control is rejected`);
    assert.equal(unsafe.clicked, false, `${file}: submit-like control was not clicked`);
  }

  {
    const next = control({ text: 'Next', type: 'button' });
    const submit = control({ text: 'Submit application', type: 'button' });
    const filler = loadFiller(file, [next, submit]);
    assert.equal(filler.clickNextButton(), false, `${file}: mixed next/submit page is treated as ambiguous`);
    assert.equal(next.clicked, false, `${file}: no control is clicked on an ambiguous page`);
    assert.equal(submit.clicked, false, `${file}: submit is never clicked on an ambiguous page`);
  }
}

console.log('filler navigation safety tests passed');
