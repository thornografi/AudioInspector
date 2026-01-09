// Background service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('VoiceInspector installed');

  // Reset inspector state on install/update - default to stopped
  chrome.storage.local.set({ inspectorEnabled: false });
  updateBadge(false);

  // Reload test pages immediately on install/update
  reloadTestTabs();
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Reset inspector state when browser starts - default to stopped
chrome.runtime.onStartup.addListener(() => {
  console.log('VoiceInspector: Browser started, resetting to stopped state');
  chrome.storage.local.set({ inspectorEnabled: false });
  updateBadge(false);
});

// Update badge based on inspector state (simpler than icon switching)
function updateBadge(isRecording) {
  if (isRecording) {
    // Show red dot badge when recording
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff3b30' }); // iOS red
    console.log('[Background] ✅ Badge set to recording');
  } else {
    // Clear badge when stopped
    chrome.action.setBadgeText({ text: '' });
    console.log('[Background] ✅ Badge cleared (stopped)');
  }
}

// Listen for inspector state changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.inspectorEnabled) {
    const isEnabled = changes.inspectorEnabled.newValue === true;
    console.log('[Background] Inspector state changed:', isEnabled);
    updateBadge(isEnabled);
  }
});

// Helper to reload relevant tabs
function reloadTestTabs() {
  const patterns = [
    '*://localhost/*',
    '*://127.0.0.1/*',
    '*://*/test.html*',
    '*://teams.microsoft.com/*',
    '*://discord.com/*',
    '*://meet.google.com/*'
  ];
  
  chrome.tabs.query({ url: patterns }, (tabs) => {
    for (const tab of tabs) {
      try {
        console.log('[Dev] Reloading tab:', tab.url);
        chrome.tabs.reload(tab.id);
      } catch (e) {
        // Tab might be closed
      }
    }
  });
}

// --- Development Auto-Reload Logic (SSE Based) ---
const isDevelopment = true; 

if (isDevelopment) {
  let eventSource = null;
  let retryTimer = null;

  function connectToWatcher() {
    if (eventSource) {
      eventSource.close();
    }

    // Connect to SSE Server
    eventSource = new EventSource('http://localhost:8080/events');

    eventSource.onopen = () => {
      console.log('[Dev] Connected to watcher server');
    };

    eventSource.onmessage = (event) => {
      if (event.data === 'reload') {
        console.log('[Dev] 🔄 Reload signal received. Reloading extension...');
        
        // Reloading the runtime will kill this script and restart it.
        // The new instance will then call reloadTestTabs() on startup.
        chrome.runtime.reload();
      }
    };

    eventSource.onerror = (err) => {
      console.log('[Dev] Watcher disconnected. Retrying in 2s...');
      eventSource.close();
      eventSource = null;
      
      // Retry connection
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connectToWatcher, 2000);
    };
  }

  // Initial connection
  connectToWatcher();
}
// ------------------------------------

// Auto-inject page script when content script requests it
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_PAGE_SCRIPT' && sender.tab?.id) {
    handleInjection(sender.tab.id, sender.frameId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('Injection failed:', err);
        sendResponse({ success: false, error: err.message });
      });

    return true; // async response
  }

  // Note: Icon updates now handled by storage.onChanged listener (see above)
});

/**
 * Handles the injection of the page script into the MAIN world
 */
async function handleInjection(tabId, frameId) {
  const extensionUrl = chrome.runtime.getURL('');
  const target = { tabId, frameIds: [frameId] };

  // 1. Inject Extension URL constant
  await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: (url) => { window.__audioPipelineExtensionUrl = url; },
    args: [extensionUrl]
  });

  // 2. Inject Page Script
  await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    files: ['scripts/page.js']
  });
}
