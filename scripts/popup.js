// Side panel script
// ═══════════════════════════════════════════════════════════════════════════════
// MODULE IMPORTS
// ═══════════════════════════════════════════════════════════════════════════════
import {
  escapeHtml,
  formatTime,
  getLogColorClass
} from './modules/helpers.js';

import {
  renderRTCStats,
  renderGUMStats,
  renderACStats
} from './modules/renderers.js';

import {
  renderEncodingSection
} from './modules/encoding-ui.js';

import { measureFlowLabels } from './modules/audio-flow.js';

import { generateTextReport } from './modules/report-generator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════════
let latestData = null;
let enabled = false; // Default to false (stopped)
let drawerOpen = false; // Console drawer state
let currentTabId = null; // Track which tab this panel is associated with
let updateUITimer = null; // Debounce timer for updateUI() calls
let currentLogFilter = 'all'; // Console tab log filter state
let cachedLogs = []; // Cached logs for filtering
let currentDrawerTab = 'console'; // Active drawer tab: 'console' | 'extension'

// ═══════════════════════════════════════════════════════════════════════════════
// DRY: Storage keys fetched from background.js (single source of truth)
// Fallback array used until background.js responds (prevents race condition)
// ═══════════════════════════════════════════════════════════════════════════════
let DATA_STORAGE_KEYS = ['rtc_stats', 'user_media', 'audio_contexts', 'audio_worklet', 'media_recorder', 'detected_encoder', 'audio_connections'];

// Fetch actual keys from background.js (async, updates DATA_STORAGE_KEYS)
chrome.runtime.sendMessage({ type: 'GET_STORAGE_KEYS' }, (response) => {
  if (response?.keys) {
    DATA_STORAGE_KEYS = response.keys;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Centralized cleanup request helper
 * DRY: Delegates to background.js (single source of truth)
 * @param {string} preset - One of background.js CLEANUP_PRESETS keys
 * @param {Object} [options] - Optional overrides (rare)
 * @returns {Promise<void>}
 */
function requestCleanup(preset, options) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_INSPECTOR_DATA', preset, options }, () => resolve());
  });
}

/**
 * Clear inspector state + data + logs (full cleanup)
 * @param {Object} [options]
 * @returns {Promise<void>}
 */
function clearInspectorData(options) {
  return requestCleanup('FULL', options);
}

/**
 * Clear measurement data + logs, keep state (session cleanup)
 * @param {Object} [options]
 * @returns {Promise<void>}
 */
function clearSessionData(options) {
  return requestCleanup('SESSION', options);
}

/**
 * Clear only debug logs
 * @returns {Promise<void>}
 */
