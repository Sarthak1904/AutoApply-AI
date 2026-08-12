/**
 * AutoApply — Background Script
 * Handles extension state tracking and message routing between components.
 */

if (typeof browser === 'undefined') {
  globalThis.browser = chrome;
}


// Track global extension state
let extensionState = {
  status: 'idle', // idle, scanning, filling, reviewing, complete
  lastActiveTabId: null,
  todayCount: 0
};

const MAX_RESUME_BYTES = 10 * 1024 * 1024;

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fileNameFromDisposition(value) {
  const match = /filename\*?=(?:UTF-8''|\")?([^\";]+)/i.exec(value || '');
  if (!match) return 'resume.pdf';
  try {
    return decodeURIComponent(match[1].replace(/\"/g, '')).replace(/[\\/]/g, '_');
  } catch (_) {
    return 'resume.pdf';
  }
}

async function fetchResumeVersion(versionId) {
  if (typeof versionId !== 'string' || !versionId.trim()) {
    throw new Error('Choose a resume version before attaching it.');
  }
  const response = await fetch(
    `http://localhost:8000/api/workspace/resume-versions/${encodeURIComponent(versionId)}/download`,
    { signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok) throw new Error(`Resume download failed (${response.status}).`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESUME_BYTES) throw new Error('Selected resume is larger than 10MB.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RESUME_BYTES) {
    throw new Error('Selected resume is empty or larger than 10MB.');
  }
  return {
    base64: bytesToBase64(bytes),
    filename: fileNameFromDisposition(response.headers.get('content-disposition')),
    contentType: response.headers.get('content-type') || 'application/pdf',
    size: bytes.length,
  };
}

function showNotification(title, message) {
  browser.notifications.create({
    type: 'basic',
    title: title,
    message: message,
    iconUrl: browser.runtime.getURL('icons/icon-96.svg')
  });
}

// Listen for messages from popup or content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AutoApply Background] Received message:', message);

  if (message.type === 'APP_LOGGED') {
    extensionState.todayCount = (extensionState.todayCount || 0) + 1;
    showNotification(
      'Application Logged',
      `Applied to ${message.data.role} at ${message.data.company}. Total today: ${extensionState.todayCount}`
    );
    sendResponse({ status: 'success' });
    return false;
  }

  if (message.type === 'START_AUTOFILL') {
    // Query active tab in the current window
    browser.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs && tabs[0]) {
          const tabId = tabs[0].id;
          extensionState.status = 'scanning';
          extensionState.lastActiveTabId = tabId;
          
          // Send message to the tab's content script
          return browser.tabs.sendMessage(tabId, { type: 'START_AUTOFILL' });
        } else {
          throw new Error('No active tab found.');
        }
      })
      .then((response) => {
        extensionState.status = 'reviewing';
        sendResponse({ status: 'success', details: response });
      })
      .catch((err) => {
        console.error('[AutoApply Background] Error starting autofill:', err);
        extensionState.status = 'idle';
        sendResponse({ status: 'error', error: err.message });
      });
      
    return true; // Keep connection open for async sendResponse
  }

  if (message.type === 'GET_STATUS') {
    sendResponse(extensionState);
    return false;
  }

  if (message.type === 'SET_STATUS') {
    extensionState.status = message.status;
    sendResponse({ status: 'updated' });
    return false;
  }

  if (message.type === 'GET_RECENT_APPS') {
    // Route API fetch through background to avoid potential CORS issues in popup contexts
    fetch('http://localhost:8000/api/applications/?limit=5', { signal: AbortSignal.timeout(30000) })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.json();
      })
      .then((data) => {
        sendResponse({ status: 'success', data });
      })
      .catch((err) => {
        console.error('[AutoApply Background] Error fetching applications:', err);
        sendResponse({ status: 'error', error: err.message });
      });
      
    return true; // Keep connection open
  }

  if (message.type === 'FETCH_RESUME_VERSION') {
    fetchResumeVersion(message.version_id)
      .then((file) => sendResponse({ status: 'success', file }))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));
    return true;
  }

  if (message.type === 'OPEN_WORKSPACE_RECORD') {
    const opportunityId = String(message.opportunity_id || '').trim();
    if (!opportunityId) {
      sendResponse({ status: 'error', error: 'Missing opportunity ID.' });
      return false;
    }
    const url = `http://localhost:8000/dashboard?application=${encodeURIComponent(opportunityId)}#applications`;
    browser.tabs.create({ url })
      .then(() => sendResponse({ status: 'success' }))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));
    return true;
  }

  if (message.type === 'API_CALL_PROXY') {
    const url = `http://localhost:8000${message.endpoint}`;
    const options = {
      method: message.method,
      signal: AbortSignal.timeout(30000)
    };
    if (message.method !== 'GET') {
      options.headers = { 'Content-Type': 'application/json' };
      if (message.body) {
        options.body = JSON.stringify(message.body);
      }
    }

    fetch(url, options)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        return res.json();
      })
      .then((data) => sendResponse({ status: 'success', data }))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));

    return true; // Keep connection open
  }
});

// Listen for keyboard shortcut commands
browser.commands.onCommand.addListener((command) => {
  if (command === 'toggle-autofill') {
    console.log('[AutoApply Background] Keyboard shortcut triggered: toggle-autofill');
    browser.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs && tabs[0]) {
          const tabId = tabs[0].id;
          extensionState.status = 'scanning';
          extensionState.lastActiveTabId = tabId;
          return browser.tabs.sendMessage(tabId, { type: 'START_AUTOFILL' });
        }
      })
      .then(() => {
        extensionState.status = 'reviewing';
      })
      .catch((err) => {
        console.error('[AutoApply Background] Keyboard shortcut error:', err);
        extensionState.status = 'idle';
      });
  }
});

console.log('[AutoApply Background] Service worker loaded.');
