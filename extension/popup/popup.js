document.addEventListener('DOMContentLoaded', () => {
  const UTILS = window.__autoapply_utils;
  const $ = (selector) => document.querySelector(selector);
  const THEME_KEY = 'autoapply_theme';
  const themeOrder = ['system', 'light', 'dark'];
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  let themePreference = 'system';
  let backendReady = false;
  let profileReady = false;
  let aiReady = false;
  let pageReady = false;
  let activeTab = null;

  function resolvedTheme() {
    return themePreference === 'system' ? (colorScheme.matches ? 'dark' : 'light') : themePreference;
  }

  function applyTheme() {
    document.documentElement.dataset.theme = resolvedTheme();
    const label = themePreference[0].toUpperCase() + themePreference.slice(1);
    $('#theme-toggle small').textContent = label;
    $('#theme-toggle').setAttribute('aria-label', `Color theme: ${label}`);
  }

  async function initializeTheme() {
    const saved = await browser.storage.local.get(THEME_KEY);
    themePreference = themeOrder.includes(saved[THEME_KEY]) ? saved[THEME_KEY] : 'system';
    applyTheme();
  }

  function setReadiness(id, ready, title, detail) {
    const row = $(id);
    row.className = `readiness-row ${ready ? 'ready' : 'error'}`;
    row.querySelector('strong').textContent = title;
    row.querySelector('small').textContent = detail;
  }

  function looksLikeApplication(url, title = '') {
    if (!/^https?:/i.test(url || '')) return false;
    const value = `${url} ${title}`.toLowerCase();
    return /(workdayjobs|greenhouse|lever\.co|ashbyhq|icims|smartrecruiters|taleo|oraclecloud|darwinbox|keka|\/apply(?:\/|\?|$)|application)/.test(value);
  }

  async function inspectPage() {
    try {
      [activeTab] = await browser.tabs.query({ active:true, currentWindow:true });
      pageReady = looksLikeApplication(activeTab?.url, activeTab?.title);
      $('#page-title').textContent = pageReady ? (activeTab.title || 'Application page').replace(/\s[-|].*$/, '').slice(0, 62) : 'No application detected';
      $('#page-copy').textContent = pageReady ? 'Prepare fields and review anything uncertain before filling.' : 'Open a job application page, then return here.';
    } catch (_) {
      $('#page-title').textContent = 'This tab is unavailable';
      $('#page-copy').textContent = 'Open a regular job application page and try again.';
    }
    updatePrimaryAction();
  }

  async function inspectBackend() {
    try {
      const health = await UTILS.apiCall('/api/health');
      backendReady = health.status === 'healthy';
      profileReady = Boolean(health.profile_loaded && health.resume_uploaded);
      aiReady = Boolean(health.ai_ready);
      $('#backend-status').className = 'status ready';
      $('#backend-status span').textContent = 'Connected';
      setReadiness('#ready-backend', true, 'Local backend', 'Connected on port 8000');
      setReadiness('#ready-profile', profileReady, 'Profile & resume', profileReady ? 'Ready to reuse' : 'Upload and verify your resume');
      setReadiness('#ready-ai', aiReady, 'AI provider', aiReady ? `${health.ai_provider} · ${health.ai_model}` : 'Add a provider key in backend/.env');
      $('#offline-help').hidden = true;
    } catch (_) {
      backendReady = profileReady = aiReady = false;
      $('#backend-status').className = 'status error';
      $('#backend-status span').textContent = 'Offline';
      setReadiness('#ready-backend', false, 'Local backend', 'Start the service on port 8000');
      setReadiness('#ready-profile', false, 'Profile & resume', 'Available after the backend starts');
      setReadiness('#ready-ai', false, 'AI provider', 'Available after the backend starts');
      $('#offline-help').hidden = false;
    }
    updatePrimaryAction();
  }

  function updatePrimaryAction() {
    const button = $('#prepare-btn');
    button.disabled = !(backendReady && profileReady && pageReady);
    if (!backendReady) button.innerHTML = 'Start the local backend<span>Then return to this application page</span>';
    else if (!profileReady) button.innerHTML = 'Finish profile setup<span>A resume and contact details are required</span>';
    else if (!pageReady) button.innerHTML = 'Open an application page<span>AutoApply will wait here</span>';
    else if (!aiReady) button.innerHTML = 'Prepare application<span>Local answers only · AI suggestions are unavailable</span>';
    else button.innerHTML = 'Prepare application<span>Review before anything is filled</span>';
  }

  $('#prepare-btn').addEventListener('click', async () => {
    if (!activeTab?.id) return;
    $('#prepare-btn').disabled = true;
    $('#prepare-btn').innerHTML = 'Preparing…<span>Scanning fields and building your review</span>';
    try {
      await browser.runtime.sendMessage({ type:'START_AUTOFILL' });
      window.close();
    } catch (_) {
      $('#page-copy').textContent = 'AutoApply could not access this tab. Reload the page and try again.';
      updatePrimaryAction();
    }
  });

  const open = (url) => browser.tabs.create({ url });
  $('#open-workspace').addEventListener('click', () => open(`${UTILS.API_BASE}/dashboard`));
  $('#open-setup').addEventListener('click', () => open(`${UTILS.API_BASE}/dashboard#profile`));
  $('#open-batch').addEventListener('click', () => open(browser.runtime.getURL('popup/batch.html')));
  $('#theme-toggle').addEventListener('click', async () => {
    themePreference = themeOrder[(themeOrder.indexOf(themePreference) + 1) % themeOrder.length];
    applyTheme();
    await browser.storage.local.set({ [THEME_KEY]:themePreference });
  });
  colorScheme.addEventListener('change', () => { if (themePreference === 'system') applyTheme(); });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[THEME_KEY]) {
      themePreference = themeOrder.includes(changes[THEME_KEY].newValue) ? changes[THEME_KEY].newValue : 'system';
      applyTheme();
    }
  });
  initializeTheme();
  inspectPage();
  inspectBackend();
});
