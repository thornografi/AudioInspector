// Background service worker

// Measurement data storage keys
// SOURCE OF TRUTH: src/core/constants.js → DATA_STORAGE_KEYS
// (Duplicated here because background.js cannot import ES modules)
const DATA_STORAGE_KEYS = [
  'rtc_stats', 'user_media', 'audio_contexts',
  'audio_worklet', 'media_recorder', 'wasm_encoder'
];

// Merkezi log yönetimi - race condition önleme
let logQueue = [];
let isProcessingLogs = false;

const LOG_LIMIT = 1000;

async function processLogQueue() {
  if (isProcessingLogs || logQueue.length === 0) return;

  isProcessingLogs = true;

  try {
    const result = await chrome.storage.local.get(['debug_logs']);
    let logs = result.debug_logs || [];

    // Kuyruktaki tüm logları ekle
    while (logQueue.length > 0) {
      logs.push(logQueue.shift());
    }

    // Sınırı aştıysa en yeni LOG_LIMIT kadar tut
    if (logs.length > LOG_LIMIT) {
      logs = logs.slice(-LOG_LIMIT);
    }

    await chrome.storage.local.set({ debug_logs: logs });
  } catch (e) {
    console.error('[Background] Log write error:', e);
  } finally {
    isProcessingLogs = false;
    // Kuyrukta yeni log varsa tekrar işle
    if (logQueue.length > 0) {
      processLogQueue();
    }
  }
}

function addLog(entry) {
  logQueue.push(entry);
  processLogQueue();
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('AudioInspector installed');

  // Reset inspector state on install/update - default to stopped
  // Include autoStoppedReason to prevent stale banner on fresh start
  chrome.storage.local.remove(['inspectorEnabled', 'lockedTab', 'autoStoppedReason']);
  updateBadge(false);

  // Reload test pages immediately on install/update
  reloadTestTabs();
});

// Toggle side panel when extension icon is clicked
let panelOpenTabs = new Set(); // Track which tabs have the panel open
let togglingTabs = new Set(); // Mutex: prevent rapid click race condition

// Side panel kapanma tespiti için port-based connection listener
// beforeunload + sendMessage güvenilir değil, port disconnect güvenilir
chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('sidepanel-')) {
    const tabId = parseInt(port.name.split('-')[1]);

    port.onDisconnect.addListener(() => {
      // Panel kapandı (X butonu, tab kapatma, vb.)
      panelOpenTabs.delete(tabId);
      console.log('[Background] Side panel disconnected for tab:', tabId);
    });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;

  // Race condition guard - önceki işlem bitmeden yeni tıklama ignore
  if (togglingTabs.has(tabId)) return;
  togglingTabs.add(tabId);

  try {
    if (panelOpenTabs.has(tabId)) {
      // Panel açık, kapat (Chrome 116+ API)
      try {
        await chrome.sidePanel.close({ tabId });
      } catch (e) {
        // Panel zaten kapalı olabilir (X ile manuel kapatılmış)
        console.log('[Background] Side panel already closed');
      }
      panelOpenTabs.delete(tabId);
    } else {
      // Panel kapalı, aç
      await chrome.sidePanel.open({ tabId });
      panelOpenTabs.add(tabId);
    }
  } finally {
    togglingTabs.delete(tabId);
  }
});

// Reset inspector state when browser starts - default to stopped
chrome.runtime.onStartup.addListener(() => {
  console.log('AudioInspector: Browser started, resetting to stopped state');
  // Include autoStoppedReason to prevent stale banner from previous session
  chrome.storage.local.remove(['inspectorEnabled', 'lockedTab', 'autoStoppedReason', 'debug_logs', ...DATA_STORAGE_KEYS]);
  updateBadge(false);
});

// Tab kapatıldığında kilitli tab kontrolü ve panel tracking temizliği
chrome.tabs.onRemoved.addListener((tabId) => {
  // Panel tracking temizle
  panelOpenTabs.delete(tabId);

  // Kilitli tab kontrolü
  chrome.storage.local.get(['lockedTab'], (result) => {
    if (result.lockedTab && result.lockedTab.id === tabId) {
      console.log('[Background] Kilitli tab kapatıldı, state ve veriler temizleniyor');
      chrome.storage.local.remove(['inspectorEnabled', 'lockedTab', ...DATA_STORAGE_KEYS]);
      updateBadge(false);
    }
  });
});

// Tab değişimi (activation) kontrolü - aktif dinleme varsa otomatik durdur
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const result = await chrome.storage.local.get(['inspectorEnabled', 'lockedTab']);

  // Dinleme aktif değilse hiçbir şey yapma
  if (!result.inspectorEnabled || !result.lockedTab) {
    return;
  }

  // Aktif tab değişti mi kontrol et
  const newActiveTabId = activeInfo.tabId;
  const lockedTabId = result.lockedTab.id;

  if (newActiveTabId !== lockedTabId) {
    // Farklı tab'a geçildi, otomatik durdur
    console.log('[Background] Tab switched during monitoring - auto-stopping');

    // Auto-stop reason set et
    await chrome.storage.local.set({ autoStoppedReason: 'tab_switch' });

    // Inspector'ı durdur (lockedTab kalsın - review için)
    await chrome.storage.local.remove(['inspectorEnabled']);

    // Badge'i güncelle
    updateBadge(false);

    // Locked tab'e mesaj gönder (page script'i durdur)
    try {
      await chrome.tabs.sendMessage(lockedTabId, {
        type: 'SET_ENABLED',
        enabled: false
      });
    } catch (e) {
      // Tab erişilemez olabilir (arka planda, suspended, vb.)
      console.log('[Background] Could not send stop message to locked tab:', e.message);
    }
  }
});

// Update badge based on inspector state (simpler than icon switching)
function updateBadge(isMonitoring) {
  if (isMonitoring) {
    // Show blue dot badge when monitoring (not red - that implies recording)
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#007aff' }); // iOS blue - monitoring, not recording
    console.log('[Background] ✅ Badge set to monitoring');
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

// Auto-inject page script when content script requests it
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_PAGE_SCRIPT' && sender.tab?.id) {
    const tabId = sender.tab.id;
    handleInjection(tabId, sender.frameId)
      .then(() => sendResponse({ success: true, tabId })) // Include tabId in response (sync alternative)
      .catch((err) => {
        console.error('Injection failed:', err);
        sendResponse({ success: false, error: err.message });
      });

    return true; // async response
  }

  // Content script'in kendi tab ID'sini öğrenmesi için
  if (message.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id });
    return false; // sync response
  }

  // Merkezi log ekleme - race condition önleme
  if (message.type === 'ADD_LOG') {
    addLog(message.entry);
    sendResponse({ success: true });
    return false; // sync response
  }

  // Note: PANEL_CLOSED artık port-based connection ile handle ediliyor (daha güvenilir)
  // Note: Icon updates now handled by storage.onChanged listener (see above)
});

/**
 * Handles the injection of the page script into the MAIN world
 */
async function handleInjection(tabId, frameId) {
  // frameId undefined veya null ise 0 kullan (main frame)
  const targetFrameId = frameId ?? 0;
  const extensionUrl = chrome.runtime.getURL('');
  const target = { tabId, frameIds: [targetFrameId] };

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