function clearLogsOnly() {
  return requestCleanup('LOGS_ONLY');
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a URL is a system page (chrome://, about://, etc.)
 * System pages don't support content script injection
 * @param {string|undefined} url - URL to check
 * @returns {boolean} true if system page or no URL
 */
function isSystemPage(url) {
  if (!url) return true;
  return url.startsWith('chrome://') ||
         url.startsWith('chrome-extension://') ||
         url.startsWith('about:') ||
         url.startsWith('file://');
}

// Debug log helper - background.js üzerinden merkezi yönetim (race condition önleme)
function debugLog(message) {
  const entry = {
    timestamp: Date.now(),
    level: 'info',
    prefix: 'Popup',
    message: message
  };

  chrome.runtime.sendMessage({ type: 'ADD_LOG', entry: entry });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI UPDATE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// Debounced UI update wrapper
// Batches rapid storage changes (e.g., audio_contexts + audio_connections) into single UI update
function updateUIDebounced() {
  if (updateUITimer !== null) {
    clearTimeout(updateUITimer);
  }

  updateUITimer = setTimeout(() => {
    updateUI();
    updateUITimer = null;
  }, 50); // 50ms debounce - waits for both context (20ms) + connections (16ms) debounces
}

// Main update function
async function updateUI() {
  // Get all relevant data from storage in one go
  const result = await chrome.storage.local.get([
    'rtc_stats',
    'user_media',
    'audio_contexts',
    'audio_connections',
    'detected_encoder',
    'media_recorder',
    'recording_active',
    'debug_logs',
    'lastUpdate',
    'lockedTab'
  ]);

  latestData = result; // Keep a copy for export

  // Tab ID validation - only show data from current locked tab
  // CRITICAL: When no tab is locked, NO data should be shown (prevents stale data display)
  const lockedTabId = result.lockedTab?.id;
  const isValidData = (data) => !data || (lockedTabId && data.sourceTabId === lockedTabId);

  // Filter audio_contexts array by sourceTabId
  // Only show contexts from the locked tab, nothing if no tab is locked
  const validAudioContexts = result.audio_contexts?.filter(ctx =>
    lockedTabId && ctx.sourceTabId === lockedTabId
  );

  // Filter audio_connections by sourceTabId
  const validAudioConnections = isValidData(result.audio_connections)
    ? result.audio_connections
    : null;

  // CANONICAL: Read from detected_encoder storage key (unified encoder detection)
  // Both URL pattern detection and opus hook detection emit to this key
  const validDetectedEncoder = isValidData(result.detected_encoder) ? result.detected_encoder : null;

  // Render each section with validated data
  // Data from different tabs is filtered out to prevent stale data display
  const validRtcStats = isValidData(result.rtc_stats) ? result.rtc_stats : null;
  const validMediaRecorder = isValidData(result.media_recorder) ? result.media_recorder : null;

  const validUserMedia = isValidData(result.user_media) ? result.user_media : null;
  const validRecordingActive = isValidData(result.recording_active) ? result.recording_active : null;

  renderRTCStats(validRtcStats);
  renderGUMStats(validUserMedia);
  // Pass encoding-related data via options object (OCP: config object pattern)
  renderACStats(validAudioContexts?.length > 0 ? validAudioContexts : null, {
    audioConnections: validAudioConnections,
    detectedEncoder: validDetectedEncoder,
    mediaRecorder: validMediaRecorder,
    recordingActive: validRecordingActive
  });
  renderEncodingSection(validDetectedEncoder, validRtcStats, validMediaRecorder, validAudioContexts?.length > 0 ? validAudioContexts : null, validUserMedia, validRecordingActive);
  renderDrawerLogs(result.debug_logs, updateLogBadge);

  // Audio flow render edildikten sonra label genişliklerini ölç
  requestAnimationFrame(() => {
    measureFlowLabels();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSPECTOR STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// Load inspector enabled state from storage
async function loadEnabledState() {
  const result = await chrome.storage.local.get('inspectorEnabled');
  // Default to false (stopped) - user must explicitly enable
  enabled = result.inspectorEnabled === true;
  updateToggleButton();
}

// Toggle inspector on/off
async function toggleInspector() {
  // Get active tab in current window
  const tabs = await chrome.tabs.query({active: true, currentWindow: true, url: ["http://*/*", "https://*/*"]});
  const activeTab = tabs[0];

  // STOP durumunda kilitli tab bilgisini al (mesajı oraya göndermek için)
  const result = await chrome.storage.local.get(['lockedTab', 'inspectorEnabled']);
  const lockedTab = result.lockedTab;

  // START durumunda geçerli tab yoksa işlem yapma (chrome://, about:, vb.)
  if (!enabled && !activeTab) {
    debugLog('⚠️ No valid tab to start inspector (chrome:// or about:// pages are not supported)');
    return;
  }

  // CRITICAL: Second start on same tab requires page refresh
  // Detects: inspector stopped + lockedTab exists + same tab = previous session data exists
  if (!enabled && lockedTab && lockedTab.id === activeTab?.id) {
    debugLog('⚠️ Second start detected on same tab - showing refresh modal');
    showRefreshModal(activeTab);
    return; // Don't proceed - wait for user decision
  }

  // Şimdi güvenle toggle yap
  enabled = !enabled;

  if (enabled && activeTab) {
    // START: Lock active tab
    const lockedTabData = {
      id: activeTab.id,
      url: activeTab.url,
      title: activeTab.title
    };
    debugLog(`🔒 Tab locked: ${activeTab.url} (id: ${activeTab.id})`);
    await chrome.storage.local.set({
      inspectorEnabled: true,
      lockedTab: lockedTabData
    });

    // Mesajı aktif tab'a gönder
    chrome.tabs.sendMessage(activeTab.id, {
      type: 'SET_ENABLED',
      enabled: true
    }, () => chrome.runtime.lastError); // Suppress error
  } else {
    // STOP: Send message to LOCKED TAB (Stop may have been pressed from different tab)
    debugLog('🔓 Tab lock removed');

    if (lockedTab?.id) {
      debugLog(`Stopping inspector on locked tab: ${lockedTab.id}`);
      chrome.tabs.sendMessage(lockedTab.id, {
        type: 'SET_ENABLED',
        enabled: false
      }, () => chrome.runtime.lastError); // Suppress error
    }

    // Stop'ta sadece inspectorEnabled'i sil, lockedTab'i BIRAK
    // Boylece veriler hala o tab'a ait olarak validate edilir ve gosterilir (review icin)
    // lockedTab, tab kapaninca background.js tarafindan temizlenir
    await chrome.storage.local.remove(['inspectorEnabled']);
  }

  // NOTE: Session cleanup (data + logs) is handled by content.js before collectors start emitting.

  // Update button AND UI to reflect new state
  // Note: checkTabLock() is called by storage listener when lockedTab changes (line 933)
  updateToggleButton();
  await updateUI(); // Critical: update label and data display
}

// Update toggle button appearance and recording mode
function updateToggleButton() {
  const btn = document.getElementById('toggleBtn');
  const statusText = document.getElementById('statusText');
  const body = document.body;

  if (enabled) {
    // Inspector çalışıyor → Stop butonu göster
    btn.innerHTML = '<span>Stop</span>';
    statusText.textContent = 'Inspecting';
    body.classList.add('inspecting');
  } else {
    // Inspector durmuş → Start butonu göster
    btn.innerHTML = '<span>Start</span>';
    statusText.textContent = 'Stopped';
    body.classList.remove('inspecting');
  }

  // Update Export/Clear buttons: disabled when inspector is running
  updateActionButtons(enabled);

  // Note: Icon is automatically updated by background.js storage listener
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB LOCK MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// Tab kilitleme kontrolü - popup açıldığında çağrılır
async function checkTabLock() {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.storage.local.get(['lockedTab', 'inspectorEnabled', 'autoStoppedReason']);

  debugLog(`checkTabLock: currentTab=${currentTab?.id}, lockedTab=${result.lockedTab?.id}, enabled=${result.inspectorEnabled}`);

  // Auto-stop: show banner only if inspector is NOT running, then remove
  // (inspector çalışıyorsa banner gösterme - merkezi temizleme noktası)
  if (result.autoStoppedReason && !result.inspectorEnabled) {
    showAutoStopBanner(result.autoStoppedReason);
    chrome.storage.local.remove(['autoStoppedReason']);
  } else if (result.inspectorEnabled) {
    // Inspector running - hide any existing auto-stop banner
    // (örn: technology_change sonrası "Refresh and Start" tıklandığında)
    hideAutoStopBanner();
  }

  // lockedTab varsa her zaman banner göster (running veya stopped - review için)
  if (result.lockedTab) {
    // Kilitli tab hala var mı kontrol et (edge case: background.js cleanup çalışmamış olabilir)
    try {
      await chrome.tabs.get(result.lockedTab.id);
    } catch (e) {
      // Tab no longer exists - remove lock and cleanup
      debugLog(`🧹 Locked tab no longer exists (id: ${result.lockedTab.id}), cleaning up`);
      await clearInspectorData();
      await hideLockedTabInfo();
      return true;
    }

    const isSameTab = result.lockedTab.id === currentTab?.id;

    // Show banner - whether inspector is running or not
    showLockedTabInfo(result.lockedTab, isSameTab, result.inspectorEnabled);
    debugLog(`Banner showing (${isSameTab ? 'same tab' : 'different tab'}, ${result.inspectorEnabled ? 'running' : 'stopped'}): ${result.lockedTab.url}`);

    return isSameTab;
  } else {
    debugLog('No lockedTab - hiding banner');
    await hideLockedTabInfo();
    return true;
  }
}

// Extract domain from locked tab - SRP: single responsibility for domain extraction
function extractDomain(lockedTab) {
  try {
    return new URL(lockedTab.url).hostname;
  } catch {
    return lockedTab.title || 'Unknown';
  }
}

// Get banner status text - SRP: single responsibility for text determination
function getBannerStatusText(isSameTab, isRunning) {
  if (isSameTab) {
    return isRunning ? 'Inspecting' : 'Stopped - Data from';
  }
  return 'Different tab - data from';
}

// Update banner CSS classes - SRP: single responsibility for styling
function updateBannerStyle(banner, isSameTab) {
  if (isSameTab) {
    banner.classList.add('visible', 'same-tab');
    banner.classList.remove('different-tab');
  } else {
    banner.classList.add('visible', 'different-tab');
    banner.classList.remove('same-tab');
  }
}

// Kilitli tab bilgisini göster - SRP: orchestration only
function showLockedTabInfo(lockedTab, isSameTab = false, isRunning = false) {
  const banner = document.getElementById('lockedTabBanner');
  const domainSpan = document.getElementById('lockedTabDomain');
  const bannerStatusText = document.getElementById('bannerStatusText');
  const controls = document.querySelector('.controls');

  if (!banner || !domainSpan || !bannerStatusText) {
    debugLog('❌ showLockedTabInfo: DOM element not found!');
    return;
  }

  // Extract and set domain
  const domain = extractDomain(lockedTab);
  domainSpan.textContent = domain;

  // Set status text
  bannerStatusText.textContent = getBannerStatusText(isSameTab, isRunning);

  // Update styling
  updateBannerStyle(banner, isSameTab);

  // Controls disabled state: Start button should be disabled on different tab
  if (isSameTab) {
    controls?.classList.remove('disabled');
  } else {
    controls?.classList.add('disabled');
  }

  debugLog(`✅ Banner shown: ${domain} (${isSameTab ? 'same' : 'different'} tab, ${isRunning ? 'running' : 'stopped'})`);
}

// Kilitli tab bilgisini gizle
async function hideLockedTabInfo() {
  const banner = document.getElementById('lockedTabBanner');
  const controls = document.querySelector('.controls');

  banner?.classList.remove('visible', 'same-tab', 'different-tab');

  // Enable controls immediately, then check for system page
  // This is more reliable than async updateControlsForCurrentTab()
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (isSystemPage(currentTab?.url)) {
    controls?.classList.add('disabled');
  } else {
    controls?.classList.remove('disabled');
  }
}

// Update controls disabled state based on page type (chrome://, about://, etc.)
async function updateControlsForCurrentTab() {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const controls = document.querySelector('.controls');

  if (isSystemPage(currentTab?.url)) {
    controls?.classList.add('disabled');
    debugLog(`⚠️ System page detected - controls disabled: ${currentTab?.url || 'no URL'}`);
  } else {
    controls?.classList.remove('disabled');
  }
}

// Update Export/Clear buttons disabled state based on inspector running state
function updateActionButtons(inspectorRunning) {
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');

  if (inspectorRunning) {
    exportBtn?.classList.add('disabled');
    clearBtn?.classList.add('disabled');
  } else {
    exportBtn?.classList.remove('disabled');
    clearBtn?.classList.remove('disabled');
  }
}

// Auto-stop bildirimi göster (origin değişikliği vb.)
// Banner click-to-dismiss - kullanıcı tıklayana kadar kalır
function showAutoStopBanner(reason) {
  const banner = document.getElementById('autoStopBanner');
  if (!banner) return;

  const messages = {
    'origin_change': 'Inspector stopped: Site changed',
    'injection_failed': 'Injection failed - please reload page',
    'tab_switch': '⚠️ Inspecting stopped: Switched to different tab',
    'navigation': '⚠️ Inspector stopped: Navigated to different site',
    'window_switch': '⚠️ Inspector stopped: Switched to different window',
    'technology_change': '🔄 Recording technology changed'
  };
  banner.textContent = messages[reason] || 'Inspector stopped';
  banner.classList.add('visible');

  // Click to dismiss (no timeout - user must acknowledge)
  banner.onclick = () => {
    banner.classList.remove('visible');
    banner.onclick = null;
  };

  debugLog(`Auto-stop banner shown: ${reason}`);
}

// Auto-stop banner'ı gizle (inspector başladığında çağrılır)
function hideAutoStopBanner() {
  const banner = document.getElementById('autoStopBanner');
  if (banner) {
    banner.classList.remove('visible');
    banner.onclick = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA EXPORT AND CLEAR
// ═══════════════════════════════════════════════════════════════════════════════

// Export function - reads from current UI DOM state
function exportData() {
  // Generate text report from rendered UI (no data parameter needed)
  const reportText = generateTextReport();

  if (!reportText || reportText.trim().length === 0) {
    alert('No data to export');
    return;
  }

  const blob = new Blob([reportText], { type: 'text/plain; charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `audio-inspector-${Date.now()}.txt`;
  a.click();

  URL.revokeObjectURL(url);
}

// Clear data
async function clearData() {
  // First stop inspector if running (prevents collector from refilling data)
  const result = await chrome.storage.local.get(['inspectorEnabled', 'lockedTab']);
  if (result.inspectorEnabled && result.lockedTab) {
    try {
      await chrome.tabs.sendMessage(result.lockedTab.id, {
        type: 'SET_ENABLED',
        enabled: false
      });
    } catch (e) {
      // Tab may be closed, continue with clear
    }
  }

  // Then clear inspector storage (centralized) - keep persistent keys like platformInfo
  await clearInspectorData({ includeAutoStopReason: true });
  location.reload();
}

// Copy ALL logs to clipboard (everything - Console + Extension, all levels)
async function copyAllLogs() {
  const result = await chrome.storage.local.get('debug_logs');
  const logs = result.debug_logs || [];

  if (logs.length === 0) {
    alert('No logs to copy');
    return;
  }

  // Format ALL logs as plain text (no filtering)
  const text = logs.map(log => {
    const time = formatTime(log.timestamp);
    return `${time} [${log.prefix}] ${log.message}`;
  }).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    // Show feedback
    const btn = document.getElementById('copyAllLogsBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.color = 'var(--accent-green)';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = '';
    }, 1500);
  } catch (err) {
    console.error('[Popup] Failed to copy logs:', err);
    alert('Failed to copy logs');
  }
}

// Copy VISIBLE logs to clipboard (respects active tab + level filter)
async function copyVisibleLogs() {
  const result = await chrome.storage.local.get('debug_logs');
  const allLogs = result.debug_logs || [];

  // Filter based on active tab
  let logs = currentDrawerTab === 'console'
    ? allLogs.filter(l => l.prefix === 'Console')
    : allLogs.filter(l => l.prefix !== 'Console');

  // Apply level filter
  if (currentLogFilter !== 'all') {
    logs = logs.filter(l => l.level === currentLogFilter);
  }

  if (logs.length === 0) {
    alert('No logs to copy');
    return;
  }

  // Format logs as plain text
  const text = logs.map(log => {
    const time = formatTime(log.timestamp);
    return `${time} [${log.prefix}] ${log.message}`;
  }).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    // Show feedback
    const btn = document.getElementById('copyVisibleLogsBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.color = 'var(--accent-green)';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = '';
    }, 1500);
  } catch (err) {
    console.error('[Popup] Failed to copy logs:', err);
    alert('Failed to copy logs');
  }
}

// Clear logs only
async function clearLogs() {
  await clearLogsOnly();
  cachedLogs = [];
  renderDrawerLogs([], updateLogBadge);
}

// Toggle console drawer
function toggleDrawer() {
  drawerOpen = !drawerOpen;
  const drawer = document.getElementById('drawerOverlay');
  drawer.classList.toggle('open', drawerOpen);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAWER FILTERS (Tab + Level)
// ═══════════════════════════════════════════════════════════════════════════════

// Setup drawer filters (tab selection + level filter)
function setupDrawerFilters() {
  // Tab seçimi (drawer-tab class)
  document.querySelectorAll('.drawer-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      if (targetTab === currentDrawerTab) return;

      currentDrawerTab = targetTab;

      // Update tab button states
      document.querySelectorAll('.drawer-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === targetTab));

      // Update tab content visibility
      document.getElementById('consoleLogsContent')
        ?.classList.toggle('active', targetTab === 'console');
      document.getElementById('extensionLogsContent')
        ?.classList.toggle('active', targetTab === 'extension');

      // Re-render logs for new tab
      renderDrawerLogs(cachedLogs, updateLogBadge);
    });
  });

  // Level filtresi (filter-btn with data-level)
  document.querySelectorAll('.filter-btn[data-level]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentLogFilter = btn.dataset.level;

      // Update level button states
      document.querySelectorAll('.filter-btn[data-level]').forEach(b =>
        b.classList.toggle('active', b.dataset.level === currentLogFilter));

      // Re-render with filter
      renderDrawerLogs(cachedLogs, updateLogBadge);
    });
  });
}

// Render drawer logs with tab separation and level filtering
// Console tab: logs with prefix 'Console' (page DevTools output)
// Extension tab: all other logs (extension internal)
function renderDrawerLogs(logs, badgeCallback) {
  const consoleContainer = document.getElementById('consoleLogsContent');
  const extensionContainer = document.getElementById('extensionLogsContent');

  if (!logs?.length) {
    if (consoleContainer) consoleContainer.innerHTML = '<div class="no-data">No console logs</div>';
    if (extensionContainer) extensionContainer.innerHTML = '<div class="no-data">Waiting for events...</div>';
    badgeCallback?.(0);
    return;
  }

  // Cache logs for filtering
  cachedLogs = logs;

  // Split logs by source
  const consoleLogs = logs.filter(l => l.prefix === 'Console');
  const extensionLogs = logs.filter(l => l.prefix !== 'Console');

  // Render Console tab
  renderLogList(consoleContainer, consoleLogs, 'No console logs');

  // Render Extension tab
  renderLogList(extensionContainer, extensionLogs, 'Waiting for events...');

  // Update badge (total count)
  badgeCallback?.(logs.length);
}

// Helper: Render log list with filtering
function renderLogList(container, logs, emptyMessage) {
  if (!container) return;

  // Apply level filter
  const filtered = currentLogFilter === 'all'
    ? logs
    : logs.filter(l => l.level === currentLogFilter);

  if (filtered.length === 0) {
    const msg = currentLogFilter === 'all' ? emptyMessage : `No ${currentLogFilter} logs`;
    container.innerHTML = `<div class="no-data">${msg}</div>`;
    return;
  }

  container.innerHTML = filtered.map(log => {
    const colorClass = getLogColorClass(log.level);
    return `
      <div class="log-line ${colorClass}">
        <span class="log-time">${formatTime(log.timestamp)}</span>
        <span class="log-prefix">[${escapeHtml(log.prefix || 'System')}]</span>
        <span class="log-message">${escapeHtml(log.message || '')}</span>
      </div>
    `;
  }).join('');

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFRESH MODAL
// ═══════════════════════════════════════════════════════════════════════════════

// Show refresh required modal
function showRefreshModal(activeTab) {
  const modal = document.getElementById('refreshModal');
  modal.classList.add('visible');
  // Store tab info for confirm handler
  modal.dataset.tabId = activeTab.id;
}

// Hide refresh modal
function hideRefreshModal() {
  const modal = document.getElementById('refreshModal');
  modal.classList.remove('visible');
  delete modal.dataset.tabId;
}

// Handle refresh and start
async function handleRefreshAndStart() {
  const modal = document.getElementById('refreshModal');
  const tabId = parseInt(modal.dataset.tabId, 10);

  if (!tabId) {
    debugLog('❌ No tab ID found for refresh');
    hideRefreshModal();
    return;
  }

  debugLog(`🔄 Refreshing tab ${tabId} and setting pendingAutoStart`);

  // Clear previous session data first
  await clearInspectorData({ includeAutoStopReason: true });

  // Set pendingAutoStart flag - content.js will auto-start after reload
  await chrome.storage.local.set({ pendingAutoStart: tabId });

  // Hide modal
  hideRefreshModal();

  // Reload the tab
  chrome.tabs.reload(tabId);
}

// Update log badge count
function updateLogBadge(count) {
  const badge = document.getElementById('logBadge');
  if (!badge) return;

  badge.textContent = count;
  badge.classList.toggle('empty', count === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOLTIP POSITIONING (overflow container'larda çalışması için)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize tooltip positioning system
 * Problem: CSS overflow-x: visible + overflow-y: auto kombinasyonu çalışmaz
 * Çözüm: position: fixed + JavaScript ile viewport-relative konumlandırma
 */
function initTooltipPositioning() {
  document.addEventListener('mouseenter', (e) => {
    // Sadece Element hedefler için çalış (document/Text node'larda closest yok)
    if (!e.target.closest) return;

    const el = e.target.closest('.has-tooltip, .flow-tooltip, .truncated-tooltip');
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const isLeft = el.classList.contains('tooltip-left') || el.classList.contains('flow-tooltip');
    const isTruncated = el.classList.contains('truncated-tooltip');

    // Tooltip konumunu hesapla
    let top, left;
    if (isTruncated) {
      // Truncated tooltip: label'ın solunda, üst kenara hizalı
      top = rect.top;
      left = rect.left - 8;
    } else if (isLeft) {
      // Sol tooltip: dikey ortalı
      top = rect.top + rect.height / 2;
      left = rect.left - 8;
    } else {
      // Sağ tooltip: dikey ortalı
      top = rect.top + rect.height / 2;
      left = rect.right + 8;
    }

    el.style.setProperty('--tt-top', top + 'px');
    el.style.setProperty('--tt-left', left + 'px');
  }, true); // capture phase - event bubbling'den önce yakala
}

// Initialize tooltip positioning
initTooltipPositioning();

/**
 * Truncated value'lar için otomatik tooltip
 * scrollWidth > clientWidth ise tooltip aktif
 */
function initTruncatedTooltips() {
  const selector = 'td:last-child';  // ENCODING section value'ları

  function updateTruncatedTooltips() {
    document.querySelectorAll(selector).forEach(td => {
      const isTruncated = td.scrollWidth > td.clientWidth;

      if (isTruncated) {
        td.classList.add('truncated-tooltip');
        td.setAttribute('data-tooltip', td.textContent.trim());
      } else {
        td.classList.remove('truncated-tooltip');
        td.removeAttribute('data-tooltip');
      }
    });
  }

  // İlk çalıştırma
  updateTruncatedTooltips();

  // Panel resize'da güncelle
  const observer = new ResizeObserver(updateTruncatedTooltips);
  observer.observe(document.body);

  // DOM değişikliklerinde güncelle (yeni row eklendiğinde)
  const mutationObserver = new MutationObserver(updateTruncatedTooltips);
  mutationObserver.observe(document.body, { childList: true, subtree: true });
}

// Initialize truncated tooltips
initTruncatedTooltips();

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════════

document.getElementById('toggleBtn').addEventListener('click', toggleInspector);
document.getElementById('exportBtn').addEventListener('click', exportData);
document.getElementById('clearBtn').addEventListener('click', clearData);
document.getElementById('copyAllLogsBtn').addEventListener('click', copyAllLogs);
document.getElementById('copyVisibleLogsBtn').addEventListener('click', copyVisibleLogs);
document.getElementById('clearLogsBtn').addEventListener('click', clearLogs);
document.getElementById('drawerHandle').addEventListener('click', toggleDrawer);

// Initialize drawer filters (tab + level unified)
setupDrawerFilters();

// Refresh modal event listeners
document.getElementById('refreshModalCancel').addEventListener('click', hideRefreshModal);
document.getElementById('refreshModalConfirm').addEventListener('click', handleRefreshAndStart);

// Tab değişikliğini dinle - banner'ı güncelle
// Side panel global, tab değişince yeniden yüklenmiyor
chrome.tabs.onActivated.addListener((activeInfo) => {
  // currentTabId'yi güncelle (tabs.onUpdated için gerekli)
  currentTabId = activeInfo.tabId;
  checkTabLock();
});

// Tab URL değişikliğini dinle - navigation sonrası controls durumunu güncelle
// Örn: chrome://newtab → web sitesi geçişinde Start butonunu aktif et
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Sadece URL değişikliklerini izle ve sadece mevcut tab için
  if (changeInfo.url && tabId === currentTabId) {
    checkTabLock();
  }
});

// Listen for storage changes instead of polling
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    // Only update UI if relevant keys changed (uses DATA_STORAGE_KEYS for DRY)
    // Note: audioWorklet data is now merged into audio_contexts, but keep key for direct updates
    const shouldUpdate = Object.keys(changes).some(key => DATA_STORAGE_KEYS.includes(key));

    if (shouldUpdate) {
      // Use debounced update to batch rapid storage changes
      // (e.g., audio_contexts + audio_connections written separately but close together)
      updateUIDebounced();
    }

    // Update logs if they changed
    if (changes.debug_logs) {
      const newLogs = changes.debug_logs.newValue || [];
      renderDrawerLogs(newLogs, updateLogBadge);
    }

    // Also check for inspectorEnabled change
    if (changes.inspectorEnabled) {
      const newValue = changes.inspectorEnabled.newValue === true;
      // Only update if actually changed (prevent race conditions)
      if (enabled !== newValue) {
        enabled = newValue;
        updateToggleButton();
      }
      // Tab switch'te banner'ı da güncelle (inspectorEnabled silindiğinde)
      checkTabLock();
    }

    // lockedTab değişikliği (tab kapatıldığında background.js tarafından silinir)
    if (changes.lockedTab) {
      // lockedTab silindiyse enabled'ı da sıfırla (inspectorEnabled aynı anda silinmiş olabilir)
      if (!changes.lockedTab.newValue) {
        enabled = false;
        updateToggleButton();
      }
      // lockedTab silindiyse veya değiştiyse tab lock kontrolü yap
      checkTabLock();
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL PORT (for close detection)
// ═══════════════════════════════════════════════════════════════════════════════

// Panel kapanma bildirimi için port-based connection (beforeunload güvenilir değil)
// Port açıldığında background.js'e tabId gönderilir, panel kapandığında port otomatik disconnect olur
let panelPort = null;

function setupPanelPort() {
  if (!currentTabId) return;

  panelPort = chrome.runtime.connect({ name: `sidepanel-${currentTabId}` });
  panelPort.onDisconnect.addListener(() => {
    // Port kapandı - bu normal, panel kapanıyor demek
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIAL LOAD
// ═══════════════════════════════════════════════════════════════════════════════

loadEnabledState().then(async () => {
  // Panel açıldığında aktif tab ID'sini kaydet (kapanma bildirim için)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = activeTab?.id;

  // Port-based connection kur (panel kapanınca background.js otomatik bilgilendirilir)
  setupPanelPort();

  // Tab kilitleme kontrolü
  await checkTabLock();

  // If inspector is not enabled AND no locked tab exists, clear any old data
  // (lockedTab varsa veriler o tab'a ait, review için korunmalı)
  const { lockedTab } = await chrome.storage.local.get(['lockedTab']);
  if (!enabled && !lockedTab) {
    await clearSessionData();
  }
  updateUI();
});
