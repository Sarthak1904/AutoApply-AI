/**
 * AutoApply — Review Overlay UI Orchestrator
 * Injected as a content script. Creates the floating glassmorphism panel,
 * coordinates scraper → backend → filler, and handles user interactions.
 */

(() => {
  // Prevent multiple initializations in the same tab session
  if (window.__autoapply_overlay_initialized) return;
  window.__autoapply_overlay_initialized = true;

  const UTILS = window.__autoapply_utils;
  const SCRAPER = window.__autoapply_scraper_module;
  const FILLER = window.__autoapply_filler;

  if (!UTILS || !SCRAPER || !FILLER) {
    console.error('[AutoApply] Required modules not loaded. Ensure script load order: utils.js -> scraper.js -> filler.js -> overlay.js');
    return;
  }

  let shadowHost = null;
  let shadowRoot = null;
  let overlayContainer = null;
  let currentInstructions = [];
  let originalInstructionsMap = new Map(); // field_id -> original agent value
  let jobAnalysis = null;
  let companyName = '';
  let roleName = '';
  let isMinimized = false;
  let activeObserver = null;
  let pageFields = []; // Cached fields from scraper
  let jdText = ''; // Cached job description
  let pageText = ''; // Cached visible page scan
  let cachedDuplicateRes = null; // Cached duplicate response
  let autopilotActive = false;
  let autopilotStep = 0;
  let autopilotState = 'idle';
  let autopilotMessage = '';
  let readyChipHost = null;
  let lastFillSnapshot = [];
  let hasFilledCurrentPage = false;
  let receiptRecorded = false;
  let preparationSummary = { ready_count: 0, review_count: 0, skipped_count: 0 };
  const THEME_KEY = 'autoapply_theme';
  const ISSUE_LOG_KEY = 'autoapply_issue_log';
  const TRAINING_MODE_KEY = 'autoapply_training_mode';
  const themeChoices = new Set(['system', 'light', 'dark']);
  const BRAND_MARK = `<span class="autoapply-logo-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M7 2h26l13 13v26a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Z" fill="#17213A" stroke="#344664" stroke-width="2"/><path d="M33 2v10a3 3 0 0 0 3 3h10Z" fill="#526CE7"/><path d="M10 11v26" stroke="#F47D68" stroke-width="4" stroke-linecap="round"/><path d="M20 14v9h12v11" fill="none" stroke="#91A4FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="14" r="4" fill="#FFFDF8"/><circle cx="32" cy="23" r="4" fill="#526CE7" stroke="#FFFDF8" stroke-width="2"/><circle cx="32" cy="34" r="4" fill="#52BFAE"/></svg></span>`;
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  let themePreference = 'system';
  const MAX_AUTOPILOT_STEPS = 15;
  let fieldFailures = new Map();
  let issueLog = [];
  let promptDismissedForUrl = '';
  let jobPageObserver = null;
  let jobPagePollTimer = null;
  let trainingMode = false;
  let trainingRecords = 0;
  let trainingInputHandler = null;
  let trainingClickHandler = null;
  let trainingSaveTimers = new Map();
  let workspace = {
    opportunityId: null,
    packetId: null,
    resumeVersions: [],
    selectedResumeVersionId: null,
    policy: null,
  };

  function resolvedTheme() {
    return themePreference === 'system' ? (colorScheme.matches ? 'dark' : 'light') : themePreference;
  }

  function applyOverlayTheme() {
    if (overlayContainer) overlayContainer.dataset.theme = resolvedTheme();
  }

  async function initializeTheme() {
    const saved = await browser.storage.local.get(THEME_KEY);
    themePreference = themeChoices.has(saved[THEME_KEY]) ? saved[THEME_KEY] : 'system';
    applyOverlayTheme();
  }

  async function initializeIssueLog() {
    try {
      const saved = await browser.storage.local.get(ISSUE_LOG_KEY);
      issueLog = Array.isArray(saved[ISSUE_LOG_KEY]) ? saved[ISSUE_LOG_KEY].slice(0, 50) : [];
    } catch (error) {
      console.warn('[AutoApply] Could not load problem log:', error);
      issueLog = [];
    }
  }

  async function initializeTrainingMode() {
    try {
      const saved = await browser.storage.local.get(TRAINING_MODE_KEY);
      trainingMode = saved[TRAINING_MODE_KEY] === true;
      if (trainingMode) startTrainingRecorder();
    } catch (error) {
      console.warn('[AutoApply] Could not load training mode:', error);
      trainingMode = false;
    }
  }

  async function setTrainingMode(enabled) {
    trainingMode = Boolean(enabled);
    await browser.storage.local.set({ [TRAINING_MODE_KEY]: trainingMode }).catch((error) => {
      console.warn('[AutoApply] Could not save training mode:', error);
    });
    if (trainingMode) startTrainingRecorder();
    else stopTrainingRecorder();
    refreshTrainingStatus();
  }

  function recordIssue(message, details = {}) {
    const text = String(message || '').trim();
    if (!text) return;

    const entry = {
      id: UTILS.generateId('issue'),
      timestamp: new Date().toISOString(),
      message: text,
      severity: details.severity || 'error',
      source: details.source || 'extension',
      field_id: details.field_id || '',
      action: details.action || '',
      url: window.location.href,
      page_title: document.title,
      company: companyName || '',
      role: roleName || '',
    };
    issueLog = [entry, ...issueLog].slice(0, 50);
    browser.storage.local.set({ [ISSUE_LOG_KEY]: issueLog }).catch((error) => {
      console.warn('[AutoApply] Could not save problem log:', error);
    });
  }

  function clearIssueLog() {
    issueLog = [];
    browser.storage.local.set({ [ISSUE_LOG_KEY]: issueLog }).catch((error) => {
      console.warn('[AutoApply] Could not clear problem log:', error);
    });
    const existingSection = overlayContainer?.querySelector('.autoapply-log-section');
    if (existingSection) {
      existingSection.outerHTML = renderIssueLogSection();
      overlayContainer.querySelector('.autoapply-clear-log-btn')?.addEventListener('click', clearIssueLog);
    } else {
      renderMainUI();
    }
  }

  function formatIssueTime(value) {
    try {
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function isTrainingField(el) {
    if (!el || el.closest?.('#autoapply-shadow-host,#autoapply-ready-chip-host')) return false;
    if (el.disabled || el.offsetParent === null) return false;
    if (!el.matches?.('input,select,textarea,[contenteditable="true"]')) return false;
    const type = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'file', 'search'].includes(type)) return false;

    const identity = [
      type,
      el.id,
      el.name,
      el.placeholder,
      el.getAttribute('aria-label'),
      el.getAttribute('autocomplete'),
    ].filter(Boolean).join(' ').toLowerCase();
    return !/\b(password|passcode|one[- ]?time|otp|verification code|credit card|card number|cvv|cvc|social security|ssn|bank account|routing number)\b/.test(identity);
  }

  function trainingFieldValue(el, field) {
    if (el.hasAttribute?.('contenteditable')) return (el.textContent || '').trim();
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox') return el.checked ? 'true' : 'false';
    if (type === 'radio') {
      if (!el.checked) return '';
      return field?.label || el.value || 'true';
    }
    return (el.value || '').trim();
  }

  function scrapeFieldForElement(el) {
    try {
      const id = el.id || el.getAttribute('data-autoapply-id') || UTILS.generateId('field');
      if (!el.id && !el.getAttribute('data-autoapply-id')) el.setAttribute('data-autoapply-id', id);
      const scrapeResult = SCRAPER.scrapeFormFields();
      pageFields = scrapeResult.fields || pageFields;
      pageText = scrapeResult.page_text || pageText;
      jdText = scrapeResult.job_description || jdText;
      return pageFields.find((field) => field.id === id) || null;
    } catch (error) {
      recordIssue(error.message || 'Training scan failed.', { source: 'training' });
      return null;
    }
  }

  function queueTrainingFieldSave(el) {
    if (!trainingMode || !isTrainingField(el)) return;
    const key = el.id || el.getAttribute('data-autoapply-id') || el.name || UTILS.generateId('training');
    if (trainingSaveTimers.has(key)) clearTimeout(trainingSaveTimers.get(key));
    trainingSaveTimers.set(key, setTimeout(() => {
      trainingSaveTimers.delete(key);
      saveTrainingField(el);
    }, 650));
  }

  async function saveTrainingField(el) {
    if (!trainingMode || !isTrainingField(el)) return;
    const field = scrapeFieldForElement(el);
    if (!field) return;
    const value = trainingFieldValue(el, field);
    if (!value) return;
    const label = field.label || field.placeholder || field.name || field.id;
    if (!label) return;

    try {
      await UTILS.workspaceCall('/teaches', 'POST', {
        url: window.location.href,
        field: {
          id: field.id,
          label,
          type: field.type,
          context: field.context || '',
        },
        corrected_value: value,
        training_mode: true,
      });
      trainingRecords += 1;
      refreshTrainingStatus();
    } catch (error) {
      recordIssue(error.message || 'Training example was not saved.', { source: 'training' });
    }
  }

  function recordTrainingClick(el) {
    if (!trainingMode || !el || el.closest?.('#autoapply-shadow-host,#autoapply-ready-chip-host')) return;
    const text = [
      el.textContent,
      el.value,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!/\b(apply|continue|next|save and continue|sign in|create account)\b/i.test(text)) return;
    recordIssue(`Training saw navigation action: ${text.slice(0, 80)}`, { source: 'training', severity: 'info' });
  }

  function startTrainingRecorder() {
    if (trainingInputHandler || !document.body) return;
    trainingInputHandler = (event) => queueTrainingFieldSave(event.target);
    trainingClickHandler = (event) => recordTrainingClick(event.target?.closest?.('button,a,[role="button"],input[type="button"],input[type="submit"]'));
    document.addEventListener('input', trainingInputHandler, true);
    document.addEventListener('change', trainingInputHandler, true);
    document.addEventListener('click', trainingClickHandler, true);
    console.log('[AutoApply] Training mode is watching this page.');
  }

  function stopTrainingRecorder() {
    if (trainingInputHandler) {
      document.removeEventListener('input', trainingInputHandler, true);
      document.removeEventListener('change', trainingInputHandler, true);
      trainingInputHandler = null;
    }
    if (trainingClickHandler) {
      document.removeEventListener('click', trainingClickHandler, true);
      trainingClickHandler = null;
    }
    for (const timer of trainingSaveTimers.values()) clearTimeout(timer);
    trainingSaveTimers.clear();
  }

  function refreshTrainingStatus() {
    const status = overlayContainer?.querySelector('.autoapply-training-status');
    if (status) status.textContent = trainingMode ? `Training on · ${trainingRecords} saved this page` : 'Training off';
    const buttons = shadowRoot?.querySelectorAll?.('.autoapply-training-toggle');
    buttons?.forEach((button) => {
      button.textContent = trainingMode ? 'Stop training' : 'Train by watching';
      button.classList.toggle('active', trainingMode);
    });
  }

  function opportunityPayload() {
    return {
      url: window.location.href,
      company: companyName || 'Unknown',
      role: roleName || 'Unknown',
      platform: UTILS.detectPlatform(window.location.href),
      page_title: document.title,
      job_description_snippet: jdText ? jdText.slice(0, 3000) : '',
      job_description: jdText || '',
      page_text_snippet: pageText ? pageText.slice(0, 3000) : '',
      source: 'browser_extension',
    };
  }

  function workspaceId(response, key) {
    return response?.[key]?.id || response?.[`${key}_id`] || response?.id || null;
  }

  async function loadWorkspaceContext({ duplicateResolution = '', existingId = null } = {}) {
    if (!duplicateResolution && workspace.opportunityId) {
      duplicateResolution = 'reuse';
      existingId = workspace.opportunityId;
    }
    const payload = opportunityPayload();
    const policyQuery = `?url=${encodeURIComponent(payload.url)}&platform=${encodeURIComponent(payload.platform)}`;
    const duplicateQuery = `?url=${encodeURIComponent(payload.url)}&company=${encodeURIComponent(payload.company)}&role=${encodeURIComponent(payload.role)}`;
    const [versions, policy, duplicates] = await Promise.allSettled([
      UTILS.workspaceCall('/resume-versions'),
      UTILS.workspaceCall(`/policy${policyQuery}`),
      UTILS.workspaceCall(`/duplicates${duplicateQuery}`),
    ]);

    if (versions.status === 'fulfilled') {
      workspace.resumeVersions = versions.value?.versions || versions.value?.items || [];
      const active = workspace.resumeVersions.find((version) => version.active);
      if (!workspace.selectedResumeVersionId) {
        workspace.selectedResumeVersionId = active?.id || workspace.resumeVersions[0]?.id || null;
      }
    }
    if (policy.status === 'fulfilled') {
      workspace.policy = policy.value?.policy || policy.value || null;
    }
    const matches = duplicates.status === 'fulfilled' ? (duplicates.value?.matches || []) : [];
    if (matches.length && !duplicateResolution) return { duplicates: matches };
    const opportunity = await UTILS.workspaceCall('/opportunities/upsert', 'POST', {
      ...payload,
      status: 'preparing',
      duplicate_resolution: duplicateResolution || 'create_new',
      existing_id: existingId,
    });
    const nextOpportunityId = workspaceId(opportunity, 'opportunity');
    if (workspace.opportunityId && workspace.opportunityId !== nextOpportunityId) workspace.packetId = null;
    workspace.opportunityId = nextOpportunityId;
    return { duplicates: matches, opportunity };
  }

  function policyBlocksAutopilot() {
    return workspace.policy && workspace.policy.allow_autopilot === false;
  }

  function policyMessage() {
    if (!workspace.policy) return '';
    return workspace.policy.message || workspace.policy.reason || '';
  }

  function renderWorkspaceContext() {
    const policyText = policyMessage();
    const versions = workspace.resumeVersions || [];
    const versionSelect = versions.length
      ? `<label style="display:block;font-size:11px;margin-top:8px;">Resume version
          <select class="autoapply-resume-version" style="width:100%;margin-top:3px;">
            ${versions.map((version) => `<option value="${UTILS.escapeHTML(version.id)}" ${version.id === workspace.selectedResumeVersionId ? 'selected' : ''}>${UTILS.escapeHTML(version.label || version.filename || version.id)}</option>`).join('')}
          </select>
        </label>`
      : '<div style="font-size:11px;margin-top:6px;">No workspace resume version is available; file fields will stay manual.</div>';
    return `
      <div class="autoapply-workspace-context">
        <div class="autoapply-context-label">Resume for this application</div>
        ${versionSelect}
        ${policyText ? `<div style="font-size:11px;margin-top:6px;color:#f5c451;">Policy: ${UTILS.escapeHTML(policyText)}</div>` : ''}
      </div>
    `;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function attachSelectedResume(el) {
    if (el.type !== 'file') {
      return { ok: false, reason: 'This upload control is not a native file input.' };
    }
    if (!workspace.selectedResumeVersionId) {
      FILLER.highlightUploadField?.(el);
      return { ok: false, reason: 'Choose a workspace resume version, or select the file manually.' };
    }
    try {
      const response = await browser.runtime.sendMessage({
        type: 'FETCH_RESUME_VERSION',
        version_id: workspace.selectedResumeVersionId,
      });
      if (!response || response.status !== 'success' || !response.file?.base64) {
        throw new Error(response?.error || 'Resume download failed.');
      }
      if (typeof DataTransfer === 'undefined') throw new Error('This browser does not allow automatic file attachment.');
      const file = new File(
        [base64ToBytes(response.file.base64)],
        response.file.filename || 'resume.pdf',
        { type: response.file.contentType || 'application/pdf' }
      );
      const transfer = new DataTransfer();
      transfer.items.add(file);
      el.files = transfer.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (error) {
      FILLER.highlightUploadField?.(el);
      return { ok: false, reason: `${error.message || 'Automatic attachment failed.'} Select the file manually.` };
    }
  }

  async function saveWorkspacePacket(stage, fillResult = null) {
    if (!workspace.opportunityId) return null;
    try {
      const coverInstruction = currentInstructions.find((instruction) => {
        const field = pageFields.find((candidate) => candidate.id === instruction.field_id);
        return /cover[ _-]?letter/i.test(`${field?.label || ''} ${field?.name || ''}`);
      });
      const response = await UTILS.workspaceCall('/application-packets', 'POST', {
        id: workspace.packetId || undefined,
        opportunity_id: workspace.opportunityId,
        resume_version_id: workspace.selectedResumeVersionId,
        stage,
        page_url: window.location.href,
        instructions: currentInstructions,
        field_failures: fillResult?.failures || Array.from(fieldFailures.values()),
        cover_letter: coverInstruction?.value || null,
        form_snapshot: { company: companyName, role: roleName, page_title: document.title },
      });
      workspace.packetId = workspaceId(response, 'packet') || workspace.packetId;
      const opportunityStatus = ['submitted_by_user'].includes(stage) ? 'submitted' : 'ready_to_review';
      await UTILS.workspaceCall(`/opportunities/${encodeURIComponent(workspace.opportunityId)}`, 'PATCH', {
        status: opportunityStatus,
        fit_score: jobAnalysis?.score ?? undefined,
      });
      return response;
    } catch (error) {
      console.warn('[AutoApply] Workspace packet was not saved:', error);
      return null;
    }
  }

  async function captureTeach(field, originalValue, correctedValue) {
    const failure = fieldFailures.get(field.id);
    if (!workspace.opportunityId || (!failure && originalValue === correctedValue)) return;
    try {
      await UTILS.workspaceCall('/teaches', 'POST', {
        opportunity_id: workspace.opportunityId,
        packet_id: workspace.packetId,
        url: window.location.href,
        field: { id: field.id, label: field.label || field.name || '', type: field.type },
        proposed_value: originalValue,
        corrected_value: correctedValue,
        failure_reason: failure?.reason || null,
      });
      fieldFailures.delete(field.id);
    } catch (error) {
      console.warn('[AutoApply] Teach capture was not saved:', error);
    }
  }

  function submissionReceipt() {
    const text = document.body?.innerText || '';
    const match = text.match(/(application (?:has been )?(?:submitted|received)|thank you for applying|we received your application)/i);
    return { url: window.location.href, title: document.title, confirmation_text: match ? match[1] : '' };
  }

  async function confirmManualSubmission() {
    if (!window.confirm('Confirm that you personally clicked the employer’s Submit button. AutoApply will only save a receipt; it will not submit anything.')) return;
    await saveWorkspacePacket('submitted_by_user');
    if (!workspace.opportunityId || !workspace.packetId) {
      showStatus('Submission was not recorded because the workspace service is unavailable.', true);
      return;
    }
    try {
      const response = await UTILS.workspaceCall('/submissions/confirm', 'POST', {
        opportunity_id: workspace.opportunityId,
        packet_id: workspace.packetId,
        submitted_at: new Date().toISOString(),
        receipt: submissionReceipt(),
        user_confirmed: true,
      });
      receiptRecorded = true;
      showStatus(`Manual submission saved${response?.receipt?.id ? ' with receipt' : ''}.`, false);
      renderMainUI();
    } catch (error) {
      showStatus(`Could not save the manual submission receipt: ${error.message}`, true);
    }
  }

  // Drag state
  let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;
  let dragMoveHandler = null;
  let dragUpHandler = null;

  /**
   * Start the scan, analysis, and fill-preparation flow.
   */
  async function startScanningFlow() {
    removeOverlay();
    removeReadyChip();
    window.__autoapply_active = true;
    hasFilledCurrentPage = false;
    lastFillSnapshot = [];

    // Create shadow DOM host to isolate overlay from host page CSS
    shadowHost = document.createElement('div');
    shadowHost.id = 'autoapply-shadow-host';
    document.body.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    // Fetch overlay CSS and inject into shadow root
    try {
      const cssUrl = browser.runtime.getURL('content/overlay.css');
      const cssResponse = await fetch(cssUrl);
      const cssText = await cssResponse.text();
      const styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      shadowRoot.appendChild(styleEl);
    } catch (err) {
      console.warn('[AutoApply] Could not load overlay CSS into shadow root:', err);
    }

    // Create the overlay container element inside shadow root
    overlayContainer = document.createElement('div');
    overlayContainer.className = 'autoapply-overlay';
    applyOverlayTheme();
    shadowRoot.appendChild(overlayContainer);

    showLoading('Scanning this page and preparing your review…');

    // Workday is a React SPA — landing, sign-in, and create-account all share the same URL.
    // Detect the current step by inspecting the DOM, not the URL path.
    let workdayStep = detectWorkdayStep();
    if (!workdayStep && UTILS.detectPlatform(window.location.href) === 'workday') {
      // Allow up to 1.5s for Workday React components to mount if freshly loaded
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 300));
        workdayStep = detectWorkdayStep();
        if (workdayStep) break;
      }
    }
    if (workdayStep) {
      handleWorkdayPreApplicationStep(workdayStep);
      return;
    }
    // Fallback: URL-based check catches Workday instances that redirect to a separate auth domain.
    const workdayAuthPage = UTILS.classifyWorkdayPage(window.location.href);
    if (workdayAuthPage === 'login' || workdayAuthPage === 'signup') {
      handleWorkdayPreApplicationStep({ step: 'signin_email' });
      return;
    }

    const genericAuthStep = detectGenericAuthStep();
    if (genericAuthStep) {
      handleGenericAuthStep(genericAuthStep);
      return;
    }

    try {
      const scrapeResult = SCRAPER.scrapeFormFields();
      pageFields = scrapeResult.fields;
      jdText = scrapeResult.job_description;
      pageText = scrapeResult.page_text || '';
    } catch (err) {
      console.error('[AutoApply] Scraper error:', err);
      showError('Failed to scan page fields. Check console for details.');
      return;
    }

    // Safety guard: If 0 fields were scraped on Workday, check again if this is a pre-application step
    if (pageFields.length === 0 && UTILS.detectPlatform(window.location.href) === 'workday') {
      const lateStep = detectWorkdayStep();
      if (lateStep) {
        handleWorkdayPreApplicationStep(lateStep);
        return;
      }
    }

    const url = window.location.href;
    const title = document.title;
    const platform = UTILS.detectPlatform(url);
    companyName = UTILS.extractCompany(url, title);

    // Extract a cleaner role name from the page title
    roleName = title
      .split(/ - | at | \| /i)[0]
      .replace(/Apply for|Job Application for|Opening for/i, '')
      .trim();

    try {
      const context = await loadWorkspaceContext();
      if (context?.duplicates?.length) {
        cachedDuplicateRes = { is_duplicate: true, existing: context.duplicates[0] };
        showDuplicateChoice(context.duplicates);
        return;
      }
      await prepareCurrentPage({ url, title, platform });
    } catch (err) {
      console.error('[AutoApply] Backend connection error:', err);
      if (err.message.includes('404')) showError('Finish profile setup before preparing this application.');
      else if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) showError('Start the local AutoApply backend on port 8000, then try again.');
      else showError(`Could not prepare this application: ${err.message}`);
    }
  }

  async function prepareCurrentPage({ url = window.location.href, title = document.title, platform = UTILS.detectPlatform(window.location.href), analyzeFit = true } = {}) {
    const formSchema = {
      url, platform, page_title: title, step: 1, total_steps: 1,
      fields: pageFields, job_description: jdText,
      page_text: pageText,
      opportunity_id: workspace.opportunityId,
      resume_version_id: workspace.selectedResumeVersionId,
    };
    const autofillRes = await UTILS.apiCall('/api/autofill', 'POST', formSchema);
    currentInstructions = autofillRes.instructions || [];
    preparationSummary = {
      ready_count: autofillRes.ready_count || currentInstructions.filter((item) => !item.review_required).length,
      review_count: autofillRes.review_count || currentInstructions.filter((item) => item.review_required).length,
      skipped_count: autofillRes.skipped_count || currentInstructions.filter((item) => item.action === 'skip').length,
    };
    originalInstructionsMap.clear();
    currentInstructions.forEach((inst) => originalInstructionsMap.set(inst.field_id, inst.value));
    renderMainUI();
    await saveWorkspacePacket('ready_to_review');
    if (analyzeFit && jdText && jdText.length >= 100) analyzeFitProgressively();
    return autofillRes;
  }

  async function analyzeFitProgressively() {
    try {
      const analysis = await UTILS.apiCall('/api/analyze-job', 'POST', { job_description: jdText });
      if (analysis?.recommendation === 'unknown' && analysis?.score === 0) return;
      jobAnalysis = analysis;
      if (workspace.opportunityId) {
        await UTILS.workspaceCall(`/opportunities/${encodeURIComponent(workspace.opportunityId)}`, 'PATCH', { fit_score: analysis.score });
      }
      if (overlayContainer && !overlayContainer.querySelector('.autoapply-field-input')) renderMainUI();
    } catch (error) {
      console.warn('[AutoApply] Fit analysis is unavailable:', error);
    }
  }

  function showDuplicateChoice(matches) {
    if (!overlayContainer) return;
    const first = matches[0];
    overlayContainer.innerHTML = `
      <div class="autoapply-header"><div class="autoapply-logo">${BRAND_MARK}<span>AutoApply</span></div><button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button></div>
      <div class="autoapply-duplicate-choice"><p class="autoapply-kicker">Already tracked?</p><h2>${UTILS.escapeHTML(first.company || companyName)} · ${UTILS.escapeHTML(first.role || roleName)}</h2><p>${UTILS.escapeHTML(first.match_reason || 'This looks like an application already in your workspace.')}</p><div class="autoapply-choice-actions"><button class="autoapply-btn autoapply-btn-primary autoapply-reuse-btn">Open tracked application</button><button class="autoapply-btn autoapply-btn-secondary autoapply-new-attempt-btn">Create another attempt</button></div></div>`;
    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
    overlayContainer.querySelector('.autoapply-reuse-btn').addEventListener('click', async () => {
      showLoading('Opening the tracked application…');
      try {
        const response = await browser.runtime.sendMessage({ type:'OPEN_WORKSPACE_RECORD', opportunity_id:first.id });
        if (response?.status !== 'success') throw new Error(response?.error || 'Could not open the workspace record.');
        removeOverlay();
      }
      catch (error) { showError(error.message); }
    });
    overlayContainer.querySelector('.autoapply-new-attempt-btn').addEventListener('click', async () => {
      showLoading('Preparing another attempt…');
      try { await loadWorkspaceContext({ duplicateResolution:'create_new' }); await prepareCurrentPage(); }
      catch (error) { showError(error.message); }
    });
  }

  async function prepareApplicationSilently(message = {}) {
    try {
      const scrapeResult = SCRAPER.scrapeFormFields();
      pageFields = scrapeResult.fields;
      jdText = scrapeResult.job_description;
      pageText = scrapeResult.page_text || '';
      const url = window.location.href;
      const title = document.title;
      const platform = UTILS.detectPlatform(url);
      companyName = UTILS.extractCompany(url, title);
      roleName = title.split(/ - | at | \| /i)[0].replace(/Apply for|Job Application for|Opening for/i, '').trim();
      const context = await loadWorkspaceContext({ duplicateResolution:message.duplicate_resolution || '', existingId:message.existing_id || null });
      if (context?.duplicates?.length && !message.duplicate_resolution) {
        return { ok:true, status:'duplicate', matches:context.duplicates, title:`${roleName} · ${companyName}` };
      }
      const result = await prepareCurrentPage({ url, title, platform, analyzeFit:false });
      if (jdText && jdText.length >= 100) {
        try {
          const analysis = await UTILS.apiCall('/api/analyze-job', 'POST', { job_description:jdText });
          if (analysis?.recommendation !== 'unknown' && workspace.opportunityId) {
            jobAnalysis = analysis;
            await UTILS.workspaceCall(`/opportunities/${encodeURIComponent(workspace.opportunityId)}`, 'PATCH', { fit_score:analysis.score });
          }
        } catch (_) { /* Fit is intentionally non-blocking. */ }
      }
      return { ok:true, status:'ready', opportunity_id:workspace.opportunityId, reused:Boolean(context?.opportunity?.reused), title:`${roleName} · ${companyName}`, fit_score:jobAnalysis?.score, ready_count:result.ready_count, review_count:result.review_count };
    } catch (error) {
      recordIssue(error.message || 'Preparation failed', { source: 'batch_prepare' });
      return { ok:false, error:error.message || 'Preparation failed' };
    }
  }

  function looksLikeApplicationPage() {
    if (!/^https?:/i.test(window.location.href)) return false;
    // Never treat a Workday login or sign-up URL as an application page.
    const workdayUrlType = UTILS.classifyWorkdayPage(window.location.href);
    if (workdayUrlType === 'login' || workdayUrlType === 'signup') return false;

    // For Workday:
    if (UTILS.detectPlatform(window.location.href) === 'workday') {
      const step = detectWorkdayStep();
      // On Workday landing page or job posting, show the chip so the user can launch auto mode with 1 click!
      if (step && (step.step === 'landing' || step.step === 'job_apply')) return true;
      if (findWorkdayJobApplyButton() || findWorkdayLandingButton()) return true;
      if (step) return false;
    }

    const identity = `${window.location.href} ${document.title}`.toLowerCase();
    const knownPage = /(workdayjobs|greenhouse|lever\.co|ashbyhq|icims|smartrecruiters|taleo|oraclecloud|darwinbox|keka|\/apply(?:\/|\?|$)|application)/.test(identity);
    const visibleFields = [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')]
      .filter((element) => element.offsetParent !== null && !element.disabled).length;
    return (knownPage && visibleFields >= 2) || Boolean(findGenericJobApplyButton());
  }

  // ─── Workday Auto Mode & Step Detection ──────────────────────────────────
  let workdayAutoMode = true;
  let workdayObserver = null;
  let workdayPollTimer = null;
  let workdayOtpInterval = null;

  function stopWorkdayWatcher() {
    if (workdayObserver) { workdayObserver.disconnect(); workdayObserver = null; }
    if (workdayPollTimer) { clearInterval(workdayPollTimer); workdayPollTimer = null; }
    if (workdayOtpInterval) { clearInterval(workdayOtpInterval); workdayOtpInterval = null; }
  }

  function triggerClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return true;
    } catch (err) {
      console.warn('[AutoApply] Click error:', err);
      try { el.click(); return true; } catch (_) { return false; }
    }
  }

  function fillNativeInput(input, value) {
    if (!input) return false;
    input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    input.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: String(value).slice(-1) }));
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return true;
  }

  function visibleAuthInputs() {
    return [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
      .filter((el) => {
        if (el.closest('#autoapply-shadow-host,#autoapply-ready-chip-host')) return false;
        if (el.disabled || el.offsetParent === null) return false;
        if (el.closest('header, nav, [role="search"], [role="banner"], [class*="search"]')) return false;
        return (el.type || '').toLowerCase() !== 'search';
      });
  }

  function authControlText(el) {
    return [
      el.textContent,
      el.value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('data-automation-id'),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function visibleAuthControls() {
    return [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="button"], input[type="submit"]'),
      ...document.querySelectorAll('a[role="button"], [role="button"]'),
    ].filter((el) => !el.closest('#autoapply-shadow-host,#autoapply-ready-chip-host') && !el.disabled && el.offsetParent !== null);
  }

  function findGenericAuthButton(pattern) {
    const controls = visibleAuthControls();
    return controls.find((el) => pattern.test(authControlText(el))) || null;
  }

  function detectGenericAuthStep() {
    if (!/^https?:/i.test(window.location.href)) return null;

    const inputs = visibleAuthInputs();
    const passwordInputs = inputs.filter((el) => (el.type || '').toLowerCase() === 'password');
    const emailInputs = inputs.filter((el) => {
      const identity = [
        el.type,
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute('aria-label'),
        el.getAttribute('autocomplete'),
        el.getAttribute('data-automation-id'),
      ].filter(Boolean).join(' ').toLowerCase();
      return /\b(email|e-mail|username|user name|login id|candidate email)\b/.test(identity);
    });
    const codeInput = inputs.find((el) => {
      const identity = [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute('aria-label'),
        el.getAttribute('autocomplete'),
        el.getAttribute('data-automation-id'),
      ].filter(Boolean).join(' ').toLowerCase();
      return (el.getAttribute('maxlength') === '6' || el.getAttribute('size') === '6' || /\b(code|otp|verification)\b/.test(identity));
    });

    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
    const authHeading = [...document.querySelectorAll('h1,h2,h3,[role="dialog"],[aria-modal="true"]')]
      .filter((el) => !el.closest('#autoapply-shadow-host,#autoapply-ready-chip-host') && el.offsetParent !== null)
      .some((el) => /\b(sign in|sign-in|log in|login|create an account|verification code|security code)\b/i.test(el.textContent || ''));
    const authHelpText = /\b(first time here|forgot password|sign in using|sign in with|create an account|check your email)\b/i.test(bodyText);
    const hasAuthText = authHeading || authHelpText || passwordInputs.length > 0 || Boolean(codeInput);
    const hasAuthButton = Boolean(findGenericAuthButton(/\b(continue|next|sign in|log in|login|verify|submit code|create account)\b/i));
    const smallAuthForm = inputs.length > 0 && inputs.length <= 4;
    if (!hasAuthText || !hasAuthButton || !smallAuthForm) return null;

    if (codeInput && /\b(verification code|security code|one-time|otp|check your email)\b/i.test(bodyText)) {
      return { step: 'generic_otp', otpInput: codeInput };
    }

    if (passwordInputs.length) {
      return {
        step: 'generic_password',
        emailInput: emailInputs[0] || null,
        passwordInputs,
        btn: findGenericAuthButton(/\b(sign in|log in|login|continue|next)\b/i),
      };
    }

    if (emailInputs.length) {
      return {
        step: 'generic_email_continue',
        emailInput: emailInputs[0],
        btn: findGenericAuthButton(/\b(continue|next|sign in|log in|login)\b/i),
      };
    }

    return null;
  }

  async function getLocalCredentialsOrEmail() {
    const credsResp = await browser.runtime.sendMessage({ type: 'GET_WORKDAY_CREDENTIALS' }).catch(() => null);
    if (credsResp && credsResp.status === 'success' && credsResp.email) {
      return { email: credsResp.email, password: credsResp.password || '' };
    }

    const profileResp = await browser.runtime.sendMessage({ type: 'GET_PROFILE_EMAIL' }).catch(() => null);
    if (profileResp && profileResp.status === 'success' && profileResp.email) {
      return { email: profileResp.email, password: '' };
    }
    return { email: '', password: '' };
  }

  function watchForGenericAuthNextStep(currentStep) {
    stopWorkdayWatcher();

    let resolved = false;
    const checkNext = () => {
      if (resolved) return;
      const nextAuth = detectGenericAuthStep();
      if (nextAuth && nextAuth.step !== currentStep) {
        resolved = true;
        stopWorkdayWatcher();
        handleGenericAuthStep(nextAuth);
        return;
      }

      if (!nextAuth) {
        const applicationInputs = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
          .filter((el) => !el.closest('#autoapply-shadow-host,#autoapply-ready-chip-host') && !el.disabled && el.offsetParent !== null);
        if (applicationInputs.length >= 2 || findGenericJobApplyButton() || isSubmissionConfirmationPage()) {
          resolved = true;
          stopWorkdayWatcher();
          updateWorkdayAutoStatus('Signed in. Resuming application autofill...');
          setTimeout(startAutomaticFillFlow, 700);
        }
      }
    };

    workdayObserver = new MutationObserver(UTILS.debounce(checkNext, 300));
    workdayObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    workdayPollTimer = setInterval(checkNext, 500);
  }

  async function executeGenericAuthStep(stepInfo) {
    try {
      if (stepInfo.step === 'generic_email_continue') {
        updateWorkdayAutoStatus('Filling sign-in email...');
        const creds = await getLocalCredentialsOrEmail();
        if (!creds.email) throw new Error('No email found in profile or saved local credentials.');
        fillNativeInput(stepInfo.emailInput, creds.email);
        await new Promise((r) => setTimeout(r, 350));
        const btn = stepInfo.btn || findGenericAuthButton(/\b(continue|next|sign in|log in|login)\b/i);
        if (!btn) throw new Error('Could not find the sign-in Continue button.');
        triggerClick(btn);
        updateWorkdayAutoStatus('Email submitted. Waiting for the next sign-in step...');
        watchForGenericAuthNextStep('generic_email_continue');
        return;
      }

      if (stepInfo.step === 'generic_password') {
        updateWorkdayAutoStatus('Filling saved password...');
        const creds = await getLocalCredentialsOrEmail();
        if (!creds.password) throw new Error('No saved password found. Add it to backend/data/workday_auth.json or save Workday credentials.');
        if (stepInfo.emailInput && !stepInfo.emailInput.value && creds.email) {
          fillNativeInput(stepInfo.emailInput, creds.email);
          await new Promise((r) => setTimeout(r, 150));
        }
        for (const input of stepInfo.passwordInputs || []) {
          fillNativeInput(input, creds.password);
          await new Promise((r) => setTimeout(r, 150));
        }
        const btn = stepInfo.btn || findGenericAuthButton(/\b(sign in|log in|login|continue|next)\b/i);
        if (!btn) throw new Error('Could not find the sign-in button.');
        triggerClick(btn);
        updateWorkdayAutoStatus('Sign-in submitted. Waiting for the application form...');
        watchForGenericAuthNextStep('generic_password');
        return;
      }

      if (stepInfo.step === 'generic_otp') {
        renderWorkdayOtpPanel(stepInfo.otpInput);
      }
    } catch (error) {
      recordIssue(error.message || 'Generic sign-in automation failed.', { source: 'generic_auth' });
      updateWorkdayAutoStatus(`Sign-in needs help: ${error.message}`);
    }
  }

  function handleGenericAuthStep(stepInfo) {
    const isPassword = stepInfo.step === 'generic_password';
    const isOtp = stepInfo.step === 'generic_otp';
    renderWorkdayAutoPanel({
      icon: isOtp ? '📧' : '🔐',
      title: isOtp ? 'Verification Code' : isPassword ? 'Sign In Password' : 'Sign In Email',
      stepBadge: isOtp ? 'AUTH: OTP' : 'AUTH: SIGN IN',
      status: isOtp ? 'Reading verification code automatically...' : 'Continuing sign-in automatically...',
      manualActionText: isOtp ? 'Retry OTP Check' : isPassword ? 'Fill & Sign In' : 'Continue Sign In',
      onManualAction: () => executeGenericAuthStep(stepInfo),
    });
    setTimeout(() => executeGenericAuthStep(stepInfo), 500);
  }

  function checkAgreementCheckbox() {
    const checkbox = document.querySelector('[data-automation-id="createAccountCheckbox"]') ||
      [...document.querySelectorAll('input[type="checkbox"]')].find((el) => {
        if (el.closest('#autoapply-shadow-host')) return false;
        const idStr = `${el.id} ${el.name} ${el.getAttribute('data-automation-id') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
        return /createaccount|legal|agree|term|privacy/i.test(idStr);
      }) || document.querySelector('input[type="checkbox"]');

    if (checkbox && !checkbox.closest('#autoapply-shadow-host')) {
      if (!checkbox.checked) {
        checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        checkbox.focus();
        checkbox.click();
        if (!checkbox.checked) {
          checkbox.checked = true;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          checkbox.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return true;
    }
    return false;
  }

  function findWorkdaySubmitBtn(stepType) {
    const byId = document.querySelector(
      '[data-automation-id="createAccountSubmitButton"], ' +
      '[data-automation-id="signInSubmitButton"], ' +
      '[data-automation-id*="createAccount"], ' +
      '[data-automation-id*="signIn"], ' +
      '[data-automation-id*="submit"], ' +
      '[data-automation-id*="verify"], ' +
      'button[type="submit"]'
    );
    if (byId && !byId.closest('#autoapply-shadow-host')) {
      return byId.closest('button, [role="button"]') || byId;
    }

    const buttons = [...document.querySelectorAll('button, [role="button"], a[role="button"]')];
    const isSignup = stepType === 'create_account';
    const target = isSignup ? /(create account|sign up|register)/i : /(sign in|log in|continue|verify)/i;

    const matched = buttons.find((b) => !b.closest('#autoapply-shadow-host') && target.test(b.textContent || ''));
    if (matched) return matched;

    return buttons.find((b) => !b.closest('#autoapply-shadow-host') && /(submit|continue|next|sign in|create account)/i.test(b.textContent || ''));
  }

  function findWorkdayLandingButton() {
    // 1. Attribute selectors
    const byAttr = document.querySelector(
      '[data-automation-id="autofillWithResume"], ' +
      '[data-automation-id="autofillWithResumeButton"], ' +
      '[data-automation-id="applyWithResumeButton"], ' +
      '[data-automation-id="applyWithResume"], ' +
      '[data-automation-id*="autofillWithResume"], ' +
      '[data-automation-id*="applyWithResume"], ' +
      '[data-automation-id*="autofill"]'
    );
    if (byAttr && !byAttr.closest('#autoapply-shadow-host')) {
      return byAttr.closest('button, a, [role="button"]') || byAttr;
    }

    // 2. Candidates in DOM
    const candidates = [...document.querySelectorAll('button, a, [role="button"], div[tabindex], div[data-automation-id], div, span, p')];
    for (const el of candidates) {
      if (el.closest('#autoapply-shadow-host')) continue;
      const txt = (el.textContent || '').trim();
      if (/^autofill\s+with\s+resume$/i.test(txt) || (el.children.length === 0 && /autofill\s+with\s+resume/i.test(txt))) {
        return el.closest('button, a, [role="button"], [tabindex], [data-automation-id]') || el;
      }
    }

    for (const el of candidates) {
      if (el.closest('#autoapply-shadow-host')) continue;
      if (/autofill\s+with\s+resume/i.test(el.textContent || '')) {
        return el.closest('button, a, [role="button"], [tabindex]') || el;
      }
    }

    // 3. Fallback: "Apply Manually"
    const manualById = document.querySelector('[data-automation-id="applyManually"], [data-automation-id*="applyManually"]');
    if (manualById && !manualById.closest('#autoapply-shadow-host')) {
      return manualById.closest('button, a, [role="button"]') || manualById;
    }
    for (const el of candidates) {
      if (el.closest('#autoapply-shadow-host')) continue;
      if (/apply\s+manually/i.test(el.textContent || '')) {
        return el.closest('button, a, [role="button"], [tabindex]') || el;
      }
    }

    return null;
  }

  function isWorkdayLandingHeading() {
    const headingElements = [...document.querySelectorAll('h1, h2, h3, h4, [data-automation-id*="title"], [data-automation-id*="heading"], [class*="heading"], [class*="title"], p, div')];
    return headingElements.some((el) => {
      if (el.closest('#autoapply-shadow-host')) return false;
      const text = (el.textContent || '').trim();
      return /^start\s+your\s+application$/i.test(text) || (/start\s+your\s+application/i.test(text) && text.length < 80);
    });
  }

  function findWorkdayJobApplyButton() {
    // 1. Attribute selectors (Workday uses 'adventureButton' or 'applyButton')
    const byAttr = document.querySelector(
      '[data-automation-id="adventureButton"], ' +
      '[data-automation-id="adventureButtonTop"], ' +
      '[data-automation-id="adventureButtonBottom"], ' +
      '[data-automation-id*="adventureButton"], ' +
      '[data-automation-id="applyButton"], ' +
      '[data-automation-id*="applyButton"], ' +
      '[data-uxi-element-id*="Apply_adventureButton"], ' +
      '[data-uxi-element-id*="Apply"], ' +
      'a[href*="/apply"]'
    );
    if (byAttr && !byAttr.closest('#autoapply-shadow-host')) {
      return byAttr.closest('button, a, [role="button"]') || byAttr;
    }

    // 2. Candidates in DOM (visible buttons/links with Apply text)
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
    for (const el of candidates) {
      if (el.closest('#autoapply-shadow-host, header, nav, [role="search"], [role="banner"]')) continue;
      const href = el.getAttribute('href') || '';
      const txt = (el.textContent || '').trim();
      if (/\/apply(\?|\/|$)/i.test(href) && !/linkedin|indeed/i.test(txt)) {
        return el;
      }
      if (/^\s*apply(\s+now|\s+to\s+job)?\s*$/i.test(txt) && !/linkedin|indeed/i.test(txt)) {
        return el;
      }
    }

    return null;
  }

  function findGenericJobApplyButton() {
    if (UTILS.detectPlatform(window.location.href) === 'workday') {
      return findWorkdayJobApplyButton() || findWorkdayLandingButton();
    }
    const byAttr = document.querySelector(
      '[data-qa="btn-apply"], ' +
      '[data-automation-id="adventureButton"], ' +
      '[data-automation-id="applyButton"], ' +
      'a.postings-btn, ' +
      'a[href*="#apply"], ' +
      'a[href*="/apply"], ' +
      'button[aria-label*="Apply"]'
    );
    if (byAttr && !byAttr.closest('#autoapply-shadow-host')) {
      return byAttr.closest('button, a, [role="button"]') || byAttr;
    }
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
    for (const el of candidates) {
      if (el.closest('#autoapply-shadow-host, header, nav')) continue;
      const text = (el.textContent || '').trim();
      const href = el.getAttribute('href') || '';
      if (/^\s*apply(\s+now|\s+to\s+job)?\s*$/i.test(text) && !/linkedin|indeed/i.test(text)) {
        return el;
      }
      if (/\/apply(\?|\/|#|$)/i.test(href) && !/linkedin|indeed/i.test(text)) {
        return el;
      }
    }
    return null;
  }

  /**
   * Detect the current step in a Workday multi-step application flow by inspecting the DOM.
   * Workday is a React SPA — all pre-application steps share the same URL.
   */
  function detectWorkdayStep() {
    if (UTILS.detectPlatform(window.location.href) !== 'workday') return null;

    // Filter out hidden, disabled, and navigation/header/search inputs so they don't corrupt step detection
    const inputs = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
      .filter((el) => !el.closest('#autoapply-shadow-host') && !el.disabled && !el.closest('header, nav, [role="search"], [role="banner"], [class*="search"]') && el.type !== 'search');
    const passwordInputs = inputs.filter((el) => el.type === 'password');
    const emailInputs = inputs.filter((el) => el.type === 'email' || el.getAttribute('data-automation-id') === 'email' || /email|username/i.test(el.name || el.id || el.getAttribute('autocomplete') || ''));

    // ── Step: OTP / verification code input ───────────────────────────────
    const otpInput =
      document.querySelector('[data-automation-id="verificationCode"]') ||
      document.querySelector('input[maxlength="6"][type="text"]') ||
      document.querySelector('input[maxlength="6"]') ||
      inputs.find((el) => el.getAttribute('maxlength') === '6' || el.getAttribute('size') === '6' || /code|otp|verify/i.test(el.name || el.id || ''));

    const visibleText = (document.body?.innerText || '').toLowerCase();
    const hasOtpText = /(enter (?:the )?(?:verification |one-time )?code|check your email|security code|verify your identity)/i.test(visibleText);
    if (otpInput || (hasOtpText && inputs.length <= 2)) {
      return { step: 'otp', otpInput: otpInput || inputs[0] };
    }

    // ── Step: "Create Account" form ──────────────────────────────────────────
    const hasVerifyPassword = Boolean(document.querySelector('[data-automation-id="verifyPassword"]'));
    const hasCreateAccountTitle = [...document.querySelectorAll('h1,h2,h3,h4,[data-automation-id*="title"],[data-automation-id*="heading"],[class*="title"],[class*="heading"],legend')]
      .some((h) => !h.closest('#autoapply-shadow-host') && /create\s+account/i.test(h.textContent));

    if (hasVerifyPassword || passwordInputs.length >= 2 || (hasCreateAccountTitle && passwordInputs.length >= 1)) {
      return { step: 'create_account' };
    }

    // ── Step: Email+password sign-in form ────────────────────────────────────
    const hasSignInSubmit = Boolean(document.querySelector('[data-automation-id="signInSubmitButton"]'));
    const createAccountTab = document.querySelector('[data-automation-id="createAccountLink"]') ||
      [...document.querySelectorAll('button, [role="tab"], a, [role="button"]')]
        .find((el) => !el.closest('#autoapply-shadow-host') && /create\s+account/i.test(el.textContent.trim()));

    if (hasSignInSubmit || (emailInputs.length >= 1 && passwordInputs.length === 1)) {
      return { step: 'signin_email', canSwitchToCreateAccount: Boolean(createAccountTab), createAccountTab };
    }

    // ── Step: Social sign-in options (Sign in with Google / LinkedIn / email) ─
    const socialSignInBtn = document.querySelector('[data-automation-id="SignInWithEmailButton"]') ||
      [...document.querySelectorAll('button,[role="button"],a,div[tabindex]')].find(
        (el) => !el.closest('#autoapply-shadow-host') && /sign\s*in\s+with\s+email/i.test(el.textContent.trim())
      );
    if (socialSignInBtn) return { step: 'signin_social', btn: socialSignInBtn };

    // ── Step: "Start Your Application" landing page ─────────────────────────
    const landingBtn = findWorkdayLandingButton();
    const hasLandingHeading = isWorkdayLandingHeading();
    if ((hasLandingHeading || landingBtn) && inputs.length <= 1) {
      return { step: 'landing', btn: landingBtn };
    }

    // ── Step: Job Posting "Apply" button ────────────────────────────────────
    const applyJobBtn = findWorkdayJobApplyButton();
    if (applyJobBtn && inputs.length <= 1 && passwordInputs.length === 0 && !otpInput) {
      return { step: 'job_apply', btn: applyJobBtn };
    }

    return null;
  }

  function renderWorkdayAutoPanel({ icon, title, status, stepBadge, manualActionText, onManualAction }) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">${BRAND_MARK}<span>AutoApply • Auto Mode</span></div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-auth-notice">
        <div class="autoapply-auth-icon">${icon}</div>
        <h2>${UTILS.escapeHTML(title)}</h2>
        <div class="autoapply-auto-badge"><span class="autoapply-pulse-indicator"></span>${stepBadge || '⚡ AUTOMATICALLY ADVANCING'}</div>
        <p class="autoapply-auto-status" style="font-size:13px;color:var(--aa-navy);margin-top:6px;font-weight:600;">${UTILS.escapeHTML(status)}</p>
        ${manualActionText ? `
          <div style="margin-top:10px;display:flex;gap:8px;flex-direction:column;width:100%;max-width:240px;">
            <button class="autoapply-btn autoapply-btn-primary autoapply-manual-action-btn">${UTILS.escapeHTML(manualActionText)}</button>
            <button class="autoapply-btn autoapply-btn-secondary autoapply-pause-btn" style="font-size:11px;">Pause Auto Mode</button>
          </div>
        ` : `
          <div style="margin-top:10px;">
            <button class="autoapply-btn autoapply-btn-secondary autoapply-pause-btn" style="font-size:11px;">Pause Auto Mode</button>
          </div>
        `}
        <p class="autoapply-auth-note">Credentials &amp; OTP handled locally — never sent to AI.</p>
      </div>
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', () => {
      stopWorkdayWatcher();
      workdayAutoMode = false;
      removeOverlay();
    });

    overlayContainer.querySelector('.autoapply-pause-btn')?.addEventListener('click', () => {
      workdayAutoMode = false;
      stopWorkdayWatcher();
      const statusEl = overlayContainer.querySelector('.autoapply-auto-status');
      if (statusEl) statusEl.textContent = 'Auto mode paused. Click manual buttons or fill directly.';
      const badge = overlayContainer.querySelector('.autoapply-auto-badge');
      if (badge) { badge.textContent = '⏸ PAUSED'; badge.style.color = '#855100'; }
    });

    if (manualActionText && onManualAction) {
      overlayContainer.querySelector('.autoapply-manual-action-btn')?.addEventListener('click', onManualAction);
    }
  }

  function updateWorkdayAutoStatus(statusText) {
    if (!overlayContainer) return;
    const el = overlayContainer.querySelector('.autoapply-auto-status');
    if (el) el.textContent = statusText;
  }

  function watchForWorkdayNextStep(currentStep) {
    stopWorkdayWatcher();

    let resolved = false;
    const checkNext = () => {
      if (resolved || !workdayAutoMode) return;
      const next = detectWorkdayStep();

      if (next && next.step !== currentStep) {
        resolved = true;
        stopWorkdayWatcher();
        handleWorkdayPreApplicationStep(next);
        return;
      }

      if (!next) {
        const inputs = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
          .filter((el) => !el.closest('#autoapply-shadow-host') && !el.disabled);
        if (inputs.length >= 2) {
          resolved = true;
          stopWorkdayWatcher();
          updateWorkdayAutoStatus('✓ Verified! Launching application autofill…');
          setTimeout(() => {
            startScanningFlow();
          }, 800);
        }
      }
    };

    workdayObserver = new MutationObserver(UTILS.debounce(checkNext, 300));
    workdayObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    workdayPollTimer = setInterval(checkNext, 400);
  }

  async function executeWorkdayCredentialsFill(preferSignup) {
    try {
      updateWorkdayAutoStatus('Fetching credentials from local backend…');
      const credsResp = await browser.runtime.sendMessage({ type: 'GET_WORKDAY_CREDENTIALS' });
      if (!credsResp || credsResp.status !== 'success' || !credsResp.email) {
        throw new Error('No Workday credentials found. Check backend/data/workday_auth.json.');
      }
      const { email, password } = credsResp;

      if (preferSignup) {
        const createAccountLink = document.querySelector('[data-automation-id="createAccountLink"]') ||
          [...document.querySelectorAll('button, [role="tab"], a, [role="button"]')]
            .find((el) => !el.closest('#autoapply-shadow-host') && /create\s+account/i.test(el.textContent.trim()));
        if (createAccountLink && createAccountLink.getAttribute('aria-selected') !== 'true') {
          updateWorkdayAutoStatus('Switching to Create Account form…');
          triggerClick(createAccountLink);
          await new Promise((r) => setTimeout(r, 600));
        }
      }

      // Re-query inputs after tab switch
      const inputs = [...document.querySelectorAll('input:not([type="hidden"])')]
        .filter((el) => !el.closest('#autoapply-shadow-host') && !el.disabled);

      const emailInput = document.querySelector('[data-automation-id="email"]') ||
        inputs.find((el) => el.type === 'email' || el.getAttribute('data-automation-id') === 'email' || /email|username/i.test(el.name || el.id || el.getAttribute('autocomplete') || '')) ||
        document.querySelector('input[type="text"][autocomplete="email"]');
      if (!emailInput) throw new Error('Email input field not found on page.');

      updateWorkdayAutoStatus('Filling email…');
      fillNativeInput(emailInput, email);
      await new Promise((r) => setTimeout(r, 350));

      const pwInput = document.querySelector('[data-automation-id="password"]') ||
        document.querySelector('input[type="password"]');

      if (pwInput) {
        updateWorkdayAutoStatus('Filling password…');
        fillNativeInput(pwInput, password);
        await new Promise((r) => setTimeout(r, 250));
      }

      const verifyPwInput = document.querySelector('[data-automation-id="verifyPassword"]') ||
        [...document.querySelectorAll('input[type="password"]')][1];

      if (verifyPwInput) {
        updateWorkdayAutoStatus('Filling password verification…');
        fillNativeInput(verifyPwInput, password);
        await new Promise((r) => setTimeout(r, 250));
      }

      // Check Terms checkbox if on Create Account
      if (preferSignup || document.querySelector('[data-automation-id="createAccountCheckbox"]')) {
        updateWorkdayAutoStatus('Accepting agreements…');
        checkAgreementCheckbox();
        await new Promise((r) => setTimeout(r, 400));
      }

      updateWorkdayAutoStatus('Submitting credentials…');
      const submitBtn = findWorkdaySubmitBtn(preferSignup ? 'create_account' : 'signin_email');
      if (submitBtn) {
        triggerClick(submitBtn);
        updateWorkdayAutoStatus('✓ Credentials submitted! Waiting for next step…');
      } else {
        updateWorkdayAutoStatus('Submitted! Waiting for next step…');
      }

      // Check if an error banner appears (e.g. "An account with this email already exists")
      setTimeout(async () => {
        const errorText = (document.body?.innerText || '');
        if (/already exists|already registered/i.test(errorText)) {
          updateWorkdayAutoStatus('Account already exists! Switching to Sign In…');
          const signInLink = document.querySelector('[data-automation-id="signInLink"]') ||
            [...document.querySelectorAll('button, a')].find((el) => !el.closest('#autoapply-shadow-host') && /sign\s*in/i.test(el.textContent.trim()));
          if (signInLink) {
            triggerClick(signInLink);
            await new Promise((r) => setTimeout(r, 600));
            executeWorkdayCredentialsFill(false);
            return;
          }
        }
      }, 1500);

      watchForWorkdayNextStep(preferSignup ? 'create_account' : 'signin_email');
    } catch (err) {
      console.error('[AutoApply] Credentials fill error:', err);
      recordIssue(err.message || 'Credentials fill failed', { source: 'workday_credentials' });
      updateWorkdayAutoStatus(`Error: ${err.message}`);
    }
  }

  function renderWorkdayOtpPanel(otpInputEl) {
    if (!overlayContainer) return;
    renderWorkdayAutoPanel({
      icon: '📧',
      title: 'Email Verification Code',
      stepBadge: 'STEP 3: OTP VERIFICATION',
      status: 'Workday sent a verification code to Gmail. Reading OTP automatically…',
      manualActionText: 'Retry OTP Check',
      onManualAction: () => pollForOtp(),
    });

    let attempts = 0;
    const MAX_ATTEMPTS = 25; // ~60 seconds

    async function pollForOtp() {
      attempts++;
      if (attempts > MAX_ATTEMPTS) {
        stopWorkdayWatcher();
        recordIssue('No OTP received after 60 seconds.', { source: 'workday_otp' });
        updateWorkdayAutoStatus('No OTP received after 60s. Check Gmail manually or retry.');
        return;
      }

      updateWorkdayAutoStatus(`Checking Gmail for verification code… (${attempts}/${MAX_ATTEMPTS})`);
      try {
        const resp = await browser.runtime.sendMessage({ type: 'GET_WORKDAY_OTP', max_age_minutes: 10 });
        if (resp && resp.found && resp.otp) {
          stopWorkdayWatcher();
          const code = resp.otp;
          updateWorkdayAutoStatus(`✓ OTP found: ${code}! Entering code…`);

          const targetInput = (otpInputEl && otpInputEl.offsetParent && !otpInputEl.closest('#autoapply-shadow-host'))
            ? otpInputEl
            : document.querySelector('[data-automation-id="verificationCode"], input[maxlength="6"]') ||
              [...document.querySelectorAll('input[type="text"], input[type="number"]')].find(
                (el) => !el.closest('#autoapply-shadow-host') &&
                        (el.getAttribute('maxlength') === '6' || el.getAttribute('size') === '6' || /code|otp|verify/i.test(el.name || el.id || ''))
              );

          if (targetInput) {
            fillNativeInput(targetInput, code);
            await new Promise((r) => setTimeout(r, 400));
          }

          const verifyBtn = document.querySelector('[data-automation-id*="verify"], [data-automation-id*="submit"]') ||
            [...document.querySelectorAll('button, [role="button"]')].find(
              (b) => !b.closest('#autoapply-shadow-host') && /(verify|submit|continue|next)/i.test(b.textContent.trim())
            );

          if (verifyBtn) {
            triggerClick(verifyBtn);
            updateWorkdayAutoStatus(`✓ OTP ${code} submitted! Waiting for application form…`);
          } else {
            updateWorkdayAutoStatus(`✓ OTP ${code} filled! Submit to continue.`);
          }

          watchForWorkdayNextStep('otp');
        }
      } catch (err) {
        console.warn('[AutoApply] OTP poll error:', err);
      }
    }

    stopWorkdayWatcher();
    pollForOtp();
    workdayOtpInterval = setInterval(pollForOtp, 2500);
  }

  async function handleWorkdayPreApplicationStep(stepInfo) {
    if (!stepInfo) return;
    workdayAutoMode = true;

    switch (stepInfo.step) {
      case 'job_apply': {
        renderWorkdayAutoPanel({
          icon: '💼',
          title: 'Workday Job Posting',
          stepBadge: 'STEP 1: START APPLICATION',
          status: 'Auto-clicking “Apply” to begin…',
          manualActionText: 'Click “Apply” →',
          onManualAction: () => {
            const btn = stepInfo.btn || findWorkdayJobApplyButton();
            if (btn) {
              triggerClick(btn);
              if (btn.tagName === 'A' && btn.href && !btn.href.startsWith('javascript:')) {
                setTimeout(() => {
                  if (window.location.href.indexOf('/apply') === -1 && !findWorkdayLandingButton()) {
                    window.location.href = btn.href;
                  }
                }, 1000);
              }
            }
          },
        });
        if (workdayAutoMode) {
          setTimeout(() => {
            if (!workdayAutoMode) return;
            const btn = stepInfo.btn || findWorkdayJobApplyButton();
            if (btn) {
              triggerClick(btn);
              updateWorkdayAutoStatus('✓ Clicked “Apply”. Waiting for application options…');
              if (btn.tagName === 'A' && btn.href && !btn.href.startsWith('javascript:')) {
                setTimeout(() => {
                  if (window.location.href.indexOf('/apply') === -1 && !findWorkdayLandingButton()) {
                    window.location.href = btn.href;
                  }
                }, 1200);
              }
            } else {
              updateWorkdayAutoStatus('Searching for Apply button…');
            }
            watchForWorkdayNextStep('job_apply');
          }, 600);
        }
        break;
      }

      case 'landing': {
        renderWorkdayAutoPanel({
          icon: '📋',
          title: 'Start Your Application',
          stepBadge: 'STEP 1: SELECT AUTOFILL',
          status: 'Auto-clicking “Autofill with Resume”…',
          manualActionText: 'Click “Autofill with Resume”',
          onManualAction: () => {
            const btn = stepInfo.btn || findWorkdayLandingButton();
            if (btn) triggerClick(btn);
          },
        });
        if (workdayAutoMode) {
          setTimeout(() => {
            if (!workdayAutoMode) return;
            const btn = stepInfo.btn || findWorkdayLandingButton();
            if (btn) {
              triggerClick(btn);
              updateWorkdayAutoStatus('✓ Selected Autofill with Resume! Loading sign-in/account…');
            } else {
              updateWorkdayAutoStatus('Searching for Autofill button…');
            }
            watchForWorkdayNextStep('landing');
          }, 700);
        }
        break;
      }

      case 'signin_social': {
        renderWorkdayAutoPanel({
          icon: '🔐',
          title: 'Sign In Options',
          stepBadge: 'STEP 2: EMAIL SIGN-IN',
          status: 'Selecting email sign-in…',
          manualActionText: 'Sign in with email →',
          onManualAction: () => triggerClick(stepInfo.btn),
        });
        if (workdayAutoMode) {
          setTimeout(() => {
            if (!workdayAutoMode) return;
            triggerClick(stepInfo.btn);
            updateWorkdayAutoStatus('✓ Opening email credentials form…');
            watchForWorkdayNextStep('signin_social');
          }, 600);
        }
        break;
      }

      case 'signin_email':
      case 'create_account': {
        const isSignup = stepInfo.step === 'create_account' || Boolean(stepInfo.createAccountTab);
        renderWorkdayAutoPanel({
          icon: isSignup ? '📝' : '🔐',
          title: isSignup ? 'Create Workday Account' : 'Sign In to Workday',
          stepBadge: isSignup ? 'STEP 2: CREATE ACCOUNT' : 'STEP 2: SIGN IN',
          status: 'Fetching saved credentials & filling form…',
          manualActionText: 'Fill & Submit Credentials',
          onManualAction: () => executeWorkdayCredentialsFill(isSignup),
        });

        if (workdayAutoMode) {
          setTimeout(() => {
            if (!workdayAutoMode) return;
            executeWorkdayCredentialsFill(isSignup);
          }, 600);
        }
        break;
      }

      case 'otp': {
        renderWorkdayOtpPanel(stepInfo.otpInput);
        break;
      }

      default:
        break;
    }
  }

  function removeReadyChip() {
    if (readyChipHost) readyChipHost.remove();
    readyChipHost = null;
  }

  async function startAutomaticFillFlow() {
    try {
      await startScanningFlow();
      const isSpecialFlow =
        !overlayContainer ||
        overlayContainer.querySelector('.autoapply-duplicate-choice') ||
        overlayContainer.querySelector('.autoapply-auth-notice') ||
        overlayContainer.querySelector('.autoapply-error');
      if (isSpecialFlow) return;
      if (policyBlocksAutopilot()) {
        showStatus(`AutoPilot is blocked by policy. ${policyMessage()}`.trim(), true);
        return;
      }
      await runAutoPilot();
    } catch (error) {
      recordIssue(error.message || 'Automatic fill failed to start.', { source: 'start_prompt' });
      showError(`Automatic fill could not start: ${error.message}`);
    }
  }

  function mountReadyChip() {
    if (!document.body || readyChipHost || window.__autoapply_active || promptDismissedForUrl === window.location.href || !looksLikeApplicationPage()) return;
    readyChipHost = document.createElement('div');
    readyChipHost.id = 'autoapply-ready-chip-host';
    document.body.appendChild(readyChipHost);
    const root = readyChipHost.attachShadow({ mode:'open' });
    const dark = resolvedTheme() === 'dark';
    const chipColors = dark
      ? { text:'#edf2f7', background:'#151d28', border:'#3c4b5e', hover:'#202b39', action:'#526ce7', focus:'#9aaeff' }
      : { text:'#19233a', background:'#ffffff', border:'#bcc6da', hover:'#e8edfa', action:'#3157d5', focus:'rgba(49,87,213,.45)' };
    root.innerHTML = `<style>
      .autoapply-start-card{position:fixed;right:18px;top:18px;z-index:2147483647;width:340px;max-width:calc(100vw - 36px);overflow:hidden;color:${chipColors.text};background:${chipColors.background};border:1px solid ${chipColors.border};border-top:5px solid ${chipColors.action};border-radius:8px;box-shadow:0 24px 70px rgba(0,0,0,.28);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .autoapply-start-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;background:${dark ? '#1b2740' : '#24345c'};color:#fff}
      .autoapply-start-brand{display:flex;align-items:center;gap:9px;font-weight:800}.autoapply-start-close{width:30px;height:30px;border:0;border-radius:5px;color:#c4cee4;background:transparent;font-size:18px;line-height:1;cursor:pointer}.autoapply-start-close:hover{color:#fff;background:rgba(255,255,255,.12)}
      .autoapply-start-body{padding:14px}.autoapply-start-body strong{display:block;margin-bottom:4px;color:${chipColors.text};font-size:14px}.autoapply-start-body p{margin:0;color:${dark ? '#b7c1d3' : '#63708a'};font-size:12px}
      .autoapply-start-actions{display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 14px}.autoapply-start-primary,.autoapply-start-secondary,.autoapply-training-toggle{min-height:38px;border-radius:6px;font-weight:800;cursor:pointer}.autoapply-start-primary{flex:1 1 150px;color:#fff;background:${chipColors.action};border:1px solid ${chipColors.action};box-shadow:0 3px 0 ${dark ? '#3247a8' : '#2545ad'}}.autoapply-start-primary:hover{filter:brightness(1.06)}.autoapply-start-secondary{width:82px;color:${chipColors.text};background:transparent;border:1px solid ${chipColors.border}}.autoapply-start-secondary:hover,.autoapply-training-toggle:hover{background:${chipColors.hover}}.autoapply-training-toggle{flex:1 1 100%;color:${chipColors.text};background:transparent;border:1px solid ${chipColors.border}}.autoapply-training-toggle.active{color:#fff;background:#188477;border-color:#188477}
      .autoapply-logo-icon{display:block;width:24px;height:24px;filter:drop-shadow(2px 2px 0 rgba(0,0,0,.16));transform:rotate(-1deg)}.autoapply-logo-icon svg{display:block;width:100%;height:100%}button:focus-visible{outline:3px solid ${chipColors.focus};outline-offset:3px}@media(prefers-reduced-motion:no-preference){.autoapply-start-card{animation:arrive .28s ease-out}@keyframes arrive{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}}</style>
      <div class="autoapply-start-card" role="dialog" aria-label="AutoApply job page detected">
        <div class="autoapply-start-head"><div class="autoapply-start-brand">${BRAND_MARK}<span>AutoApply</span></div><button type="button" class="autoapply-start-close" title="Close">×</button></div>
        <div class="autoapply-start-body"><strong>Job application detected</strong><p>Start filling this job automatically. AutoApply will stop before final submission.</p></div>
        <div class="autoapply-start-actions"><button type="button" class="autoapply-start-primary">Start filling job</button><button type="button" class="autoapply-start-secondary">Not now</button><button type="button" class="autoapply-training-toggle ${trainingMode ? 'active' : ''}">${trainingMode ? 'Stop training' : 'Train by watching'}</button></div>
      </div>`;
    root.querySelector('.autoapply-start-primary').addEventListener('click', startAutomaticFillFlow);
    root.querySelector('.autoapply-training-toggle').addEventListener('click', () => setTrainingMode(!trainingMode));
    root.querySelector('.autoapply-start-close').addEventListener('click', () => {
      promptDismissedForUrl = window.location.href;
      removeReadyChip();
    });
    root.querySelector('.autoapply-start-secondary').addEventListener('click', () => {
      promptDismissedForUrl = window.location.href;
      removeReadyChip();
    });
  }

  function startJobPagePromptWatcher() {
    if (jobPageObserver || jobPagePollTimer || !document.body) return;
    let lastUrl = window.location.href;
    const check = UTILS.debounce(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        promptDismissedForUrl = '';
        removeReadyChip();
      }
      mountReadyChip();
    }, 500);

    jobPageObserver = new MutationObserver(check);
    jobPageObserver.observe(document.body, { childList: true, subtree: true });
    jobPagePollTimer = setInterval(check, 1500);
    check();
  }

  /**
   * Remove the overlay element from DOM and cleanup observer.
   */
  function removeOverlay() {
    stopWorkdayWatcher();
    if (dragMoveHandler) {
      document.removeEventListener('mousemove', dragMoveHandler);
      document.removeEventListener('mouseup', dragUpHandler);
      dragMoveHandler = null;
      dragUpHandler = null;
    }
    if (shadowHost) {
      shadowHost.remove();
      shadowHost = null;
      shadowRoot = null;
      overlayContainer = null;
    }
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    window.__autoapply_active = false;
    setTimeout(mountReadyChip, 350);
  }

  /**
   * Display loading spinner inside the overlay.
   */
  function showLoading(text) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-loading">
        <div class="autoapply-spinner"></div>
        <div class="autoapply-loading-text">${UTILS.escapeHTML(text)}</div>
      </div>
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
  }

  /**
   * Display error message inside the overlay.
   */
  function showError(msg) {
    if (!overlayContainer) return;
    recordIssue(msg, { source: 'overlay' });
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-error">
        ${UTILS.escapeHTML(msg)}
      </div>
      ${renderIssueLogSection()}
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
    overlayContainer.querySelector('.autoapply-clear-log-btn')?.addEventListener('click', clearIssueLog);
  }

  /**
   * Render the main review layout of the extension overlay.
   */
  function renderMainUI() {
    if (!overlayContainer) return;

    if (isMinimized) {
      renderMinimizedUI();
      return;
    }

    const pageState = FILLER.isLastPage();
    const confirmation = isSubmissionConfirmationPage();
    const authStep = detectGenericAuthStep();
    const applyBtn = findGenericJobApplyButton();
    const isJobOverview = pageFields.length === 0 && Boolean(applyBtn);

    let primaryLabel;
    if (confirmation) {
      primaryLabel = 'Record submission';
    } else if (authStep) {
      primaryLabel = authStep.step === 'generic_password' ? 'Sign in automatically' : 'Continue sign in';
    } else if (isJobOverview) {
      primaryLabel = '🚀 Apply to this job →';
    } else if (hasFilledCurrentPage && pageState.isLast) {
      primaryLabel = 'Review final page on employer site';
    } else if (pageState.isLast) {
      primaryLabel = 'Fill reviewed fields';
    } else {
      primaryLabel = 'Fill & continue';
    }
    overlayContainer.className = 'autoapply-overlay';
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-minimize-btn" title="Minimize">─</button>
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>

      <div class="autoapply-opportunity-heading">
        <p class="autoapply-kicker">Preparing now</p>
        <h2>${UTILS.escapeHTML(companyName || 'Company')} · ${UTILS.escapeHTML(roleName || 'Role')}</h2>
        <div class="autoapply-prep-summary"><span>${preparationSummary.ready_count} ready</span><span>${preparationSummary.review_count} review</span><span>${preparationSummary.skipped_count} skipped</span></div>
      </div>
      ${renderDuplicateWarning(cachedDuplicateRes)}
      ${renderWorkspaceContext()}
      ${renderFitScoreSection()}
      ${renderTrainingSection()}
      ${renderIssueLogSection()}
      <div class="autoapply-fields">
        ${renderFieldGroups()}
      </div>
      <div class="autoapply-footer">
        <button class="autoapply-btn autoapply-btn-primary autoapply-primary-action-btn" ${hasFilledCurrentPage && pageState.isLast && !confirmation && !authStep ? 'disabled' : ''}>${primaryLabel}</button>
        <details class="autoapply-more-actions"><summary aria-label="More actions">•••</summary><div class="autoapply-action-menu">
          <button type="button" class="autoapply-fill-only-btn">Fill without continuing</button>
          ${lastFillSnapshot.length ? '<button type="button" class="autoapply-undo-btn">Undo last fill</button>' : ''}
          <button type="button" class="autoapply-training-toggle">${trainingMode ? 'Stop training' : 'Train by watching'}</button>
          <button type="button" class="autoapply-autopilot-btn" ${policyBlocksAutopilot() ? 'disabled title="Blocked by workspace policy"' : ''}>Continue automatically</button>
        </div></details>
      </div>
    `;

    // Wire up events
    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
    overlayContainer.querySelector('.autoapply-minimize-btn').addEventListener('click', toggleMinimize);

    // Enable drag
    setupDrag();

    // Analyze button event
    const analyzeBtn = overlayContainer.querySelector('.autoapply-analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', async () => {
        analyzeBtn.textContent = 'Analyzing...';
        analyzeBtn.disabled = true;
        try {
          jobAnalysis = await UTILS.apiCall('/api/analyze-job', 'POST', { job_description: jdText });
          renderMainUI();
        } catch (err) {
          analyzeBtn.textContent = 'Failed';
          console.error('[AutoApply] Analyze Job failed:', err);
        }
      });
    }

    // Edit button events
    overlayContainer.querySelectorAll('.autoapply-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        startEditingField(idx);
      });
    });

    // Expand/collapse toggle events
    overlayContainer.querySelectorAll('.autoapply-expand-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        const valDiv = overlayContainer.querySelector(`#val_${idx}`);
        if (!valDiv) return;
        const isExpanded = valDiv.classList.toggle('expanded');
        e.currentTarget.textContent = isExpanded ? '▲ less' : '▼ more';
      });
    });

    overlayContainer.querySelector('.autoapply-primary-action-btn').addEventListener('click', () => {
      if (confirmation) {
        confirmManualSubmission();
        return;
      }
      if (authStep) {
        handleGenericAuthStep(authStep);
        return;
      }
      if (isJobOverview && applyBtn) {
        if (UTILS.detectPlatform(window.location.href) === 'workday') {
          const wdStep = detectWorkdayStep() || { step: 'job_apply', btn: applyBtn };
          handleWorkdayPreApplicationStep(wdStep);
        } else {
          showStatus('Launching application…', false);
          triggerClick(applyBtn);
          if (activeObserver) activeObserver.disconnect();
          activeObserver = FILLER.detectPageChange(() => {
            activeObserver.disconnect();
            activeObserver = null;
            startScanningFlow();
          });
        }
        return;
      }
      handleFill(!pageState.isLast);
    });
    overlayContainer.querySelector('.autoapply-fill-only-btn')?.addEventListener('click', () => handleFill(false));
    overlayContainer.querySelector('.autoapply-autopilot-btn')?.addEventListener('click', runAutoPilot);
    overlayContainer.querySelector('.autoapply-undo-btn')?.addEventListener('click', undoLastFill);
    overlayContainer.querySelector('.autoapply-clear-log-btn')?.addEventListener('click', clearIssueLog);
    overlayContainer.querySelectorAll('.autoapply-training-toggle').forEach((button) => {
      button.addEventListener('click', () => setTrainingMode(!trainingMode));
    });

    const resumeVersion = overlayContainer.querySelector('.autoapply-resume-version');
    if (resumeVersion) {
      resumeVersion.addEventListener('change', (event) => {
        workspace.selectedResumeVersionId = event.target.value || null;
      });
    }
    overlayContainer.querySelectorAll('.autoapply-recover-btn').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        startEditingField(parseInt(event.currentTarget.getAttribute('data-idx'), 10));
      });
    });

    // Cover letter button events
    overlayContainer.querySelectorAll('.autoapply-gen-cover-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        await generateCoverLetter(idx, e.currentTarget);
      });
    });
  }

  function isSubmissionConfirmationPage() {
    if (receiptRecorded) return false;
    const text = document.body?.innerText || '';
    return /(application (?:has been )?(?:submitted|received)|thank you for applying|we received your application)/i.test(text);
  }

  function renderFieldGroups() {
    if (pageFields.length === 0) {
      const applyBtn = findGenericJobApplyButton();
      if (applyBtn) {
        return `
          <div class="autoapply-empty-fields" style="background:rgba(26,115,232,0.06);border:1px dashed #1a73e8;padding:16px;border-radius:8px;text-align:center;">
            <div style="font-size:13px;font-weight:700;color:var(--aa-navy);margin-bottom:6px;">Job Overview Page Detected</div>
            <div style="font-size:12px;color:var(--aa-muted);line-height:1.4;">No form fields on this overview page. Click <strong>🚀 Apply to this job →</strong> below to begin the automated application pipeline!</div>
          </div>
        `;
      }
      return '<div class="autoapply-empty-fields">No fillable fields were found on this page.</div>';
    }
    const entries = pageFields.map((field, idx) => ({ field, idx, instruction:currentInstructions.find((item) => item.field_id === field.id) || { action:'skip', review_required:true } }));
    const groups = [
      ['review', 'Needs review', 'Check these before filling', entries.filter((entry) => entry.instruction.review_required && entry.instruction.action !== 'skip'), true],
      ['ready', 'Ready to fill', 'Verified profile facts and approved answers', entries.filter((entry) => !entry.instruction.review_required && entry.instruction.action !== 'skip'), false],
      ['skipped', 'Skipped', 'Left untouched by policy or missing information', entries.filter((entry) => entry.instruction.action === 'skip'), false],
    ];
    return groups.filter(([, , , items]) => items.length).map(([kind, title, copy, items, open]) => `<details class="autoapply-field-group autoapply-field-group-${kind}" ${open ? 'open' : ''}><summary><span><strong>${title}</strong><small>${copy}</small></span><b>${items.length}</b></summary><div>${items.map((entry) => renderFieldRow(entry.field, entry.idx)).join('')}</div></details>`).join('') || '<div class="autoapply-empty-fields">No fillable fields were found on this page.</div>';
  }

  /**
   * Renders the minimized toggle button.
   */
  function renderMinimizedUI() {
    overlayContainer.className = 'autoapply-overlay autoapply-minimized';
    overlayContainer.innerHTML = `
      <div class="autoapply-mini-btn">
        ${BRAND_MARK}
        <span>AutoApply (Click to Expand)</span>
      </div>
    `;
    overlayContainer.querySelector('.autoapply-mini-btn').addEventListener('click', toggleMinimize);
  }

  /**
   * Toggle between minimized and expanded overlay views.
   */
  function toggleMinimize() {
    isMinimized = !isMinimized;
    // Force a re-render of the active state
    if (overlayContainer) {
      if (overlayContainer.querySelector('.autoapply-loading') || overlayContainer.querySelector('.autoapply-error')) {
        // Don't minimize during loading or error states
        isMinimized = false;
        return;
      }
      // Re-trigger render
      renderMainUI();
    }
  }

  /**
   * Enable dragging the overlay by its header bar.
   */
  function setupDrag() {
    // Remove previous handlers if any
    if (dragMoveHandler) {
      document.removeEventListener('mousemove', dragMoveHandler);
      document.removeEventListener('mouseup', dragUpHandler);
    }

    if (!overlayContainer) return;
    const header = overlayContainer.querySelector('.autoapply-header');
    if (!header) return;

    header.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons
      if (e.target.closest('.autoapply-header-btn')) return;

      isDragging = true;
      const rect = overlayContainer.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      overlayContainer.classList.add('autoapply-dragging');
      e.preventDefault();
    });

    dragMoveHandler = (e) => {
      if (!isDragging || !overlayContainer) return;
      const newLeft = e.clientX - dragOffsetX;
      const newTop = e.clientY - dragOffsetY;
      overlayContainer.style.left = `${Math.max(0, newLeft)}px`;
      overlayContainer.style.top = `${Math.max(0, newTop)}px`;
      overlayContainer.style.right = 'auto';
    };

    dragUpHandler = () => {
      if (!isDragging) return;
      isDragging = false;
      if (overlayContainer) {
        overlayContainer.classList.remove('autoapply-dragging');
      }
    };

    document.addEventListener('mousemove', dragMoveHandler);
    document.addEventListener('mouseup', dragUpHandler);
  }

  /**
   * Helper to format the duplicate warning panel if duplicate found.
   */
  function renderDuplicateWarning(duplicateRes) {
    if (duplicateRes && duplicateRes.is_duplicate) {
      const existing = duplicateRes.existing;
      let info = 'Already applied to this company/role!';
      if (existing && existing.applied_at) {
        const date = new Date(existing.applied_at).toLocaleDateString();
        info = `Warning: Already applied to this role on ${date} (Status: ${existing.status})`;
      }
      return `
        <div class="autoapply-duplicate-warning">
          <span>⚠️</span>
          <span>${UTILS.escapeHTML(info)}</span>
        </div>
      `;
    }
    return '';
  }

  /**
   * Helper to format the fit score analysis section.
   */
  function renderFitScoreSection() {
    if (!jobAnalysis) {
      if (!jdText) return '';
      return `
        <div class="autoapply-fit-section autoapply-fit-loading">
          <span class="autoapply-fit-pulse"></span><span>Fit analysis is loading in the background…</span>
        </div>
      `;
    }

    const score = jobAnalysis.score ?? 0;
    const verdict = jobAnalysis.verdict || 'No verdict';
    const matched = jobAnalysis.matched_skills || [];
    const missing = jobAnalysis.missing_skills || [];

    return `
      <div class="autoapply-fit-section">
        <div class="autoapply-fit-header">
          <div class="autoapply-fit-score">${score}/100</div>
          <div class="autoapply-fit-verdict">
            <strong>${UTILS.escapeHTML(jobAnalysis.recommendation?.toUpperCase() || 'APPLY')}</strong> — ${UTILS.escapeHTML(verdict)}
          </div>
        </div>
        <div class="autoapply-fit-skills">
          ${matched.slice(0, 5).map(skill => `<span class="autoapply-skill-tag matched">✓ ${UTILS.escapeHTML(skill)}</span>`).join('')}
          ${missing.slice(0, 5).map(skill => `<span class="autoapply-skill-tag missing">✗ ${UTILS.escapeHTML(skill)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  function renderTrainingSection() {
    return `
      <div class="autoapply-training-section">
        <div>
          <strong>Training mode</strong>
          <span class="autoapply-training-status">${trainingMode ? `Training on · ${trainingRecords} saved this page` : 'Training off'}</span>
        </div>
        <button type="button" class="autoapply-training-toggle ${trainingMode ? 'active' : ''}">${trainingMode ? 'Stop training' : 'Train by watching'}</button>
      </div>
    `;
  }

  function renderIssueLogSection() {
    const recent = issueLog.slice(0, 6);
    const openAttr = recent.length ? 'open' : '';
    const body = recent.length
      ? recent.map((entry) => `
          <li>
            <div class="autoapply-log-meta">
              <span>${UTILS.escapeHTML(formatIssueTime(entry.timestamp))}</span>
              <span>${UTILS.escapeHTML(entry.source || 'extension')}</span>
              ${entry.field_id ? `<span>${UTILS.escapeHTML(entry.field_id)}</span>` : ''}
            </div>
            <div class="autoapply-log-message">${UTILS.escapeHTML(entry.message)}</div>
          </li>
        `).join('')
      : '<li class="autoapply-log-empty">No problems logged yet.</li>';

    return `
      <details class="autoapply-log-section" ${openAttr}>
        <summary>
          <span>Problem log</span>
          <b>${issueLog.length}</b>
        </summary>
        <ol>${body}</ol>
        ${issueLog.length ? '<button type="button" class="autoapply-clear-log-btn">Clear log</button>' : ''}
      </details>
    `;
  }

  /**
   * Render a single row in the review fields list.
   */
  function renderFieldRow(field, idx) {
    const inst = currentInstructions.find(i => i.field_id === field.id) || {
      field_id: field.id,
      action: 'skip',
      value: '',
      confidence: 'skip'
    };

    let displayValue = inst.value || '';
    if (inst.action === 'skip') {
      displayValue = inst.reason || 'Skipped';
    } else if (field.type === 'password') {
      displayValue = '••••••••';
    }

    const dotClass = `autoapply-confidence-dot ${inst.confidence || 'medium'}`;
    const isExpandable = displayValue.length > 100 && inst.action !== 'skip';
    const valClass = `autoapply-field-value ${inst.action === 'skip' ? 'skip' : ''}${isExpandable ? ' expandable' : ''}`;
    const toggleHtml = isExpandable ? `<button class="autoapply-expand-toggle" data-idx="${idx}">▼ more</button>` : '';

    const labelLower = (field.label || field.placeholder || field.name || '').toLowerCase();
    const isCoverLetter = (field.type === 'textarea' || field.type === 'text') && (
      labelLower.includes('cover letter') || labelLower.includes('cover_letter')
      || labelLower.includes('coverletter') || labelLower.includes('letter of interest')
    );

    const coverLetterBtnHtml = isCoverLetter ? `
      <div style="margin-top: 6px;">
        <button class="autoapply-btn autoapply-gen-cover-btn" data-idx="${idx}" style="font-size: 11px; padding: 4px 8px; width: auto; height: auto; cursor: pointer;">
          ✍ Generate Cover Letter
        </button>
      </div>
    ` : '';
    const failure = fieldFailures.get(field.id);
    const recoveryHtml = failure ? `
      <div style="margin-top:6px;font-size:11px;color:#fca5a5;">Could not fill: ${UTILS.escapeHTML(failure.reason)}</div>
      <button class="autoapply-recover-btn" data-idx="${idx}" style="margin-top:4px;font-size:11px;">Edit &amp; teach recovery</button>
    ` : '';
    const source = inst.source || (inst.action === 'skip' ? 'policy' : 'ai');
    const sourceLabel = source.startsWith('profile') ? 'Verified profile' : source.startsWith('answer_vault') ? 'Approved answer' : source.startsWith('resume') ? 'Resume file' : source.startsWith('learned') ? 'Learned correction' : source.startsWith('policy') ? 'Review policy' : 'AI suggestion';

    return `
      <div class="autoapply-field-row" id="row_${idx}">
        <div class="${dotClass}" title="Confidence: ${inst.confidence || 'unknown'}"></div>
        <div class="autoapply-field-info">
          <div class="autoapply-field-label">${UTILS.escapeHTML(field.label || field.placeholder || field.name || 'Unnamed Field')} ${field.required ? '<span style="color:#c84545">*</span>' : ''}</div>
          <div class="${valClass}" id="val_${idx}">${UTILS.escapeHTML(displayValue)}</div>
          <div class="autoapply-field-source">${UTILS.escapeHTML(sourceLabel)} · ${UTILS.escapeHTML(inst.confidence || 'unknown')} confidence</div>
          ${toggleHtml}
          ${coverLetterBtnHtml}
          ${recoveryHtml}
        </div>
        <button class="autoapply-edit-btn" data-idx="${idx}" title="Edit Value">✎</button>
      </div>
    `;
  }

  // Removed duplicate setupDrag() definition

  /**
   * Switch a field row into editing mode with an input/select.
   */
  function startEditingField(idx) {
    const row = overlayContainer.querySelector(`#row_${idx}`);
    const valDiv = overlayContainer.querySelector(`#val_${idx}`);
    if (!row || !valDiv) return;

    const field = pageFields[idx];
    if (!field) return;

    const fieldId = field.id;
    const inst = currentInstructions.find(i => i.field_id === fieldId) || {
      field_id: fieldId,
      action: 'fill',
      value: '',
      confidence: 'medium'
    };

    let inputHtml = '';

    if (field.type === 'select' && field.options && field.options.length > 0) {
      inputHtml = `
        <select class="autoapply-field-input" id="input_${idx}">
          <option value="">-- Select Option --</option>
          ${field.options.map(opt => `
            <option value="${UTILS.escapeHTML(opt)}" ${opt.toLowerCase().trim() === (inst.value || '').toLowerCase().trim() ? 'selected' : ''}>
              ${UTILS.escapeHTML(opt)}
            </option>
          `).join('')}
        </select>
      `;
    } else if (field.type === 'textarea' || (inst.value && inst.value.length > 40)) {
      inputHtml = `
        <textarea class="autoapply-field-input" id="input_${idx}" rows="3">${UTILS.escapeHTML(inst.value || '')}</textarea>
      `;
    } else {
      inputHtml = `
        <input type="text" class="autoapply-field-input" id="input_${idx}" value="${UTILS.escapeHTML(inst.value || '')}">
      `;
    }

    // Remove expand toggle if present (editing replaces the value area)
    const toggle = row.querySelector('.autoapply-expand-toggle');
    if (toggle) toggle.remove();

    // Remove expandable styling during edit
    valDiv.classList.remove('expandable', 'expanded');

    // Replace the static text with the input and action buttons
    valDiv.innerHTML = `
      <div style="display: flex; gap: 4px; margin-top: 4px;">
        ${inputHtml}
        <button class="autoapply-header-btn autoapply-save-btn" data-idx="${idx}" style="align-self: flex-start; padding: 6px 10px;">✓</button>
      </div>
    `;

    // Hide edit pencil during edit
    const editBtn = row.querySelector('.autoapply-edit-btn');
    if (editBtn) editBtn.style.display = 'none';

    const input = valDiv.querySelector('.autoapply-field-input');
    const saveBtn = valDiv.querySelector('.autoapply-save-btn');

    // Focus input
    input.focus();

    // Save helper
    const save = () => {
      const newValue = input.value;
      saveFieldEdit(idx, newValue);
    };

    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      save();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && field.type !== 'textarea') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        // Cancel, revert UI
        renderMainUI();
      }
    });
  }

  /**
   * Save the edited value, log correction to backend if changed, and update local state.
   */
  function saveFieldEdit(idx, newValue) {
    const field = pageFields[idx];
    if (!field) return;
    const fieldId = field.id;
    let inst = currentInstructions.find(i => i.field_id === fieldId);

    if (!inst) {
      inst = {
        field_id: fieldId,
        action: field.type === 'select' ? 'select' : 'fill',
        value: '',
        confidence: 'high'
      };
      currentInstructions.push(inst);
    }

    const oldValue = originalInstructionsMap.get(fieldId) || '';

    // Update value & bump confidence since it is verified/edited by the user
    inst.value = newValue;
    inst.action = newValue ? (field.type === 'select' ? 'select' : 'fill') : 'skip';
    inst.confidence = 'high';
    inst.review_required = false;

    // Log correction if the value actually changed from the original agent proposal
    if (newValue !== oldValue) {
      const correctionPayload = {
        field_label: field.label || field.placeholder || field.name || 'Unnamed Field',
        agent_value: oldValue,
        user_value: newValue,
        context: `${UTILS.detectPlatform(window.location.href)} form field`,
        url: window.location.href
      };

      UTILS.apiCall('/api/corrections', 'POST', correctionPayload)
        .then(res => {
          console.log('[AutoApply] Correction logged successfully:', res);
        })
        .catch(err => {
          console.error('[AutoApply] Failed to log correction:', err);
        });
    }
    captureTeach(field, oldValue, newValue);
    saveWorkspacePacket('ready_to_review');

    // Refresh UI to display updated value
    renderMainUI();
  }

  async function fillCurrentInstructions(stage) {
    fieldFailures.clear();
    lastFillSnapshot = currentInstructions.map((instruction) => {
      const field = pageFields.find((candidate) => candidate.id === instruction.field_id);
      const element = document.getElementById(instruction.field_id) || document.querySelector(`[data-autoapply-id="${CSS.escape(instruction.field_id)}"]`);
      if (!field || !element || field.type === 'file' || instruction.action === 'skip') return null;
      return {
        element,
        type: field.type,
        value: element.hasAttribute?.('contenteditable') ? element.textContent : element.value,
        checked: Boolean(element.checked),
      };
    }).filter(Boolean);
    const result = await FILLER.fillAllFields(currentInstructions, {
      uploadHandler: attachSelectedResume,
    });
    for (const failure of result.failures || []) {
      fieldFailures.set(failure.field_id, failure);
      recordIssue(failure.reason || 'The field could not be filled.', {
        source: 'field_fill',
        field_id: failure.field_id,
        action: failure.action,
      });
    }
    await saveWorkspacePacket(stage, result);
    return result;
  }

  function undoLastFill() {
    if (!lastFillSnapshot.length) return;
    for (const snapshot of lastFillSnapshot) {
      const { element } = snapshot;
      if (!element?.isConnected) continue;
      if (snapshot.type === 'checkbox' || snapshot.type === 'radio') element.checked = snapshot.checked;
      else if (element.hasAttribute?.('contenteditable')) element.textContent = snapshot.value || '';
      else element.value = snapshot.value || '';
      element.dispatchEvent(new Event('input', { bubbles:true }));
      element.dispatchEvent(new Event('change', { bubbles:true }));
    }
    lastFillSnapshot = [];
    hasFilledCurrentPage = false;
    renderMainUI();
    showStatus('Restored the values from before the last fill.', false);
  }

  /**
   * Run the AutoPilot loop: scrape, get backend instructions, fill, advance, detect page change, and repeat.
   */
  async function runAutoPilot() {
    if (policyBlocksAutopilot()) {
      showStatus(`AutoPilot is blocked by policy. ${policyMessage()}`.trim(), true);
      return;
    }
    autopilotActive = true;
    autopilotStep = 0;
    autopilotState = 'running';
    autopilotMessage = '';

    while (autopilotActive) {
      autopilotStep++;

      if (autopilotStep > MAX_AUTOPILOT_STEPS) {
        stopAutoPilot('Stopped: exceeded maximum steps (possible loop)', 'failed');
        return;
      }

      showAutoPilotStatus(`Filling page ${autopilotStep}...`);

      const authStep = detectGenericAuthStep();
      if (authStep) {
        handleGenericAuthStep(authStep);
        return;
      }

      // 1. Scrape the current page
      try {
        const scrapeResult = SCRAPER.scrapeFormFields();
        pageFields = scrapeResult.fields;
        jdText = scrapeResult.job_description || jdText;
        pageText = scrapeResult.page_text || pageText;
      } catch (err) {
        stopAutoPilot(`Scraper error: ${err.message}`, 'failed');
        return;
      }

      if (pageFields.length === 0) {
        const applyBtn = findGenericJobApplyButton();
        if (applyBtn) {
          showAutoPilotStatus('Found Apply button! Launching application…');
          if (UTILS.detectPlatform(window.location.href) === 'workday') {
            const wdStep = detectWorkdayStep() || { step: 'job_apply', btn: applyBtn };
            stopAutoPilot('Handing over to Workday automated pipeline…', 'running');
            handleWorkdayPreApplicationStep(wdStep);
            return;
          } else {
            triggerClick(applyBtn);
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
        }
        // No fields found - might be a confirmation or loading page
        // Wait a bit and check if it's the last page
        await new Promise(r => setTimeout(r, 1000));
        const lastCheck = FILLER.isLastPage();
        if (lastCheck.isLast) {
          stopAutoPilot('AutoPilot complete. Review and submit manually.', 'ready_to_review');
          logApplicationToHistory();
          return;
        }
      }

      // 2. Get fill instructions from backend
      const url = window.location.href;
      const title = document.title;
      const platform = UTILS.detectPlatform(url);
      companyName = UTILS.extractCompany(url, title);
      roleName = title.split(/ - | at | \\| /i)[0]
        .replace(/Apply for|Job Application for|Opening for/i, '').trim();

      const formSchema = {
        url, platform, page_title: title,
        step: autopilotStep, total_steps: 1,
        fields: pageFields, job_description: jdText,
        page_text: pageText,
        opportunity_id: workspace.opportunityId,
        resume_version_id: workspace.selectedResumeVersionId
      };

      try {
        const autofillRes = await UTILS.apiCall('/api/autofill', 'POST', formSchema);
        currentInstructions = autofillRes.instructions || [];
      } catch (err) {
        stopAutoPilot(`Backend error: ${err.message}`, 'failed');
        return;
      }

      if (!autopilotActive) return; // User clicked stop during API call

      // 3. Fill all fields
      const result = await fillCurrentInstructions('autopilot_filled');
      showAutoPilotStatus(
        `Page ${autopilotStep}: Filled ${result.filled}, skipped ${result.skipped}, failed ${result.failed}`
      );
      if (result.failed) {
        stopAutoPilot('Stopped for field recovery. Review the failed fields; nothing was submitted.', 'failed');
        renderMainUI();
        return;
      }

      // 4. Wait for React/Angular to settle
      await new Promise(r => setTimeout(r, 800));

      // 5. Check if this is the last page
      const lastPageInfo = FILLER.isLastPage();
      if (lastPageInfo.isLast) {
        autopilotActive = false;
        autopilotState = 'ready_to_review';
        autopilotMessage = `AutoPilot complete (${lastPageInfo.reason}). Review and submit manually.`;
        showAutoPilotStatus(autopilotMessage);
        logApplicationToHistory();
        // Re-render the full UI so user can review final page
        renderMainUI();
        return;
      }

      // 6. Click next and wait for page change
      const clicked = FILLER.clickNextButton();
      if (!clicked) {
        stopAutoPilot('Could not find a safe Next/Continue button.', 'failed');
        return;
      }

      showAutoPilotStatus(`Advancing to page ${autopilotStep + 1}...`);

      // 7. Wait for DOM change (new form step)
      await new Promise((resolve) => {
        let resolved = false;
        const doResolve = () => {
          if (resolved) return;
          resolved = true;
          if (activeObserver) {
            activeObserver.disconnect();
            activeObserver = null;
          }
          resolve();
        };

        if (activeObserver) activeObserver.disconnect();
        activeObserver = FILLER.detectPageChange(doResolve);

        // Timeout after 10s in case DOM change isn't detected
        setTimeout(doResolve, 10000);
      });

      if (!autopilotActive) return;

      // 8. Small delay then loop
      await new Promise(r => setTimeout(r, 500));
    }
  }

  /**
   * Stop AutoPilot and optionally show a status message.
   */
  function stopAutoPilot(message, outcome = 'stopped') {
    autopilotActive = false;
    autopilotState = outcome;
    autopilotMessage = message || '';
    if (outcome === 'failed') recordIssue(message, { source: 'autopilot' });
    if (message) showAutoPilotStatus(message);
  }

  /**
   * Display autopilot progress or final status inside the overlay.
   */
  function showAutoPilotStatus(text) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-autopilot-status">
        <div class="autoapply-autopilot-indicator ${autopilotActive ? 'active' : 'done'}"></div>
        <div class="autoapply-autopilot-text">${UTILS.escapeHTML(text)}</div>
      </div>
      ${renderIssueLogSection()}
      ${autopilotActive ? `
        <div class="autoapply-footer">
          <button class="autoapply-btn autoapply-stop-btn">Stop AutoPilot</button>
        </div>
      ` : `
        <div class="autoapply-footer">
          <button class="autoapply-btn autoapply-btn-secondary autoapply-close-final-btn">Close</button>
        </div>
      `}
    `;

    const closeBtn = overlayContainer.querySelector('.autoapply-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => { stopAutoPilot(); removeOverlay(); });
    overlayContainer.querySelector('.autoapply-clear-log-btn')?.addEventListener('click', clearIssueLog);

    const stopBtn = overlayContainer.querySelector('.autoapply-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', () => {
      stopAutoPilot('AutoPilot stopped by user.');
      renderMainUI();
    });

    const closeFinalBtn = overlayContainer.querySelector('.autoapply-close-final-btn');
    if (closeFinalBtn) closeFinalBtn.addEventListener('click', removeOverlay);
  }

  /** Save a prepared application without claiming it was submitted. */
  function logApplicationToHistory() {
    saveWorkspacePacket('ready_to_review')
      .then(() => {
        showStatus('Saved for review. AutoApply did not submit anything.', false);
      })
      .catch(err => {
        console.error('[AutoApply] Failed to log application:', err);
      });
  }

  /**
   * Request cover letter generation from the backend and update the matching field's value.
   */
  async function generateCoverLetter(idx, btn) {
    const field = pageFields[idx];
    if (!field) return;

    const originalText = btn.textContent;
    btn.textContent = 'Generating...';
    btn.disabled = true;
    showStatus('Generating cover letter...', false);

    try {
      const res = await UTILS.apiCall('/api/cover-letter', 'POST', {
        job_description: jdText,
        company: companyName,
        role: roleName
      });

      // Find and update the instruction for this field
      let inst = currentInstructions.find(i => i.field_id === field.id);
      if (!inst) {
        inst = { field_id: field.id, action: 'fill', value: '', confidence: 'high', source: 'ai' };
        currentInstructions.push(inst);
      }
      inst.value = res.cover_letter;
      inst.action = 'fill';
      inst.confidence = 'high';

      showStatus('Cover letter generated!', false);
      renderMainUI();
    } catch (err) {
      btn.textContent = originalText;
      btn.disabled = false;
      showStatus(`Cover letter failed: ${err.message}`, true);
    }
  }

  /**
   * Fill the form fields.
   * If advance is true, click the page next/continue button and set up page change detection.
   */
  async function handleFill(advance) {
    if (!FILLER) {
      console.error('[AutoApply] Filler module not found.');
      return;
    }

    // 1. Programmatically fill all inputs on the active DOM
    const result = await fillCurrentInstructions(advance ? 'filled_for_next' : 'filled_for_review');
    hasFilledCurrentPage = result.filled > 0;
    showStatus(`Filled ${result.filled}, skipped ${result.skipped}, failed ${result.failed}`, result.failed > 0);
    if (result.failed) {
      renderMainUI();
      showStatus('Resolve the highlighted field failures before continuing. Nothing was submitted.', true);
      return;
    }

    const authStep = detectGenericAuthStep();
    if (authStep) {
      handleGenericAuthStep(authStep);
      return;
    }

    if (advance) {
      // Small delay to ensure all async React/Angular updates settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // 2. Click page continue button
      const clicked = FILLER.clickNextButton();

      if (clicked) {
        showStatus('Form filled. Moving to next page...', false);

        // 3. Monitor DOM changes to auto-scan the next steps
        if (activeObserver) activeObserver.disconnect();
        activeObserver = FILLER.detectPageChange(() => {
          activeObserver.disconnect();
          activeObserver = null;
          startScanningFlow();
        });
      } else {
        showStatus('Filled fields, but no Next/Continue button could be detected.', true);
      }
    } else {
      renderMainUI();
      showStatus('Fields are filled. Review the employer page before submitting.', false);
    }
  }

  /**
   * Show a bottom banner status message (e.g. success or warning).
   */
  function showStatus(text, isError) {
    if (!overlayContainer) return;

    // Remove existing status if any
    const oldStatus = overlayContainer.querySelector('.autoapply-status');
    if (oldStatus) oldStatus.remove();

    const statusDiv = document.createElement('div');
    statusDiv.className = `autoapply-status ${isError ? 'error' : ''}`;
    statusDiv.textContent = text;

    // Append above footer or at the bottom
    const footer = overlayContainer.querySelector('.autoapply-footer');
    if (footer) {
      overlayContainer.insertBefore(statusDiv, footer);
    } else {
      overlayContainer.appendChild(statusDiv);
    }

    // Auto-remove standard status messages after 5 seconds unless it's a critical error
    if (!isError) {
      setTimeout(() => {
        statusDiv.remove();
      }, 5000);
    }
  }



  // Register listeners for messages from the background script
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_AUTOFILL') {
      startScanningFlow();
      sendResponse({ status: 'started' });
    } else if (message.type === 'GET_STATUS') {
      sendResponse({ status: window.__autoapply_active ? 'active' : 'idle' });
    } else if (message.type === 'START_AUTOPILOT') {
      autopilotState = 'starting';
      autopilotMessage = '';
      startScanningFlow()
        .then(() => runAutoPilot())
        .catch((err) => stopAutoPilot(`AutoPilot startup failed: ${err.message}`, 'failed'));
      sendResponse({ status: 'started' });
    } else if (message.type === 'GET_AUTOPILOT_STATUS') {
      sendResponse({
        autopilotActive,
        autopilotStep,
        autopilotState,
        message: autopilotMessage
      });
    } else if (message.type === 'PREPARE_APPLICATION') {
      prepareApplicationSilently(message).then(sendResponse);
      return true;
    }
  });

  colorScheme.addEventListener('change', () => {
    if (themePreference !== 'system') return;
    applyOverlayTheme();
    if (readyChipHost) { removeReadyChip(); mountReadyChip(); }
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[THEME_KEY]) {
      themePreference = themeChoices.has(changes[THEME_KEY].newValue) ? changes[THEME_KEY].newValue : 'system';
      applyOverlayTheme();
      if (readyChipHost) { removeReadyChip(); mountReadyChip(); }
    }
    if (changes[TRAINING_MODE_KEY]) {
      trainingMode = changes[TRAINING_MODE_KEY].newValue === true;
      if (trainingMode) startTrainingRecorder();
      else stopTrainingRecorder();
      refreshTrainingStatus();
    }
  });

  Promise.all([initializeTheme(), initializeIssueLog(), initializeTrainingMode()])
    .finally(() => {
      startJobPagePromptWatcher();
      setTimeout(mountReadyChip, 700);
    });
  console.log('[AutoApply] Review Overlay module loaded successfully.');
})();
