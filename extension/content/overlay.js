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
  const themeChoices = new Set(['system', 'light', 'dark']);
  const BRAND_MARK = `<span class="autoapply-logo-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M7 2h26l13 13v26a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Z" fill="#17213A" stroke="#344664" stroke-width="2"/><path d="M33 2v10a3 3 0 0 0 3 3h10Z" fill="#526CE7"/><path d="M10 11v26" stroke="#F47D68" stroke-width="4" stroke-linecap="round"/><path d="M20 14v9h12v11" fill="none" stroke="#91A4FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="14" r="4" fill="#FFFDF8"/><circle cx="32" cy="23" r="4" fill="#526CE7" stroke="#FFFDF8" stroke-width="2"/><circle cx="32" cy="34" r="4" fill="#52BFAE"/></svg></span>`;
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  let themePreference = 'system';
  const MAX_AUTOPILOT_STEPS = 15;
  let fieldFailures = new Map();
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

  function opportunityPayload() {
    return {
      url: window.location.href,
      company: companyName || 'Unknown',
      role: roleName || 'Unknown',
      platform: UTILS.detectPlatform(window.location.href),
      page_title: document.title,
      job_description_snippet: jdText ? jdText.slice(0, 3000) : '',
      job_description: jdText || '',
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

    try {
      const scrapeResult = SCRAPER.scrapeFormFields();
      pageFields = scrapeResult.fields;
      jdText = scrapeResult.job_description;
    } catch (err) {
      console.error('[AutoApply] Scraper error:', err);
      showError('Failed to scan page fields. Check console for details.');
      return;
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
      return { ok:false, error:error.message || 'Preparation failed' };
    }
  }

  function looksLikeApplicationPage() {
    if (!/^https?:/i.test(window.location.href)) return false;
    const identity = `${window.location.href} ${document.title}`.toLowerCase();
    const knownPage = /(workdayjobs|greenhouse|lever\.co|ashbyhq|icims|smartrecruiters|taleo|oraclecloud|darwinbox|keka|\/apply(?:\/|\?|$)|application)/.test(identity);
    const visibleFields = [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')]
      .filter((element) => element.offsetParent !== null && !element.disabled).length;
    return knownPage && visibleFields >= 2;
  }

  function removeReadyChip() {
    if (readyChipHost) readyChipHost.remove();
    readyChipHost = null;
  }

  function mountReadyChip() {
    if (readyChipHost || window.__autoapply_active || !looksLikeApplicationPage()) return;
    readyChipHost = document.createElement('div');
    readyChipHost.id = 'autoapply-ready-chip-host';
    document.body.appendChild(readyChipHost);
    const root = readyChipHost.attachShadow({ mode:'open' });
    const dark = resolvedTheme() === 'dark';
    const chipColors = dark
      ? { text:'#edf2f7', background:'#151d28', border:'#3c4b5e', hover:'#202b39', action:'#526ce7', focus:'#9aaeff' }
      : { text:'#19233a', background:'#ffffff', border:'#bcc6da', hover:'#e8edfa', action:'#3157d5', focus:'rgba(49,87,213,.45)' };
    root.innerHTML = `<style>
      button{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:9px;min-height:44px;padding:0 14px;border:1px solid ${chipColors.border};border-radius:8px;color:${chipColors.text};background:${chipColors.background};box-shadow:0 16px 42px rgba(0,0,0,.25);font:750 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
      button:hover{border-color:${chipColors.action};background:${chipColors.hover}}.autoapply-logo-icon{display:block;width:22px;height:22px;filter:drop-shadow(2px 2px 0 rgba(0,0,0,.16));transform:rotate(-1deg)}.autoapply-logo-icon svg{display:block;width:100%;height:100%}button:focus-visible{outline:3px solid ${chipColors.focus};outline-offset:3px}@media(prefers-reduced-motion:no-preference){button{animation:arrive .28s ease-out}@keyframes arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}</style><button type="button" aria-label="Prepare this application with AutoApply">${BRAND_MARK}Ready to prepare</button>`;
    root.querySelector('button').addEventListener('click', startScanningFlow);
  }

  /**
   * Remove the overlay element from DOM and cleanup observer.
   */
  function removeOverlay() {
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
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
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
    const primaryLabel = confirmation ? 'Record submission' : hasFilledCurrentPage && pageState.isLast
      ? 'Review final page on employer site' : pageState.isLast ? 'Fill reviewed fields' : 'Fill & continue';
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
      <div class="autoapply-fields">
        ${renderFieldGroups()}
      </div>
      <div class="autoapply-footer">
        <button class="autoapply-btn autoapply-btn-primary autoapply-primary-action-btn" ${hasFilledCurrentPage && pageState.isLast && !confirmation ? 'disabled' : ''}>${primaryLabel}</button>
        <details class="autoapply-more-actions"><summary aria-label="More actions">•••</summary><div class="autoapply-action-menu">
          <button type="button" class="autoapply-fill-only-btn">Fill without continuing</button>
          ${lastFillSnapshot.length ? '<button type="button" class="autoapply-undo-btn">Undo last fill</button>' : ''}
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
      if (confirmation) confirmManualSubmission();
      else handleFill(!pageState.isLast);
    });
    overlayContainer.querySelector('.autoapply-fill-only-btn')?.addEventListener('click', () => handleFill(false));
    overlayContainer.querySelector('.autoapply-autopilot-btn')?.addEventListener('click', runAutoPilot);
    overlayContainer.querySelector('.autoapply-undo-btn')?.addEventListener('click', undoLastFill);

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
    for (const failure of result.failures || []) fieldFailures.set(failure.field_id, failure);
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
      
      // 1. Scrape the current page
      try {
        const scrapeResult = SCRAPER.scrapeFormFields();
        pageFields = scrapeResult.fields;
        jdText = scrapeResult.job_description || jdText;
      } catch (err) {
        stopAutoPilot(`Scraper error: ${err.message}`, 'failed');
        return;
      }
      
      if (pageFields.length === 0) {
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
    if (area !== 'local' || !changes[THEME_KEY]) return;
    themePreference = themeChoices.has(changes[THEME_KEY].newValue) ? changes[THEME_KEY].newValue : 'system';
    applyOverlayTheme();
    if (readyChipHost) { removeReadyChip(); mountReadyChip(); }
  });

  initializeTheme();
  setTimeout(mountReadyChip, 700);
  console.log('[AutoApply] Review Overlay module loaded successfully.');
})();
