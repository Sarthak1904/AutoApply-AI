/**
 * AutoApply — DOM Scraper
 * Extracts form fields and job description from the current page.
 */

const AutoApplyScraper = (() => {
  /**
   * Scrape all form fields and job description from the current page.
   * @returns {{ fields: Array, job_description: string, page_text: string }}
   */
  function scrapeFormFields() {
    const fields = [];
    const seen = new Set();

    // Find all interactive form elements
    const selectors = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="password"])',
      'select',
      'textarea',
      '[contenteditable="true"]',
    ];

    const elements = document.querySelectorAll(selectors.join(', '));

    elements.forEach((el) => {
      // Skip hidden/invisible elements
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      if (el.closest('.autoapply-overlay')) return; // Skip our own overlay

      const fieldData = extractFieldData(el);
      if (!fieldData) return;

      // Deduplicate by ID
      const key = fieldData.id || fieldData.name || fieldData.label || Math.random().toString();
      if (seen.has(key)) return;
      seen.add(key);

      fields.push(fieldData);
    });

    const jobDescription = extractJobDescription();
    const pageText = extractVisiblePageText();

    const result = { fields, job_description: jobDescription, page_text: pageText };
    window.__autoapply_scraper = result;
    return result;
  }

  /**
   * Extract structured data from a single form element.
   * @param {HTMLElement} el - The form element
   * @returns {Object|null} Field data or null if should be skipped
   */
  function extractFieldData(el) {
    const tagName = el.tagName.toLowerCase();

    // Generate or use existing ID
    let fieldId = el.id || el.getAttribute('data-autoapply-id');
    if (!fieldId) {
      fieldId = AutoApplyUtils.generateId('field');
      el.setAttribute('data-autoapply-id', fieldId);
    }

    const label = findLabel(el);
    const type = getFieldType(el);
    if (isSensitiveNonApplicationField(el, label, type)) return null;

    const field = {
      id: fieldId,
      type: type,
      label: label,
      name: el.name || null,
      placeholder: el.placeholder || null,
      required: el.required || el.getAttribute('aria-required') === 'true',
      value: el.value || '',
      options: [],
      accept: null,
      max_length: el.maxLength > 0 ? el.maxLength : null,
      aria_label: el.getAttribute('aria-label') || null,
      group_name: null,
      context: extractFieldContext(el),
    };

    // Handle select elements — extract options
    if (tagName === 'select') {
      field.options = Array.from(el.options)
        .filter((opt) => opt.value && opt.value !== '')
        .map((opt) => opt.textContent.trim());
    }

    // Handle radio/checkbox groups
    if (type === 'radio' || type === 'checkbox') {
      field.group_name = el.name;
      // Collect all options in the group
      if (el.name) {
        const group = document.getElementsByName(el.name);
        field.options = Array.from(group).map((input) => {
          const groupLabel = findLabel(input);
          return groupLabel || input.value;
        });
      }
    }

    // Handle file inputs
    if (type === 'file') {
      field.accept = el.accept || null;
    }

    // Handle contenteditable
    if (el.hasAttribute('contenteditable')) {
      field.type = 'textarea';
      field.value = el.textContent.trim();
    }

    return field;
  }

  /** Never collect authentication, payment, or government-ID inputs. */
  function isSensitiveNonApplicationField(el, label, type) {
    if (type === 'password') return true;

    // On Workday login/signup pages, never collect the sign-in email or username.
    // This is an extra safety net — overlay.js already redirects auth pages before
    // scraping begins, but defence-in-depth ensures no credentials reach the backend.
    const workdayPage = typeof AutoApplyUtils !== 'undefined'
      ? AutoApplyUtils.classifyWorkdayPage(window.location.href)
      : null;
    if (
      (workdayPage === 'login' || workdayPage === 'signup') &&
      (type === 'email' ||
       (el.getAttribute('autocomplete') || '').toLowerCase().includes('username') ||
       /\b(email|username|user[_-]?name)\b/.test([el.id, el.name, el.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase()))
    ) {
      return true;
    }

    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    const blockedAutocomplete = [
      'current-password', 'new-password', 'one-time-code',
      'cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
      'cc-csc', 'cc-type', 'transaction-amount', 'transaction-currency'
    ];
    if (blockedAutocomplete.some(token => autocomplete.split(/\s+/).includes(token))) return true;

    const identity = [
      el.id, el.name, label, el.placeholder,
      el.getAttribute('aria-label')
    ].filter(Boolean).join(' ').toLowerCase();
    return /\b(password|passcode|one[- ]?time (?:code|password)|otp|credit card|card number|cvv|cvc|social security|ssn|bank account|routing number)\b/.test(identity);
  }

  /**
   * Determine the type of a form element.
   * @param {HTMLElement} el
   * @returns {string} Field type
   */
  function getFieldType(el) {
    const tagName = el.tagName.toLowerCase();
    if (tagName === 'select') return 'select';
    if (tagName === 'textarea') return 'textarea';
    if (el.hasAttribute('contenteditable')) return 'textarea';
    return el.type || 'text';
  }

  /**
   * Find the label text for a form element using multiple strategies.
   * @param {HTMLElement} el
   * @returns {string|null} Label text
   */
  function findLabel(el) {
    // Strategy 1: Explicit <label for="...">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return cleanLabelText(label.textContent);
    }

    // Strategy 2: aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return cleanLabelText(labelEl.textContent);
    }

    // Strategy 3: aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return cleanLabelText(ariaLabel);

    // Strategy 4: Wrapping <label> parent
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // Get text that isn't from the input itself
      const clone = parentLabel.cloneNode(true);
      const inputs = clone.querySelectorAll('input, select, textarea');
      inputs.forEach((i) => i.remove());
      const text = cleanLabelText(clone.textContent);
      if (text) return text;
    }

    // Strategy 5: Previous sibling label
    let prev = el.previousElementSibling;
    while (prev) {
      if (prev.tagName === 'LABEL' || prev.classList.contains('label')) {
        return cleanLabelText(prev.textContent);
      }
      prev = prev.previousElementSibling;
    }

    // Strategy 6: Parent's previous sibling or child heading
    const parent = el.parentElement;
    if (parent) {
      // Look for a label-like element in the parent
      const labelLike = parent.querySelector(
        'label, .label, .field-label, .form-label, [class*="label"]'
      );
      if (labelLike && !labelLike.contains(el)) {
        return cleanLabelText(labelLike.textContent);
      }

      // Look at parent's parent for label
      const grandParent = parent.parentElement;
      if (grandParent) {
        const gpLabel = grandParent.querySelector(
          'label, .label, .field-label, .form-label, [class*="label"]'
        );
        if (gpLabel && !gpLabel.contains(el)) {
          return cleanLabelText(gpLabel.textContent);
        }
      }
    }

    // Strategy 7: Placeholder or name as fallback
    if (el.placeholder) return cleanLabelText(el.placeholder);
    if (el.name) return cleanLabelText(el.name.replace(/[_-]/g, ' '));

    return null;
  }

  /**
   * Clean up label text (trim, remove asterisks, collapse whitespace).
   * @param {string} text
   * @returns {string} Cleaned text
   */
  function cleanLabelText(text) {
    return text
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanDescriptionElement(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('nav,header,footer,form,button,input,select,textarea,[role="navigation"],[data-automation-id*="progress"],[class*="progress"],[class*="breadcrumb"]').forEach((node) => node.remove());
    const noisyLine = /^(skip to main content|sign in|settings|candidate home|search for jobs|back to job posting|apply now|autofill with resume|step \d+ of \d+|completed step|save and continue)$/i;
    const lines = (clone.innerText || clone.textContent || '')
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 1 && !noisyLine.test(line) && !/^\S+@\S+\.\S+$/.test(line));
    const deduped = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
    return deduped.join('\n').trim().slice(0, 6000);
  }

  function textLinesFromElement(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(
      '#autoapply-shadow-host,#autoapply-ready-chip-host,script,style,noscript,svg,nav,header,footer,button,input,select,textarea,[role="navigation"],[role="banner"],[role="search"],[aria-hidden="true"]'
    ).forEach((node) => node.remove());
    const noisyLine = /^(skip to main content|sign in|settings|candidate home|search for jobs|back to job posting|apply now|autofill with resume|save and continue|continue|next|previous|back|submit|cancel)$/i;
    const seen = new Set();
    return (clone.innerText || clone.textContent || '')
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 1 && !noisyLine.test(line) && !/^\S+@\S+\.\S+$/.test(line))
      .filter((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function extractVisiblePageText() {
    if (!document.body) return '';
    return textLinesFromElement(document.body).join('\n').slice(0, 12000);
  }

  function extractFieldContext(el) {
    const container = el.closest(
      'fieldset,[role="group"],[data-automation-id*="formField"],[data-testid*="form"],.form-group,.field,.question,.input-group,li,section,article,div'
    );
    if (!container || container === document.body) return '';
    const text = textLinesFromElement(container).join(' ');
    return text.slice(0, 1500);
  }

  /**
   * Extract the job description from the current page.
   * @returns {string} Job description text (max 3000 chars)
   */
  function extractJobDescription() {
    // Strategy 1: Platform-specific selectors
    const platform = AutoApplyUtils.detectPlatform(window.location.href);
    const platformSelectors = {
      workday: [
        '[data-automation-id="jobPostingDescription"]',
        '.css-cygeeu', // Workday JD container
        '.job-description',
      ],
      greenhouse: [
        '#content .body', '.section-wrapper',
        '#header .company-name + div',
      ],
      lever: [
        '.section-wrapper.page-full-width',
        '.posting-page .content',
      ],
      ashby: [
        '.ashby-job-posting-description',
        '[class*="jobDescription"]',
      ],
      linkedin: [
        '.jobs-description__content',
        '.jobs-description',
        '.description__text',
        '.job-details-jobs-unified-top-card__job-insight',
      ],
      indeed: [
        '#jobDescriptionText',
        '.jobsearch-JobComponent-description',
        '.job-description',
      ],
      glassdoor: [
        '#JobDescriptionContainer',
        '.desc',
        '[class*="jobDescription"]',
      ],
      wellfound: [
        '.job-description',
        '.styles_description__',
        '[class*="description"]',
      ],
      darwinbox: [
        '.job-description',
        '.jd-section',
        '[class*="description"]',
      ],
      oracle: [
        '.job-description',
        '.requisition-description',
        '[data-bind*="description"]',
      ],
      naukri: [
        '.job-desc',
        '.jd-container',
        '[class*="job-description"]',
      ],
      instahyre: [
        '.job-description',
        '.profile-info',
      ],
      keka: [
        '.job-description',
        '[class*="job-details"]',
      ],
    };

    const selectors = platformSelectors[platform] || [];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) {
        return cleanDescriptionElement(el);
      }
    }

    // Strategy 2: Common generic selectors
    const genericSelectors = [
      '.job-description', '#job-description',
      '.jobDescription', '#jobDescription',
      '.job-details', '#job-details',
      '.posting-description', '.jd-info',
      '[class*="jobDescription"]', '[class*="job-description"]',
      '[data-testid="job-description"]',
    ];

    for (const sel of genericSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) {
        return cleanDescriptionElement(el);
      }
    }

    // Strategy 3: Look for sections with key headings
    const keyPhrases = [
      'Responsibilities', 'Requirements', 'Qualifications',
      'About the Role', 'What you\'ll do', 'Job Description',
      'About This Role', 'The Role', 'What We\'re Looking For',
    ];

    for (const phrase of keyPhrases) {
      const headings = document.querySelectorAll('h1, h2, h3, h4, strong, b');
      for (const heading of headings) {
        if (heading.textContent.toLowerCase().includes(phrase.toLowerCase())) {
          // Get the parent section
          const section = heading.closest('section, div, article');
          if (section && section.textContent.trim().length > 100) {
            return cleanDescriptionElement(section);
          }
        }
      }
    }

    // Strategy 4: Largest text block on the page (heuristic)
    const blocks = document.querySelectorAll('div, section, article');
    let bestBlock = null;
    let bestLen = 0;

    blocks.forEach((block) => {
      const text = block.textContent.trim();
      if (block.matches('nav,header,footer,form') || block.querySelectorAll('input,select,textarea').length > 4) return;
      // Look for blocks with substantial text and multiple paragraphs
      if (text.length > 200 && text.length < 10000) {
        const pCount = block.querySelectorAll('p, li').length;
        const score = text.length * (pCount > 3 ? 1.5 : 1);
        if (score > bestLen) {
          bestLen = score;
          bestBlock = block;
        }
      }
    });

    if (bestBlock) {
      return cleanDescriptionElement(bestBlock);
    }

    return '';
  }

  return { scrapeFormFields, extractJobDescription, extractVisiblePageText };
})();

if (typeof window !== 'undefined') {
  window.__autoapply_scraper_module = AutoApplyScraper;
}
