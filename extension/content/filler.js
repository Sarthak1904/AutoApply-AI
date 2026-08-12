/**
 * AutoApply — Form Filler
 * Programmatically fills form fields and handles navigation.
 */

const AutoApplyFiller = (() => {
  // Navigation is intentionally more restrictive than the labels that a site may
  // use. The extension must never turn "Fill & Next" into a submission action.
  const NEXT_BUTTON_TEXTS = [
    'next', 'continue', 'save & continue', 'save and continue',
    'proceed', 'save & next', 'save and next', 'forward',
  ];
  const SUBMIT_LIKE_TEXT = [
    'submit', 'apply', 'finish', 'complete', 'confirm', 'review', 'send',
  ];

  function controlText(el) {
    return [
      el.textContent,
      el.value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      el.getAttribute('id'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .trim();
  }

  /** Return true for a control that could submit or finalize an application. */
  function isSubmitLikeControl(el) {
    const declaredType = (el.getAttribute('type') || '').toLowerCase();
    // A button without an explicit type submits when it belongs to a form. The
    // DOM `type` property also resolves that default, so reject both cases.
    const resolvedType = (el.type || '').toLowerCase();
    if (declaredType === 'submit' || declaredType === 'image' || resolvedType === 'submit') {
      return true;
    }
    if (el.hasAttribute('formaction') || el.hasAttribute('formmethod')) {
      return true;
    }
    const text = controlText(el);
    return SUBMIT_LIKE_TEXT.some((term) => text.includes(term));
  }

  /** Return true only for an explicitly safe, non-submitting navigation control. */
  function isSafeNextControl(el) {
    if (!el || el.offsetParent === null || el.disabled) return false;
    if (el.closest('.autoapply-overlay')) return false;
    if (isSubmitLikeControl(el)) return false;

    const text = controlText(el);
    return NEXT_BUTTON_TEXTS.some((target) => text.includes(target));
  }

  function navigationControls() {
    return [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="button"]'),
      ...document.querySelectorAll('a[role="button"]'),
      ...document.querySelectorAll('[role="button"]'),
    ];
  }

  /**
   * Fill a single form field based on an instruction.
   * Dispatches proper events for React/Angular/Vue framework compatibility.
   * @param {Object} instruction - Fill instruction from backend
   * @returns {boolean} True if filled successfully
   */
  async function fillField(instruction, options = {}) {
    const { field_id, action, value } = instruction;
    if (action === 'skip') return { ok: false, field_id, action, reason: 'Skipped by the mapping.' };
    if (value === undefined || value === null) {
      return { ok: false, field_id, action, reason: 'No value was supplied for this field.' };
    }

    // Find the element by ID or data attribute
    let el = document.getElementById(field_id);
    if (!el) {
      el = document.querySelector(`[data-autoapply-id="${CSS.escape(field_id)}"]`);
    }
    if (!el) {
      console.warn(`[AutoApply] Field not found: ${field_id}`);
      return { ok: false, field_id, action, reason: 'The field is no longer present on this page.' };
    }

    try {
      let ok = false;
      let reason = '';
      switch (action) {
        case 'fill':
          ok = fillTextInput(el, value);
          reason = 'The page rejected the text value.';
          break;

        case 'select':
          ok = await fillSelect(el, value);
          reason = `No matching option was available for “${value}”.`;
          break;

        case 'check':
          ok = fillCheckbox(el, value);
          reason = `Could not set the choice “${value}”.`;
          break;

        case 'upload':
          if (typeof options.uploadHandler === 'function') {
            const upload = await options.uploadHandler(el, instruction);
            ok = Boolean(upload && upload.ok);
            reason = upload && upload.reason ? upload.reason : 'The resume could not be attached automatically.';
          } else {
            highlightUploadField(el);
            reason = 'Choose a resume version to attach automatically, or select the file manually.';
          }
          break;

        default:
          console.warn(`[AutoApply] Unknown action: ${action}`);
          reason = `Unsupported fill action: ${action}.`;
      }
      return { ok, field_id, action, reason: ok ? '' : reason };
    } catch (err) {
      console.error(`[AutoApply] Error filling ${field_id}:`, err);
      return { ok: false, field_id, action, reason: err.message || 'The page prevented this field from being filled.' };
    }
  }

  /**
   * Fill a text input, textarea, or contenteditable element.
   * Uses native input setter to bypass React's synthetic event system.
   */
  function fillTextInput(el, value) {
    if (el.hasAttribute('contenteditable')) {
      el.textContent = value;
      dispatchEvents(el, ['focus', 'input', 'change', 'blur']);
      return true;
    }

    // Use native value setter to work with React controlled components
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    const setter = el.tagName === 'TEXTAREA' ? nativeTextareaValueSetter : nativeInputValueSetter;

    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }

    dispatchEvents(el, ['focus', 'input', 'change', 'blur']);
    return true;
  }

  /**
   * Select an option in a <select> element by matching text.
   */
  async function fillSelect(el, value) {
    if (el.tagName !== 'SELECT') {
      // Might be a custom dropdown — try clicking and searching
      return await fillCustomDropdown(el, value);
    }

    const options = Array.from(el.options);
    const valueLower = value.toLowerCase().trim();

    // Try exact match first
    let match = options.find(
      (opt) => opt.textContent.trim().toLowerCase() === valueLower
    );

    // Try partial match
    if (!match) {
      match = options.find(
        (opt) => opt.textContent.trim().toLowerCase().includes(valueLower) ||
                 valueLower.includes(opt.textContent.trim().toLowerCase())
      );
    }

    // Try value attribute match
    if (!match) {
      match = options.find(
        (opt) => opt.value.toLowerCase() === valueLower
      );
    }

    if (match) {
      el.value = match.value;
      dispatchEvents(el, ['focus', 'change', 'input', 'blur']);
      return true;
    }

    console.warn(`[AutoApply] No matching option for "${value}" in select ${el.id}`);
    return false;
  }

  /**
   * Attempt to fill a custom dropdown (non-native select).
   */
  function fillCustomDropdown(el, value) {
    return new Promise((resolve) => {
      // Click the dropdown to open it
      el.click();

      // Wait a moment for options to render
      setTimeout(() => {
        const valueLower = value.toLowerCase().trim();

        // Look for dropdown options near the element
        const optionSelectors = [
          '[role="option"]', '[role="listbox"] li',
          '.dropdown-item', '.select-option', '.option',
          'li[data-value]', '[class*="option"]', '[class*="MenuItem"]',
        ];

        for (const sel of optionSelectors) {
          const options = document.querySelectorAll(sel);
          for (const opt of options) {
            if (opt.textContent.trim().toLowerCase().includes(valueLower)) {
              opt.click();
              resolve(true);
              return;
            }
          }
        }

        // Try typing into it if it's an input
        if (el.tagName === 'INPUT') {
          fillTextInput(el, value);
          resolve(true);
        } else {
          resolve(false);
        }
      }, 300);
    });
  }

  /**
   * Check/uncheck a checkbox or select a radio button.
   */
  function fillCheckbox(el, value) {
    const valueLower = (value || '').toLowerCase().trim();

    if (el.type === 'radio' || el.type === 'checkbox') {
      // If there's a group, find the right one by label
      if (el.name) {
        const group = document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`);
        for (const input of group) {
          const label = findNearestLabelText(input);
          if (
            label.toLowerCase().includes(valueLower) ||
            input.value.toLowerCase() === valueLower
          ) {
            input.checked = true;
            dispatchEvents(input, ['change']);
            return true;
          }
        }
      }

      // Simple check
      el.checked = valueLower !== 'false' && valueLower !== 'no' && valueLower !== '';
      dispatchEvents(el, ['change']);
      return true;
    }

    return false;
  }

  /**
   * Highlight a file upload field to draw user attention.
   */
  function highlightUploadField(el) {
    const wrapper = el.closest('div') || el.parentElement || el;
    wrapper.style.outline = '3px solid #ea6a4f';
    wrapper.style.outlineOffset = '2px';
    wrapper.style.borderRadius = '4px';
    wrapper.style.animation = 'autoapply-pulse 2s ease-in-out infinite';

    // Add pulse animation if not already present
    if (!document.getElementById('autoapply-upload-style')) {
      const style = document.createElement('style');
      style.id = 'autoapply-upload-style';
      style.textContent = `
        @keyframes autoapply-pulse {
          0%, 100% { outline-color: #ea6a4f; }
          50% { outline-color: #3f8a96; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  /**
   * Fill all fields from an array of instructions.
   * @param {Array} instructions - Array of fill instructions
   * @returns {{ filled: number, skipped: number, failed: number, failures: Array }}
   */
  async function fillAllFields(instructions, options = {}) {
    let filled = 0, skipped = 0, failed = 0;
    const failures = [];

    for (const instruction of instructions) {
      if (instruction.action === 'skip') {
        skipped++;
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between fields

      const outcome = await fillField(instruction, options);
      if (outcome.ok) {
        filled++;
      } else {
        failed++;
        failures.push({
          field_id: instruction.field_id,
          action: instruction.action,
          reason: outcome.reason || 'The field could not be filled.',
        });
      }
    }

    console.log(`[AutoApply] Fill complete: ${filled} filled, ${skipped} skipped, ${failed} failed`);
    return { filled, skipped, failed, failures };
  }

  /**
   * Find and click a conservative Next/Continue control.
   * @returns {boolean} True if a button was found and clicked
   */
  function clickNextButton() {
    const pageState = isLastPage();
    if (pageState.isLast || pageState.isAmbiguous) {
      console.warn(`[AutoApply] Refusing to advance: ${pageState.reason}`);
      return false;
    }

    // Only explicit non-submit controls with an unambiguous next label may be clicked.
    const matches = navigationControls()
      .filter(isSafeNextControl)
      .map((btn) => {
        const text = controlText(btn);
        const matchedTarget = NEXT_BUTTON_TEXTS.find((target) => text.includes(target));
        const isPrimary =
          btn.classList.contains('primary') ||
          btn.classList.contains('btn-primary') ||
          btn.getAttribute('data-automation-id')?.includes('bottom') ||
          getComputedStyle(btn).backgroundColor !== 'rgba(0, 0, 0, 0)';
        return {
          el: btn,
          text,
          isPrimary,
          priority: NEXT_BUTTON_TEXTS.indexOf(matchedTarget),
        };
      });

    if (matches.length === 0) {
      console.warn('[AutoApply] No next/continue button found');
      return false;
    }

    // Sort: primary first, then by priority in NEXT_BUTTON_TEXTS.
    matches.sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return a.priority - b.priority;
    });

    const best = matches[0];
    // Re-check immediately before the side effect in case the page mutated.
    if (!isSafeNextControl(best.el)) {
      console.warn('[AutoApply] Refusing to click a control that became submit-like.');
      return false;
    }
    console.log(`[AutoApply] Clicking safe navigation button: "${best.text}"`);
    best.el.click();
    return true;
  }

  /**
   * Set up a MutationObserver to detect when the form changes (new step).
   * @param {Function} callback - Called when a new step is detected
   * @returns {MutationObserver} The observer (call .disconnect() to stop)
   */
  function detectPageChange(callback) {
    let lastFieldCount = document.querySelectorAll('input, select, textarea').length;

    const observer = new MutationObserver(
      AutoApplyUtils.debounce(() => {
        const currentFieldCount = document.querySelectorAll('input, select, textarea').length;

        // Significant DOM change — likely a new form step
        if (Math.abs(currentFieldCount - lastFieldCount) >= 2) {
          lastFieldCount = currentFieldCount;
          console.log('[AutoApply] Page change detected, re-scanning...');
          callback();
        }
      }, 800)
    );

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  /**
   * Determine if the current page is likely the last page of the application form.
   * @returns {{ isLast: boolean, reason: string }}
   */
  function isLastPage() {
    // Signal 1: An explicit submit-like control is a hard safety boundary. A
    // page may contain both "Next" and "Submit" controls, so do not guess.
    const allButtons = [
      ...navigationControls(),
      ...document.querySelectorAll('input[type="submit"]'),
      ...document.querySelectorAll('input[type="image"]'),
    ];
    const visibleButtons = allButtons.filter(
      (btn) => btn.offsetParent !== null && !btn.disabled && !btn.closest('.autoapply-overlay')
    );
    const hasSubmitButton = visibleButtons.some(isSubmitLikeControl);
    const hasSafeNextButton = visibleButtons.some(isSafeNextControl);
    
    // Signal 2: Check for progress indicators (e.g., "Step 5 of 5")
    const bodyText = document.body.innerText;
    const stepMatch = bodyText.match(/step\s+(\d+)\s+of\s+(\d+)/i);
    let progressComplete = false;
    if (stepMatch && stepMatch[1] === stepMatch[2]) {
      progressComplete = true;
    }
    
    // Signal 3: Count input fields (review pages have very few)
    const inputCount = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
    ).length;
    const isReviewPage = inputCount <= 2;
    
    // Decision logic
    const isLast = hasSubmitButton || progressComplete || (!hasSafeNextButton && isReviewPage);
    const isAmbiguous = !isLast && !hasSafeNextButton;
    
    const reasons = [];
    if (hasSubmitButton) reasons.push('submit-like control found');
    if (progressComplete) reasons.push('progress indicator shows final step');
    if (!hasSafeNextButton && isReviewPage) reasons.push('no safe next button and very few input fields');
    if (isAmbiguous) reasons.push('no unambiguous non-submit next button found');

    return {
      isLast,
      isAmbiguous,
      reason: reasons.join('; ') || 'safe next/continue button available'
    };
  }

  /**
   * Find the nearest label text for an element.
   */
  function findNearestLabelText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const parent = el.closest('label');
    if (parent) return parent.textContent.trim();
    const prev = el.previousElementSibling;
    if (prev) return prev.textContent.trim();
    return el.value || '';
  }

  /**
   * Dispatch native events on an element for framework compatibility.
   */
  function dispatchEvents(el, eventNames) {
    for (const name of eventNames) {
      if (name === 'focus') {
        el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      } else if (name === 'input') {
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        } catch (e) {
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
      } else if (name === 'change') {
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      } else if (name === 'blur') {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      } else if (name === 'click') {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }
  }

  return { fillField, fillAllFields, highlightUploadField, clickNextButton, detectPageChange, isLastPage };
})();

if (typeof window !== 'undefined') {
  window.__autoapply_filler = AutoApplyFiller;
}
