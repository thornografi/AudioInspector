// Background service worker

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH: Storage keys for collected data
// Other scripts (content.js, popup.js) get these via GET_STORAGE_KEYS message
// This eliminates DRY violation across 3 files
// ═══════════════════════════════════════════════════════════════════════════════
const DATA_STORAGE_KEYS = [
  'rtc_stats', 'user_media', 'audio_contexts',
  'audio_worklet', 'media_recorder', 'wasm_encoder',
  'audio_connections'
];

/**
 * Clear inspector state and data from storage
 * SINGLE SOURCE OF TRUTH: Other scripts call via CLEAR_INSPECTOR_DATA message
 *
 * @param {Object} [options={}] - Cleanup options
 * @param {boolean} [options.includeAutoStopReason=false] - Include autoStoppedReason key
 * @param {boolean} [options.includeLogs=true] - Include debug_logs (default true for background.js)
 * @param {boolean} [options.dataOnly=false] - Only clear measurement data, keep state
 * @returns {Promise<void>}
 */
function clearInspectorData(options = {}) {
  const { includeAutoStopReason = false, includeLogs = true, dataOnly = false } = options;

  let keys;
  if (dataOnly) {
    // Only measurement data - used by content.js/popup.js clearMeasurementData()
    keys = [...DATA_STORAGE_KEYS];
  } else {
    // Full clear - state + data + optionally logs
    keys = ['inspectorEnabled', 'lockedTab', 'pendingAutoStart', ...DATA_STORAGE_KEYS];
    if (includeLogs) {
      keys.push('debug_logs');
    }
    if (includeAutoStopReason) {
      keys.push('autoStoppedReason');
    }
  }

  return chrome.storage.local.remove(keys);
}


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

  // Reset ALL state on install/update - clean slate
  clearInspectorData({ includeAutoStopReason: true });
  updateBadge(false);

  // Reload test pages immediately on install/update
  reloadTestTabs();
});

// Chrome başlatıldığında temizlik - browser restart sonrası clean slate
chrome.runtime.onStartup.addListener(() => {
  console.log('AudioInspector startup - cleaning previous session');
  clearInspectorData({ includeAutoStopReason: true });
  updateBadge(false);
});

// Toggle side panel when extension icon is clicked
let panelOpenTabs = new Set(); // Track which tabs have the panel open
let togglingTabs = new Set(); // Mutex: prevent rapid click race condition
let handlingTabSwitch = false; // Mutex: prevent rapid tab switch race condition

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

// Log temizleme: extension restart, browser restart, tab kapatma, pencere kapatma, navigation

// Tab kapatıldığında kilitli tab kontrolü ve panel tracking temizliği
chrome.tabs.onRemoved.addListener((tabId) => {
  // Panel tracking temizle
  panelOpenTabs.delete(tabId);

  // Kilitli tab kontrolü
  chrome.storage.local.get(['lockedTab'], (result) => {
    if (result.lockedTab && result.lockedTab.id === tabId) {
      console.log('[Background] Kilitli tab kapatıldı, state, veriler ve loglar temizleniyor');
      clearInspectorData();
      updateBadge(false);
    }
  });
});

// Tab URL değişikliği kontrolü - cross-origin navigation'da inspector'ı durdur
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Sadece URL değişikliklerini izle
  if (!changeInfo.url) return;

  chrome.storage.local.get(['inspectorEnabled', 'lockedTab'], (result) => {
    if (!result.lockedTab || result.lockedTab.id !== tabId) return;

    // Origin karşılaştırması
    try {
      const oldOrigin = new URL(result.lockedTab.url).origin;
      const newOrigin = new URL(changeInfo.url).origin;

      if (oldOrigin !== newOrigin) {
        console.log(`[Background] 🔄 Cross-origin navigation (${oldOrigin} → ${newOrigin}), inspector durduruluyor`);
        chrome.storage.local.set({ autoStoppedReason: 'navigation' });
        clearInspectorData();
        updateBadge(false);
      }
    } catch (e) {
      // URL parse hatası - güvenli tarafta kal, inspector'ı durdur
      console.log('[Background] URL parse error during navigation check, stopping inspector');
      clearInspectorData();
      updateBadge(false);
    }
  });
});

// Tab değişimi (activation) kontrolü - aktif dinleme varsa otomatik durdur
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Mutex: prevent rapid tab switch race condition
  if (handlingTabSwitch) return;
  handlingTabSwitch = true;

  try {
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
  } finally {
    handlingTabSwitch = false;
  }
});

// Pencere kapatıldığında kilitli tab kontrolü - tab kapatma ile aynı davranış
chrome.windows.onRemoved.addListener(async (windowId) => {
  const result = await chrome.storage.local.get(['lockedTab']);
  if (!result.lockedTab) return;

  // Kilitli tab'ın hangi pencerede olduğunu kontrol et
  try {
    await chrome.tabs.get(result.lockedTab.id);
    // Tab hala var, farklı pencere kapatılmış - hiçbir şey yapma
  } catch (e) {
    // Tab artık yok = kilitli tab'ın penceresi kapatıldı
    console.log('[Background] 🪟 Kilitli tab\'ın penceresi kapatıldı, state, veriler ve loglar temizleniyor');
    await clearInspectorData();
    updateBadge(false);
  }
});

// Pencere değişikliği kontrolü - farklı pencereye geçildiğinde otomatik durdur
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  // WINDOW_ID_NONE = -1 (tüm pencereler focus kaybetti, örn: başka uygulamaya geçildi)
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  const result = await chrome.storage.local.get(['inspectorEnabled', 'lockedTab']);
  if (!result.inspectorEnabled || !result.lockedTab) return;

  // Kilitli tab'ın hangi pencerede olduğunu kontrol et
  try {
    const lockedTab = await chrome.tabs.get(result.lockedTab.id);
    if (lockedTab.windowId !== windowId) {
      // Farklı pencereye geçildi
      console.log('[Background] 🪟 Window switched during monitoring - auto-stopping');
      await chrome.storage.local.set({ autoStoppedReason: 'window_switch' });
      await chrome.storage.local.remove(['inspectorEnabled']);
      updateBadge(false);

      // Kilitli tab'e mesaj gönder (page script'i durdur)
      try {
        await chrome.tabs.sendMessage(result.lockedTab.id, { type: 'SET_ENABLED', enabled: false });
      } catch (e) {
        // Tab erişilemez olabilir
        console.log('[Background] Could not send stop message to locked tab:', e.message);
      }
    }
  } catch (e) {
    // Tab artık yok - bu durumda zaten tabs.onRemoved temizlik yapmış olmalı
    console.log('[Background] Locked tab no longer exists during window switch check');
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

  // ═══════════════════════════════════════════════════════════════════════════
  // CENTRALIZED STATE DECISION: PAGE_READY handler
  // All state decisions are made here - content.js only executes commands
  // This prevents race conditions and duplicate logic across scripts
  // ═══════════════════════════════════════════════════════════════════════════
  if (message.type === 'PAGE_READY') {
    handlePageReady(message, sender)
      .then(response => sendResponse(response))
      .catch(err => {
        console.error('[Background] PAGE_READY error:', err);
        sendResponse({ action: 'NONE', error: err.message });
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

  // ═══════════════════════════════════════════════════════════════════════════
  // DRY: Single source of truth for storage keys
  // content.js and popup.js get keys via this message instead of duplicating
  // ═══════════════════════════════════════════════════════════════════════════
  if (message.type === 'GET_STORAGE_KEYS') {
    sendResponse({ keys: DATA_STORAGE_KEYS });
    return false; // sync response
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRY: Centralized data clearing - prevents duplicate clearInspectorData() in each file
  // Options: { dataOnly: true } for measurement data only, { includeLogs: false } to keep logs
  // ═══════════════════════════════════════════════════════════════════════════
  if (message.type === 'CLEAR_INSPECTOR_DATA') {
    clearInspectorData(message.options || {}).then(() => {
      sendResponse({ success: true });
    });
    return true; // async response
  }

  // Note: PANEL_CLOSED artık port-based connection ile handle ediliyor (daha güvenilir)
  // Note: Icon updates now handled by storage.onChanged listener (see above)
});

/**
 * Centralized state decision handler for PAGE_READY
 * Determines what action content.js should take based on current state
 *
 * Decision matrix:
 * | pendingAutoStart | inspectorEnabled | lockedTab | sameTab | sameOrigin | Action |
 * |------------------|------------------|-----------|---------|------------|--------|
 * | YES (=tabId)     | -                | -         | -       | -          | START  |
 * | NO               | YES              | YES       | YES     | YES        | START  |
 * | NO               | YES              | YES       | YES     | NO         | STOP (origin change) |
 * | NO               | YES              | YES       | NO      | -          | NONE (different tab) |
 * | NO               | NO/missing       | YES       | YES     | -          | NONE + clear lockedTab |
 * | NO               | NO/missing       | NO        | -       | -          | NONE   |
 *
 * @param {Object} message - { tabId, url, origin, title }
 * @param {Object} sender - Chrome sender object
 * @returns {Promise<{action: string, reason?: string}>}
 */
async function handlePageReady(message, sender) {
  const { tabId, url, origin, title } = message;
  const result = await chrome.storage.local.get(['inspectorEnabled', 'lockedTab', 'pendingAutoStart']);

  console.log(`[Background] PAGE_READY: tab=${tabId}, origin=${origin}`);
  console.log(`[Background] State: enabled=${result.inspectorEnabled}, lockedTab=${result.lockedTab?.id}, pending=${result.pendingAutoStart}`);

  // ─────────────────────────────────────────────────────────────────────────
  // PRIORITY 1: pendingAutoStart (Refresh Modal flow)
  // User clicked "Refresh and Start" - auto-start after page reload
  // ─────────────────────────────────────────────────────────────────────────
  if (result.pendingAutoStart && result.pendingAutoStart === tabId) {
    console.log('[Background] ✅ pendingAutoStart matched - starting inspector');

    // Clear pending flag and set up new session
    await chrome.storage.local.remove(['pendingAutoStart']);
    await chrome.storage.local.set({
      inspectorEnabled: true,
      lockedTab: { id: tabId, url, title }
    });
    updateBadge(true);

    return { action: 'START', reason: 'pendingAutoStart' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIORITY 2: Active inspector session restoration
  // ─────────────────────────────────────────────────────────────────────────
  if (result.inspectorEnabled === true && result.lockedTab) {
    const lockedTabId = result.lockedTab.id;
    let lockedOrigin;
    try {
      lockedOrigin = new URL(result.lockedTab.url).origin;
    } catch {
      lockedOrigin = null;
    }

    // Tab ID check
    if (tabId !== lockedTabId) {
      console.log(`[Background] Different tab (${tabId} != ${lockedTabId}) - not restoring`);
      return { action: 'NONE', reason: 'different_tab' };
    }

    // Origin check - same tab but navigated to different site
    if (origin !== lockedOrigin) {
      console.log(`[Background] 🔄 Origin changed (${lockedOrigin} → ${origin}) - auto-stopping`);

      // Auto-stop and clear state
      await chrome.storage.local.set({ autoStoppedReason: 'origin_change' });
      await clearInspectorData();
      updateBadge(false);

      return { action: 'STOP', reason: 'origin_change' };
    }

    // Same tab, same origin - restore inspector
    console.log('[Background] ✅ Tab + origin match - restoring inspector');

    // Update lockedTab URL in case path changed (same origin navigation)
    await chrome.storage.local.set({
      lockedTab: { id: tabId, url, title }
    });

    return { action: 'START', reason: 'session_restore' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIORITY 3: Inspector stopped - cleanup stale lockedTab
  // ─────────────────────────────────────────────────────────────────────────
  if (result.lockedTab && result.lockedTab.id === tabId) {
    // Page refreshed while inspector was stopped - clear stale lockedTab
    // This prevents Refresh Modal from appearing unnecessarily
    console.log('[Background] 🧹 Clearing stale lockedTab (page refresh while stopped)');
    await chrome.storage.local.remove(['lockedTab']);
  }

  return { action: 'NONE', reason: 'inspector_stopped' };
}

/**
 * Handles the injection of the page script into the MAIN world
 */
async function handleInjection(tabId, frameId) {
  // frameId undefined/null ise 0 kullan (main frame)
  const targetFrameId = Number.isInteger(frameId) ? frameId : 0;
  const extensionUrl = chrome.runtime.getURL('');

  const injectIntoFrame = async (frameIdToUse) => {
    const target = { tabId, frameIds: [frameIdToUse] };

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
  };

  try {
    await injectIntoFrame(targetFrameId);
  } catch (err) {
    if (targetFrameId !== 0 && isMissingFrameError(err)) {
      console.warn('[Background] Frame not found, retrying injection in main frame:', err?.message || err);
      await injectIntoFrame(0);
      return;
    }
    throw err;
  }
}

function isMissingFrameError(err) {
  const message = err?.message ? err.message : String(err || '');
  return message.includes('No frame with id') || message.includes('Frame with ID');
}
