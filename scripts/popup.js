// Side panel script
let latestData = null;
let enabled = false; // Default to false (stopped)
let drawerOpen = false; // Console drawer state
let currentTabId = null; // Track which tab this panel is associated with
let updateUITimer = null; // Debounce timer for updateUI() calls

// Constants - MUST be kept in sync with src/core/constants.js
// (popup.js cannot import ES modules, so values are duplicated here)
const DESTINATION_TYPES = {
  SPEAKERS: 'speakers',
  MEDIA_STREAM: 'MediaStreamDestination'
};
const MAX_AUDIO_CONTEXTS = 4; // UI_LIMITS.MAX_AUDIO_CONTEXTS in constants.js

// ═══════════════════════════════════════════════════════════════════════════════
// DRY: Storage keys fetched from background.js (single source of truth)
// Fallback array used until background.js responds (prevents race condition)
// ═══════════════════════════════════════════════════════════════════════════════
let DATA_STORAGE_KEYS = ['rtc_stats', 'user_media', 'audio_contexts', 'audio_worklet', 'media_recorder', 'detected_encoder', 'audio_connections', 'recording_active'];

// Fetch actual keys from background.js (async, updates DATA_STORAGE_KEYS)
chrome.runtime.sendMessage({ type: 'GET_STORAGE_KEYS' }, (response) => {
  if (response?.keys) {
    DATA_STORAGE_KEYS = response.keys;
  }
});

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

/**
 * Check if a URL is a system page (chrome://, about://, etc.)
 * System pages don't support content script injection
 * DRY helper - used in hideLockedTabInfo() and updateControlsForCurrentTab()
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
  renderACStats(validAudioContexts?.length > 0 ? validAudioContexts : null, validAudioConnections);
  renderEncodingSection(validDetectedEncoder, validRtcStats, validMediaRecorder, validAudioContexts?.length > 0 ? validAudioContexts : null, validUserMedia, validRecordingActive);
  renderDebugLogs(result.debug_logs);
}

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
    // START: Clear any stale auto-stop reason first (prevents 3-4s banner flash)
    await chrome.storage.local.remove(['autoStoppedReason']);

    // START: Aktif tab'ı kilitle
    const lockedTabData = {
      id: activeTab.id,
      url: activeTab.url,
      title: activeTab.title
    };
    debugLog(`🔒 Tab kilitlendi: ${activeTab.url} (id: ${activeTab.id})`);
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
    // STOP: Mesajı KİLİTLİ TAB'A gönder (farklı tab'dan Stop'a basılmış olabilir)
    debugLog('🔓 Tab kilidi kaldırıldı');

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

// Tab kilitleme kontrolü - popup açıldığında çağrılır
async function checkTabLock() {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.storage.local.get(['lockedTab', 'inspectorEnabled', 'autoStoppedReason']);

  debugLog(`checkTabLock: currentTab=${currentTab?.id}, lockedTab=${result.lockedTab?.id}, enabled=${result.inspectorEnabled}`);

  // Auto-stop bildirimi varsa göster ve temizle
  if (result.autoStoppedReason) {
    showAutoStopBanner(result.autoStoppedReason);
    chrome.storage.local.remove(['autoStoppedReason']);
  }

  // lockedTab varsa her zaman banner göster (running veya stopped - review için)
  if (result.lockedTab) {
    // Kilitli tab hala var mı kontrol et (edge case: background.js cleanup çalışmamış olabilir)
    try {
      await chrome.tabs.get(result.lockedTab.id);
    } catch (e) {
      // Tab artık yok - kilidi kaldır ve temizlik yap
      debugLog(`🧹 Kilitli tab artık yok (id: ${result.lockedTab.id}), temizleniyor`);
      await clearInspectorData();
      await hideLockedTabInfo();
      return true;
    }

    const isSameTab = result.lockedTab.id === currentTab?.id;

    // Banner'ı göster - inspector çalışıyor olsun ya da olmasın
    showLockedTabInfo(result.lockedTab, isSameTab, result.inspectorEnabled);
    debugLog(`Banner gösteriliyor (${isSameTab ? 'aynı tab' : 'farklı tab'}, ${result.inspectorEnabled ? 'running' : 'stopped'}): ${result.lockedTab.url}`);

    return isSameTab;
  } else {
    debugLog('lockedTab yok - banner gizleniyor');
    await hideLockedTabInfo();
    return true;
  }
}

// Extract domain from locked tab - SRP: single responsibility for domain extraction
function extractDomain(lockedTab) {
  try {
    return new URL(lockedTab.url).hostname;
  } catch {
    return lockedTab.title || 'Bilinmeyen';
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
    debugLog('❌ showLockedTabInfo: DOM element bulunamadı!');
    return;
  }

  // Extract and set domain
  const domain = extractDomain(lockedTab);
  domainSpan.textContent = domain;

  // Set status text
  bannerStatusText.textContent = getBannerStatusText(isSameTab, isRunning);

  // Update styling
  updateBannerStyle(banner, isSameTab);

  // Controls disabled state: farklı tab'da Start butonu disabled olmalı
  if (isSameTab) {
    controls?.classList.remove('disabled');
  } else {
    controls?.classList.add('disabled');
  }

  debugLog(`✅ Banner gösterildi: ${domain} (${isSameTab ? 'aynı' : 'farklı'} tab, ${isRunning ? 'running' : 'stopped'})`);
}

// Kilitli tab bilgisini gizle
async function hideLockedTabInfo() {
  const banner = document.getElementById('lockedTabBanner');
  const controls = document.querySelector('.controls');

  banner?.classList.remove('visible', 'same-tab', 'different-tab');

  // Controls'u hemen enabled yap, sonra sistem sayfası kontrolü yap
  // Bu async updateControlsForCurrentTab()'dan daha güvenilir
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
function showAutoStopBanner(reason) {
  const banner = document.getElementById('autoStopBanner');
  if (!banner) return;

  const messages = {
    'origin_change': 'Inspector stopped: Site changed',
    'injection_failed': 'Injection failed - please reload page',
    'tab_switch': '⚠️ Inspecting stopped: Switched to different tab',
    'navigation': '⚠️ Inspector stopped: Navigated to different site',
    'window_switch': '⚠️ Inspector stopped: Switched to different window'
  };
  banner.textContent = messages[reason] || 'Inspector stopped';
  banner.classList.add('visible');

  // 5 saniye sonra gizle
  setTimeout(() => {
    banner.classList.remove('visible');
  }, 5000);

  debugLog(`Auto-stop banner shown: ${reason}`);
}

// Format timestamp
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// XSS koruması - HTML special karakterlerini escape et
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// UI helper - pulsing status text (Detecting / Waiting / Pending / Loading)
function renderStatusPulse(text, tooltip) {
  const safeText = escapeHtml(text);
  if (tooltip) {
    return `<span class="has-tooltip status-pulse" data-tooltip="${escapeHtml(tooltip)}">${safeText}</span>`;
  }
  return `<span class="status-pulse">${safeText}</span>`;
}

// Format encoder type for display (e.g., "opus-wasm" → "Opus (WASM)")
function formatEncoderDisplay(encoder) {
  if (!encoder) return 'Unknown';
  const lower = String(encoder).toLowerCase();

  // Generic WASM encoder types
  const detectedEncoders = {
    'opus-wasm': 'Opus (WASM)',
    'mp3-wasm': 'MP3 (WASM)',
    'aac-wasm': 'AAC (WASM)',
    'vorbis-wasm': 'Vorbis (WASM)',
    'flac-wasm': 'FLAC (WASM)',
    'pcm': 'Linear PCM'
  };

  if (detectedEncoders[lower]) {
    return detectedEncoders[lower];
  }

  // Legacy fallback - old format still in storage
  const legacyEncoders = {
    'opus-recorder': 'Opus (WASM)',
    'lamejs': 'MP3 (WASM)',
    'fdk-aac.js': 'AAC (WASM)',
    'vorbis.js': 'Vorbis (WASM)',
    'libflac.js': 'FLAC (WASM)',
    'linear-pcm': 'Linear PCM'
  };

  if (legacyEncoders[lower]) {
    return legacyEncoders[lower];
  }

  // Return as-is if not recognized
  return encoder;
}

// Detect encoder input technology from pipeline processors
// Priority: Worklet > ScriptProcessor > WebAudio > MediaStream
// Returns the "technology" that processes audio before encoding
function detectEncoderInputTechnology(processors) {
  if (!processors || processors.length === 0) return null;

  // Filter out analysers (monitors don't process audio for encoding)
  const mainChain = processors.filter(p => p.type !== 'analyser');
  if (mainChain.length === 0) return null;

  // Look for Worklet (highest priority - modern audio processing)
  const worklet = mainChain.find(p => {
    const type = (p.type || '').toLowerCase();
    return type === 'audioworkletnode' || type === 'audioworklet';
  });
  if (worklet) {
    const name = worklet.name || worklet.processorName;
    return name ? `Worklet (${name})` : 'Worklet';
  }

  // Look for ScriptProcessor (legacy audio processing)
  const scriptProc = mainChain.find(p => {
    const type = (p.type || '').toLowerCase();
    return type === 'scriptprocessor' || type === 'scriptprocessornode';
  });
  if (scriptProc) {
    return 'ScriptProcessor';
  }

  // Look for any WebAudio processing nodes (not sources)
  const webAudioNodes = mainChain.filter(p => {
    const type = (p.type || '').toLowerCase();
    // Exclude source nodes - we want processing nodes
    return !type.includes('source') && !type.includes('element');
  });

  if (webAudioNodes.length > 0) {
    // Return the last WebAudio node in the chain
    const lastNode = webAudioNodes[webAudioNodes.length - 1];
    const nodeType = formatWebAudioNodeType(lastNode.type);
    return `WebAudio (${nodeType})`;
  }

  // Only source nodes - direct stream
  const sourceNode = mainChain.find(p => {
    const type = (p.type || '').toLowerCase();
    return type.includes('source');
  });
  if (sourceNode) {
    return 'MediaStream (direct)';
  }

  return null;
}

// Format WebAudio node type to readable name
function formatWebAudioNodeType(type) {
  if (!type) return 'Unknown';
  const t = type.toLowerCase();

  const nodeNames = {
    'gain': 'Gain',
    'gainnode': 'Gain',
    'biquadfilter': 'Filter',
    'biquadfilternode': 'Filter',
    'dynamicscompressor': 'Compressor',
    'dynamicscompressornode': 'Compressor',
    'convolver': 'Convolver',
    'convolvernode': 'Convolver',
    'waveshaper': 'WaveShaper',
    'waveshapernode': 'WaveShaper',
    'panner': 'Panner',
    'pannernode': 'Panner',
    'stereopanner': 'Panner',
    'stereopannernode': 'Panner',
    'delay': 'Delay',
    'delaynode': 'Delay',
    'iirfilter': 'IIRFilter',
    'iirfilternode': 'IIRFilter'
  };

  return nodeNames[t] || type;
}

// Format jitter (seconds to ms)
function formatJitter(jitterSec) {
  if (!jitterSec) return 'N/A';
  return `${(jitterSec * 1000).toFixed(2)} ms`;
}

// Color code values
function getQualityClass(metric, value) {
  if (metric === 'jitter') {
    if (value < 0.03) return 'good';     // < 30ms
    if (value < 0.1) return 'warning';   // < 100ms
    return 'error';
  }
  if (metric === 'packetLoss') {
    if (value < 1) return 'good';        // < 1%
    if (value < 5) return 'warning';     // < 5%
    return 'error';
  }
  if (metric === 'rtt') {
    if (value < 0.15) return 'good';     // < 150ms
    if (value < 0.3) return 'warning';   // < 300ms
    return 'error';
  }
  return '';
}

// Render WebRTC stats (fixed two-column layout)
function renderRTCStats(data) {
  const container = document.getElementById('rtcContent');
  const timestamp = document.getElementById('rtcTimestamp');

  // Find active connection with send or recv
  let pc = null;
  let connCount = 0;

  if (data?.peerConnections?.length > 0) {
    connCount = data.peerConnections.length;
    pc = data.peerConnections.find(c => c.send && c.recv)
      || data.peerConnections.find(c => c.send || c.recv)
      || data.peerConnections[0];
  }

  const connInfo = connCount > 0 ? ` (${connCount})` : '';

  let sendHtml = `<div class="rtc-column">
    <div class="rtc-column-header">
      <span class="direction-icon send">TX</span>
      Outgoing${connInfo}
    </div>`;

  let recvHtml = `<div class="rtc-column">
    <div class="rtc-column-header">
      <span class="direction-icon recv">RX</span>
      Incoming
    </div>`;

  if (!pc) {
    sendHtml += `<table><tbody>
      <tr><td>Codec</td><td>-</td></tr>
      <tr><td>Bitrate</td><td>-</td></tr>
      <tr><td>Mode</td><td>-</td></tr>
      <tr><td>RTT</td><td>-</td></tr>
    </tbody></table></div>`;

    recvHtml += `<table><tbody>
      <tr><td>Codec</td><td>-</td></tr>
      <tr><td>Bitrate</td><td>-</td></tr>
      <tr><td>Jitter</td><td>-</td></tr>
      <tr><td>Loss</td><td>-</td></tr>
    </tbody></table></div>`;

    container.innerHTML = sendHtml + recvHtml;
    timestamp.textContent = '';
    return;
  }

  timestamp.textContent = formatTime(data.timestamp);

  const rttText = pc.rtt !== null ? `${(pc.rtt * 1000).toFixed(0)} ms` : '-';
  const rttClass = pc.rtt !== null ? getQualityClass('rtt', pc.rtt) : '';

  // Send column
  sendHtml += `<table><tbody>`;
  if (pc.send) {
    const codec = pc.send.codec?.split('/')[1] || '-';
    const bitrate = pc.send.bitrateKbps !== null ? `${pc.send.bitrateKbps} kbps` : '-';
    const mode = pc.send.opusParams ? (pc.send.opusParams.cbr === 1 ? 'CBR' : 'VBR') : '-';
    const fec = pc.send.opusParams?.useinbandfec === 1 ? '+FEC' : '';

    sendHtml += `<tr><td>Codec</td><td class="metric-value">${codec}</td></tr>`;
    sendHtml += `<tr><td>Bitrate</td><td class="metric-value">${bitrate}</td></tr>`;
    sendHtml += `<tr><td>Mode</td><td>${mode} ${fec}</td></tr>`;
  } else {
    sendHtml += `<tr><td>Codec</td><td>-</td></tr>`;
    sendHtml += `<tr><td>Bitrate</td><td>-</td></tr>`;
    sendHtml += `<tr><td>Mode</td><td>-</td></tr>`;
  }
  sendHtml += `<tr><td>RTT</td><td class="${rttClass}">${rttText}</td></tr>`;
  sendHtml += `</tbody></table></div>`;

  // Recv column
  recvHtml += `<table><tbody>`;
  if (pc.recv) {
    const codec = pc.recv.codec?.split('/')[1] || '-';
    const bitrate = pc.recv.bitrateKbps !== null ? `${pc.recv.bitrateKbps} kbps` : '-';
    const jitter = formatJitter(pc.recv.jitter);
    const jitterClass = getQualityClass('jitter', pc.recv.jitter);
    const plr = pc.recv.packetsReceived > 0 ? ((pc.recv.packetsLost / (pc.recv.packetsReceived + pc.recv.packetsLost)) * 100) : 0;
    const plrClass = getQualityClass('packetLoss', plr);

    recvHtml += `<tr><td>Codec</td><td class="metric-value">${codec}</td></tr>`;
    recvHtml += `<tr><td>Bitrate</td><td class="metric-value">${bitrate}</td></tr>`;
    recvHtml += `<tr><td>Jitter</td><td class="${jitterClass}">${jitter}</td></tr>`;
    recvHtml += `<tr><td>Loss</td><td class="${plrClass}">${plr.toFixed(1)}%</td></tr>`;
  } else {
    recvHtml += `<tr><td>Codec</td><td>-</td></tr>`;
    recvHtml += `<tr><td>Bitrate</td><td>-</td></tr>`;
    recvHtml += `<tr><td>Jitter</td><td>-</td></tr>`;
    recvHtml += `<tr><td>Loss</td><td>-</td></tr>`;
  }
  recvHtml += `</tbody></table></div>`;

  container.innerHTML = sendHtml + recvHtml;
}

// DSP field configuration (OCP: add new DSP types without modifying loop)
const DSP_FIELDS = [
  { key: 'echoCancellation', label: 'Echo Cancel' },
  { key: 'autoGainControl', label: 'Auto Gain' },
  { key: 'noiseSuppression', label: 'Noise Supp' },
  { key: 'voiceIsolation', label: 'Voice Isolation' }
];

// Render getUserMedia stats (fixed layout)
function renderGUMStats(data) {
  const container = document.getElementById('gumContent');
  const timestamp = document.getElementById('gumTimestamp');

  let html = `<table><tbody>`;

  if (!data || !data.settings) {
    html += `<tr><td>Rate</td><td>-</td></tr>`;
    html += `<tr><td>Channels</td><td>-</td></tr>`;
    html += `<tr><td>Bit Depth</td><td>-</td></tr>`;
    html += `<tr><td>In Latency</td><td>-</td></tr>`;
    // OCP: DSP placeholder satırları DSP_FIELDS'den üretiliyor
    DSP_FIELDS.forEach(field => {
      html += `<tr><td>${field.label}</td><td>-</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
    timestamp.textContent = '';
    return;
  }

  timestamp.textContent = formatTime(data.timestamp);
  const s = data.settings;

  html += `<tr><td>Rate</td><td class="metric-value">${s.sampleRate || '-'} Hz</td></tr>`;
  html += `<tr><td>Channels</td><td>${s.channelCount || '?'}ch</td></tr>`;
  html += `<tr><td>Bit Depth</td><td>${s.sampleSize || '?'}bit</td></tr>`;

  // Input Latency (mikrofon giriş gecikmesi - AudioContext output latency'den farklı)
  const inLatency = s.latency ? `${(s.latency * 1000).toFixed(1)} ms` : '-';
  html += `<tr><td>In Latency</td><td>${inLatency}</td></tr>`;

  // DSP satırları (her özellik ayrı satırda)
  DSP_FIELDS.forEach(field => {
    const value = s[field.key];
    const display = value ? '✓' : '-';
    const cls = value ? 'good' : '';
    html += `<tr><td>${field.label}</td><td class="${cls}">${display}</td></tr>`;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}


// Determine AudioContext purpose based on evidence-based model
// IMPORTANT: We do NOT show "Recording" label here - that's misleading
// Recording status is shown ONLY in MediaRecorder section where we have real evidence
// AudioContext can only show what it's configured for, not what's actually happening
// Note: WASM encoder is shown as independent signal, not attached to context
// Tooltip explains the detection is point-in-time, not guaranteed current
function getContextPurpose(ctx) {
  // 1. Mikrofon bağlı - GİDEN SES (outgoing audio)
  if (ctx.pipeline?.inputSource === 'microphone') {
    return {
      icon: '🎤',
      label: 'Mic Input',
      tooltip: 'Microphone stream detected - outgoing audio'
    };
  }

  // 2. Remote audio bağlı - GELEN SES (incoming audio) - filtrelenecek
  if (ctx.pipeline?.inputSource === 'remote') {
    return {
      icon: '📥',
      label: 'Remote Input',
      tooltip: 'Remote stream detected - incoming audio from peer'
    };
  }

  // 3. MediaStreamDestination = audio routed to stream - GİDEN SES
  if (ctx.pipeline?.destinationType === DESTINATION_TYPES.MEDIA_STREAM) {
    return {
      icon: '📤',
      label: 'Stream Output',
      tooltip: 'MediaStreamDestination created - audio routed to stream'
    };
  }

  // 4. AnalyserNode = VU Meter / visualizer - belirsiz, filtrelenecek
  if (ctx.pipeline?.processors?.some(p => p.type === 'analyser')) {
    return {
      icon: '📊',
      label: 'VU Meter',
      tooltip: 'AnalyserNode detected - audio visualization'
    };
  }

  // 5. Default → Page Audio (no microphone capture)
  return { icon: '🎵', label: 'Page Audio', tooltip: 'VU meter, audio effects, playback analysis etc.' };
}

/**
 * Filter AudioContext'leri - giden ses + aktif/yeni context'leri döndür
 * Giden ses: Mic Input + Stream Output → her zaman göster
 * Diğerleri (VU Meter, Other): sadece running state veya son 5 saniyede oluşturulmuş ise göster
 *
 * Öncelik: Mic Input > Stream Output > diğerleri
 * Eğer Mic Input varsa, sadece Mic Input context'lerini göster (Stream Output genellikle hazırlık)
 */
function filterOutgoingContexts(contexts) {
  const now = Date.now();
  const RECENT_THRESHOLD_MS = 5000; // 5 saniye

  const getContextTimestamp = (ctx) => ctx.pipeline?.timestamp || ctx.static?.timestamp || 0;

  // ═══ DEBUG: Initial contexts ═══
  console.log(`[AudioInspector] 🔍 filterOutgoingContexts: input has ${contexts.length} context(s)`);
  contexts.forEach((ctx, i) => {
    const purpose = getContextPurpose(ctx);
    console.log(`[AudioInspector] 🔍 Input Context[${i}]: ${ctx.contextId} - purpose="${purpose.label}", inputSource=${ctx.pipeline?.inputSource}, state=${ctx.static?.state}`);
  });

  // İlk geçiş: tüm potansiyel context'leri topla
  const candidates = contexts.filter(ctx => {
    const purpose = getContextPurpose(ctx);

    // Outgoing audio - her zaman aday
    if (purpose.label === 'Mic Input' || purpose.label === 'Stream Output') {
      return true;
    }

    // Page Audio/VU Meter - sadece running veya yeni ise aday
    const isRunning = ctx.static?.state === 'running';
    const isRecent = (now - (ctx.static?.timestamp || 0)) < RECENT_THRESHOLD_MS;

    return isRunning || isRecent;
  });

  console.log(`[AudioInspector] 🔍 filterOutgoingContexts: ${candidates.length} candidate(s) after first pass`);

  // Mic Input varsa, sadece Mic Input context'lerini döndür
  // Bu, "hazırlık" context'lerini (sadece destination) gizler
  const micInputContexts = candidates.filter(ctx =>
    getContextPurpose(ctx).label === 'Mic Input'
  );

  console.log(`[AudioInspector] 🔍 filterOutgoingContexts: ${micInputContexts.length} Mic Input context(s) found`);

  if (micInputContexts.length > 0) {
    const sortedMicInputs = [...micInputContexts].sort(
      (a, b) => getContextTimestamp(b) - getContextTimestamp(a)
    );
    console.log(`[AudioInspector] 🔍 filterOutgoingContexts: returning NEWEST Mic Input context: ${sortedMicInputs[0].contextId}`);
    return [sortedMicInputs[0]];
  }

  // Mic Input yoksa tüm adayları döndür
  console.log(`[AudioInspector] 🔍 filterOutgoingContexts: no Mic Input, returning all ${candidates.length} candidate(s)`);
  return candidates;
}

function filterConnectionsByContext(connections, contexts) {
  if (!connections || connections.length === 0) return [];
  if (!contexts || contexts.length === 0) return connections;

  const contextIds = new Set(
    contexts.map(ctx => ctx.contextId).filter(Boolean)
  );
  if (contextIds.size === 0) return connections;

  const hasContextIds = connections.some(conn => conn.contextId);
  if (!hasContextIds) return connections;

  return connections.filter(conn => contextIds.has(conn.contextId));
}

function mapNodeTypeToProcessorType(nodeType) {
  if (!nodeType || typeof nodeType !== 'string') return null;
  switch (nodeType) {
    case 'AudioWorklet': return 'audioWorkletNode';
    case 'ScriptProcessor': return 'scriptProcessor';
    case 'Analyser': return 'analyser';
    case 'Gain': return 'gain';
    case 'BiquadFilter': return 'biquadFilter';
    case 'DynamicsCompressor': return 'dynamicsCompressor';
    case 'Oscillator': return 'oscillator';
    case 'Delay': return 'delay';
    case 'Convolver': return 'convolver';
    case 'WaveShaper': return 'waveShaper';
    case 'Panner': return 'panner';
    default:
      // Best-effort: "FooBar" → "fooBar"
      return nodeType.charAt(0).toLowerCase() + nodeType.slice(1);
  }
}

function isDestinationNodeType(nodeType) {
  if (!nodeType || typeof nodeType !== 'string') return false;
  return nodeType === 'AudioDestination' ||
    nodeType === 'MediaStreamAudioDestination' ||
    nodeType === 'MediaStreamDestination';
}

/**
 * Derive the main Audio Path chain from the connection graph.
 * This avoids "stacking" old processors across multiple recordings by rendering
 * only currently-connected nodes (connections are pruned on disconnect()).
 *
 * Falls back to pipeline processors if graph path cannot be resolved.
 *
 * @param {Array} connections
 * @param {Object} ctx
 * @returns {Array}
 */
function deriveMainChainProcessorsFromConnections(connections, ctx) {
  if (!connections || connections.length === 0) return [];

  // nodeId → pipeline processor (has processorName/options for worklets)
  const pipelineByNodeId = new Map();
  const pipelineProcessors = ctx?.pipeline?.processors || [];
  for (const p of pipelineProcessors) {
    if (p?.nodeId) {
      pipelineByNodeId.set(p.nodeId, p);
    }
  }

  // nodeId → human-readable node type (from connect() hook)
  const nodeTypeById = new Map();
  const edges = new Map(); // sourceId → destId[]

  for (const c of connections) {
    if (!c?.sourceId || !c?.destId) continue;
    if (typeof c.destType === 'string' && c.destType.startsWith('AudioParam(')) continue;

    if (c.sourceType) nodeTypeById.set(c.sourceId, c.sourceType);
    if (c.destType) nodeTypeById.set(c.destId, c.destType);

    const list = edges.get(c.sourceId) || [];
    list.push(c.destId);
    edges.set(c.sourceId, list);
  }

  const startIds = connections
    .filter(c => c?.sourceType === 'MediaStreamAudioSource' && c?.sourceId)
    .map(c => c.sourceId);

  const destIds = new Set(
    connections
      .filter(c => isDestinationNodeType(c?.destType) && c?.destId)
      .map(c => c.destId)
  );

  const findPath = (startId) => {
    const queue = [startId];
    const prev = new Map();
    prev.set(startId, null);

    while (queue.length > 0) {
      const cur = queue.shift();
      if (destIds.has(cur)) {
        // Reconstruct path
        const path = [];
        let n = cur;
        while (n) {
          path.push(n);
          n = prev.get(n);
        }
        path.reverse();
        return path;
      }

      const neighbors = edges.get(cur) || [];
      for (const next of neighbors) {
        if (!next || prev.has(next)) continue;
        prev.set(next, cur);
        queue.push(next);
      }
    }
    return null;
  };

  let bestPath = null;
  for (const startId of startIds) {
    const path = findPath(startId);
    if (!path) continue;
    if (!bestPath || path.length < bestPath.length) {
      bestPath = path;
    }
  }

  if (!bestPath || bestPath.length < 2) return [];

  const processors = [];
  for (const nodeId of bestPath) {
    const nodeType = nodeTypeById.get(nodeId);
    if (nodeType === 'MediaStreamAudioSource') continue;
    if (isDestinationNodeType(nodeType)) continue;

    const fromPipeline = pipelineByNodeId.get(nodeId);
    if (fromPipeline) {
      if (fromPipeline.type !== 'analyser') {
        processors.push(fromPipeline);
      }
      continue;
    }

    const mappedType = mapNodeTypeToProcessorType(nodeType);
    if (!mappedType || mappedType === 'analyser') continue;

    const entry = { type: mappedType, nodeId, timestamp: Date.now() };
    if (mappedType === 'audioWorkletNode') {
      entry.processorName = '?';
    }
    processors.push(entry);
  }

  return processors;
}

/**
 * Get processor key for grouping - same key = same type
 * Used to group consecutive identical processors
 */
function getProcessorKey(proc) {
  switch (proc.type) {
    case 'gain': return 'gain';
    case 'biquadFilter': return 'biquadFilter'; // Tüm filtreler gruplanır
    case 'dynamicsCompressor': return 'compressor';
    case 'oscillator': return 'oscillator'; // Tüm osilatörler gruplanır
    case 'delay': return 'delay'; // Tüm delay'ler gruplanır
    case 'audioWorkletNode': return `worklet-${proc.processorName || '?'}`;
    case 'scriptProcessor': return 'scriptProcessor';
    case 'audioWorklet': return `audioWorklet-${proc.moduleUrl || '?'}`;
    case 'analyser': return 'analyser';
    default: return proc.type;
  }
}

/**
 * Group consecutive identical processors
 * Example: [Gain, Gain, Filter, Gain] → [Gain(x2), Filter, Gain(x1)]
 * Note: Only consecutive, not total count
 */
function groupConsecutiveProcessors(processors) {
  if (!processors || processors.length === 0) return [];

  const grouped = [];
  for (const proc of processors) {
    const key = getProcessorKey(proc);
    const last = grouped[grouped.length - 1];

    if (last && last.key === key) {
      last.count++;
    } else {
      grouped.push({ ...proc, key, count: 1 });
    }
  }
  return grouped;
}

/**
 * MediaStreamSource tekrarlarını (aynı zincirde ardışık ya da tekrarlı) tek girdiye indirger
 * Görselde "mediaStreamSource(x3)" yerine tek kaynak gösterir.
 */
function dedupeMediaStreamSources(processors) {
  if (!processors || processors.length === 0) return [];

  let seen = false;
  return processors.filter(proc => {
    if (proc.type !== 'mediaStreamSource') return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

/**
 * Format a single processor for display (Option B - with parameters)
 * Includes count suffix if > 1
 * Returns object with { name, params, tooltip } for flexible rendering
 */
function formatProcessor(proc) {
  const suffix = proc.count > 1 ? `(x${proc.count})` : '';
  let name = '';
  let params = '';  // Short parameter display
  let tooltip = ''; // Full details on hover

  switch (proc.type) {
    case 'scriptProcessor':
      name = `ScriptProcessor${suffix}`;
      // bufferSize artık ayrı satırda gösteriliyor (renderACStats'ta)
      params = '';
      tooltip = `Input: ${proc.inputChannels || '?'}ch, Output: ${proc.outputChannels || '?'}ch`;
      break;
    case 'audioWorklet':
      name = `AudioWorklet${suffix}`;
      break;
    case 'audioWorkletNode':
      // Encoder worklet'ler için sadece "AudioWorklet ✓" göster
      // Processor detayı zaten ENCODING bölümünde görünüyor
      const nameLC = (proc.processorName || '').toLowerCase();
      const isEncoderWorklet = ['encoder', 'opus', 'ogg', 'voice-processor', 'audio-encoder'].some(
        keyword => nameLC.includes(keyword)
      );
      if (isEncoderWorklet) {
        name = `AudioWorklet ✓${suffix}`;
        tooltip = `Encoder: ${proc.processorName}`;
      } else {
        name = `Worklet${suffix}`;
        params = proc.processorName || '?';
        tooltip = formatWorkletOptions(proc.processorName, proc.options);
      }
      break;
    case 'gain':
      name = `Gain${suffix}`;
      // GainNode.gain.value şu an capture edilmiyor (runtime'da değişebilir)
      break;
    case 'biquadFilter':
      name = `Filter${suffix}`;
      params = proc.filterType || 'lowpass';
      break;
    case 'dynamicsCompressor':
      name = `Compressor${suffix}`;
      break;
    case 'oscillator':
      name = `Osc${suffix}`;
      params = proc.oscillatorType || 'sine';
      break;
    case 'delay':
      name = `Delay${suffix}`;
      params = `${proc.maxDelayTime || '?'}s`;
      break;
    case 'convolver':
      name = `Convolver${suffix}`;
      break;
    case 'waveShaper':
      name = `WaveShaper${suffix}`;
      params = proc.oversample !== 'none' ? proc.oversample : '';
      break;
    case 'panner':
      name = `Panner${suffix}`;
      params = proc.panningModel || 'equalpower';
      break;
    case 'analyser':
      name = `Analyser${suffix}`;
      break;
    default:
      name = `${proc.type}${suffix}`;
  }

  return { name, params, tooltip };
}

/**
 * Render chain as vertical format (one processor per line)
 * Example:
 *   Gain(x3)
 *   ↓
 *   Convolver
 *   ↓
 *   Filter(lowpass)
 * @param {Array} groupedProcessors - Grouped processors from groupConsecutiveProcessors
 * @returns {string} HTML string
 */
function renderChain(groupedProcessors) {
  if (!groupedProcessors || groupedProcessors.length === 0) {
    return '<span class="detail-value">-</span>';
  }

  const nodes = groupedProcessors.map(formatProcessor);

  // Vertical format: each processor on its own line with arrow separator
  let html = '<div class="chain-vertical chain-pipeline">';
  nodes.forEach((node, i) => {
    let text = node.name;
    if (node.params) {
      text += `(${node.params})`;
    }

    html += '<div class="chain-node">';
    if (node.tooltip) {
      html += `<span class="chain-node-name has-tooltip" data-tooltip="${escapeHtml(node.tooltip)}">${text}</span>`;
    } else {
      html += `<span class="chain-node-name">${text}</span>`;
    }
    html += '</div>';

    // Add arrow between nodes (not after last)
    if (i < nodes.length - 1) {
      html += '<span class="chain-arrow">↓</span>';
    }
  });
  html += '</div>';

  return html;
}

/**
 * Format AudioWorkletNode options for tooltip display
 * @param {string} processorName
 * @param {Object} options
 * @returns {string}
 */
function formatWorkletOptions(processorName, options) {
  if (!options) return processorName || 'AudioWorklet';

  const parts = [];

  // numberOfInputs/Outputs
  if (options.numberOfInputs !== undefined) parts.push(`inputs: ${options.numberOfInputs}`);
  if (options.numberOfOutputs !== undefined) parts.push(`outputs: ${options.numberOfOutputs}`);

  // outputChannelCount
  if (options.outputChannelCount) {
    parts.push(`outCh: [${options.outputChannelCount.join(',')}]`);
  }

  // processorOptions - önemli parametreleri çıkar
  if (options.processorOptions) {
    const po = options.processorOptions;
    if (po.sampleRate) parts.push(`rate: ${po.sampleRate}`);
    if (po.channels) parts.push(`ch: ${po.channels}`);
    if (po.bitRate) parts.push(`bitrate: ${(po.bitRate / 1000).toFixed(0)}k`);
    if (po.frameSize) parts.push(`frame: ${po.frameSize}`);
    if (po.complexity !== undefined) parts.push(`complexity: ${po.complexity}`);
  }

  return parts.length > 0 ? parts.join(', ') : processorName || 'AudioWorklet';
}


// Render AudioContext stats - supports multiple contexts
// Design: Option B - Context Info + Audio Path + Monitor (separated)
function renderACStats(contexts, audioConnections = null) {
  const container = document.getElementById('acContent');
  const timestamp = document.getElementById('acTimestamp');

  // Handle both array and single object (backwards compat)
  if (!contexts || (Array.isArray(contexts) && contexts.length === 0)) {
    // Even without contexts, show connections if available
    if (audioConnections?.connections?.length > 0) {
      container.innerHTML = renderConnectionGraph(audioConnections.connections);
      timestamp.textContent = formatTime(audioConnections.lastUpdate);
      return;
    }
    container.innerHTML = '<div class="no-data">No context</div>';
    timestamp.textContent = '';
    return;
  }

  // Convert to array if single object
  let contextArray = Array.isArray(contexts) ? contexts : [contexts];

  // Sadece giden ses context'lerini göster (Mic Input, Stream Output)
  contextArray = filterOutgoingContexts(contextArray);

  // Filtreden sonra boş kaldıysa "No outgoing audio" göster
  if (contextArray.length === 0) {
    container.innerHTML = '<div class="no-data">No outgoing audio</div>';
    timestamp.textContent = '';
    return;
  }

  // Limit to MAX_AUDIO_CONTEXTS
  if (contextArray.length > MAX_AUDIO_CONTEXTS) {
    contextArray = contextArray.slice(0, MAX_AUDIO_CONTEXTS);
  }

  // Header timestamp = Context creation time (like other sections)
  const firstCtx = contextArray[0];
  timestamp.textContent = formatTime(firstCtx.static?.timestamp);

  let html = '';

  // ═══ DEBUG: Context Rendering ═══
  console.log(`[AudioInspector] 🔍 renderACStats: rendering ${contextArray.length} context(s)`);
  contextArray.forEach((ctx, index) => {
    console.log(`[AudioInspector] 🔍 Context[${index}]:`, {
      contextId: ctx.contextId,
      inputSource: ctx.pipeline?.inputSource,
      hasMediaStreamSource: ctx.pipeline?.processors?.some(p => p.type === 'mediaStreamSource'),
      processorCount: ctx.pipeline?.processors?.length,
      state: ctx.static?.state
    });

    const purpose = getContextPurpose(ctx);
    console.log(`[AudioInspector] 🔍 Context[${index}] purpose: ${purpose.label} (${purpose.icon})`);

    // Page Audio context → minimal görünüm (mikrofon yok mesajı ile)
    if (purpose.label === 'Page Audio') {
      html += `<div class="context-item context-minimal${index > 0 ? ' context-separator' : ''}">
        <span class="context-purpose">${purpose.icon} ${purpose.label}</span>
        <span class="has-tooltip has-tooltip--info" data-tooltip="${purpose.tooltip}">ⓘ</span>
        <span class="context-subtext">Site audio processing (VU meter, effects, etc.)</span>
      </div>`;
      return; // Skip detailed rendering
    }

    // Latency calculation: baseLatency (processing) + outputLatency (buffer/hardware)
    // baseLatency: inherent latency of AudioContext processing (~10ms typically)
    // outputLatency: additional output buffer latency (~32-42ms typically)
    const baseLatency = ctx.static?.baseLatency || 0;
    const outputLatency = ctx.static?.outputLatency || 0;
    const totalLatency = baseLatency + outputLatency;
    const latencyMs = totalLatency > 0 ? `${(totalLatency * 1000).toFixed(1)}ms` : '-';
    const stateClass = ctx.static?.state === 'running' ? 'good' : (ctx.static?.state === 'suspended' ? 'warning' : '');

    // Context header with purpose (tooltip if available)
    html += `<div class="context-item${index > 0 ? ' context-separator' : ''}">`;
    if (purpose.tooltip) {
      html += `<div class="context-purpose">${purpose.icon} ${purpose.label} <span class="has-tooltip has-tooltip--info" data-tooltip="${purpose.tooltip}">ⓘ</span></div>`;
    } else {
      html += `<div class="context-purpose">${purpose.icon} ${purpose.label}</div>`;
    }

    // ━━━ Context Info ━━━ (static properties - no separate timestamp, uses header)
    // Note: channelCount = destination.maxChannelCount (output capacity)
    const channelTooltip = 'Output channel capacity (destination.maxChannelCount)';
    const latencyTooltip = `Total output latency (baseLatency: ${(baseLatency * 1000).toFixed(1)}ms + outputLatency: ${(outputLatency * 1000).toFixed(1)}ms). Input latency is shown in getUserMedia section.`;

    html += `
      <div class="ac-section">
        <div class="ac-section-header">
          <span class="ac-section-title">Context Info</span>
        </div>
        <table class="ac-main-table">
          <tbody>
            <tr><td><span class="has-tooltip" data-tooltip="${channelTooltip}">Channels</span></td><td class="metric-value">${ctx.static?.channelCount || '-'}</td></tr>
            <tr><td>State</td><td class="${stateClass}">${ctx.static?.state || '-'}</td></tr>
            <tr><td><span class="has-tooltip" data-tooltip="${latencyTooltip}">Latency</span></td><td>${latencyMs}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    // ━━━ Audio Path ━━━ (Input → Chain → Output)
    const hasInputSource = !!ctx.pipeline?.inputSource;
    const hasOutput = !!ctx.pipeline?.destinationType;

    // Filter processors: separate main chain from monitors
    const ctxConnections = filterConnectionsByContext(audioConnections?.connections, [ctx]);
    console.log(`[AudioInspector] 🔍 Audio Path: ctxConnections.length=${ctxConnections.length}`);
    const mainFromGraph = ctxConnections.length > 0
      ? deriveMainChainProcessorsFromConnections(ctxConnections, ctx)
      : [];
    console.log(`[AudioInspector] 🔍 Audio Path: mainFromGraph.length=${mainFromGraph.length}`);
    let mainProcessors = mainFromGraph.length > 0
      ? mainFromGraph
      : (ctx.pipeline?.processors?.filter(p => p.type !== 'analyser') || []);
    console.log(`[AudioInspector] 🔍 Audio Path: mainProcessors (before fallback)=`, mainProcessors);

    // FALLBACK: If inputSource exists, ensure MediaStreamSource is in the chain
    // When connections are missing, ctx.pipeline.processors doesn't include mediaStreamSource
    // because it's tracked separately via inputSource field
    if (hasInputSource && !mainProcessors.some(p => p.type === 'mediaStreamSource')) {
      // Prepend mediaStreamSource to chain (it's always first)
      mainProcessors = [
        { type: 'mediaStreamSource', timestamp: ctx.pipeline?.timestamp },
        ...mainProcessors
      ];
      console.log(`[AudioInspector] 🔍 Audio Path: FALLBACK applied! Added mediaStreamSource to chain`);
    }

    // UI cleanliness: Show a single MediaStreamSource even if multiple captures were synced
    mainProcessors = dedupeMediaStreamSources(mainProcessors);
    console.log(`[AudioInspector] 🔍 Audio Path: FINAL mainProcessors.length=${mainProcessors.length}`);

    const monitors = ctx.pipeline?.processors?.filter(p => p.type === 'analyser') || [];
    const hasMainProcessors = mainProcessors.length > 0;

    if (hasInputSource || hasMainProcessors || hasOutput) {
      const pipelineTs = formatTime(ctx.pipeline?.timestamp);

      html += `
        <div class="ac-section">
          <div class="ac-section-header">
            <span class="ac-section-title">Audio Path</span>
            <span class="ac-detected-time-subtle">(${pipelineTs})</span>
          </div>
          <table class="ac-main-table">
            <tbody>
      `;

      // Input
      if (hasInputSource) {
        html += `<tr><td>Input</td><td>${ctx.pipeline.inputSource}</td></tr>`;
      }

      // Chain (main processors - not monitors)
      if (hasMainProcessors) {
        const groupedProcessors = groupConsecutiveProcessors(mainProcessors);
        html += `<tr><td>Chain</td><td>${renderChain(groupedProcessors)}</td></tr>`;

        // Buffer Size - sadece ScriptProcessor varsa göster
        const scriptProc = mainProcessors.find(p => p.type === 'scriptProcessor');
        if (scriptProc?.bufferSize) {
          html += `<tr><td>Buffer Size</td><td>${scriptProc.bufferSize}</td></tr>`;
        }
      }

      // Output
      html += `<tr><td>Output</td><td>${ctx.pipeline?.destinationType || 'Speakers'}</td></tr>`;

      html += `</tbody></table></div>`;

      // Monitor (VU Analyser) - side-tap, not part of main audio path chain
      if (monitors.length > 0) {
        const monitorCount = monitors.length;
        const monitorLabel = monitorCount > 1 ? `VU Analyser ×${monitorCount}` : 'VU Analyser';
        html += `
          <div class="ac-section monitor-section">
            <div class="processing-item">
              <span class="detail-label">Monitor</span>
              <span class="detail-value detail-value-muted has-tooltip" data-tooltip="AnalyserNode is a monitoring tap (VU/visualizer). It does not change the main Input → Chain → Output path.">${escapeHtml(monitorLabel)}</span>
            </div>
          </div>`;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PCM PROCESSING HINT: Show raw audio processing (e.g., ScriptProcessor)
    // Indicates raw PCM data is being processed (not yet encoded)
    // Encoding detection is handled separately in Encoding section
    // ═══════════════════════════════════════════════════════════════════
    if (ctx.encodingHint) {
      html += `
        <div class="ac-section pcm-processing-section">
          <div class="processing-item">
            <span class="detail-label">⚠️ Processing</span>
            <span class="detail-value has-tooltip" data-tooltip="Raw audio data - not yet encoded">${escapeHtml(ctx.encodingHint.hint)}</span>
          </div>
        </div>`;
    }

    html += `</div>`;
  });

  // ━━━ Audio Connection Graph ━━━ (if connections available)
  console.log(`[AudioInspector] 🔍 renderACStats: audioConnections=`, audioConnections);
  console.log(`[AudioInspector] 🔍 renderACStats: audioConnections?.connections?.length=`, audioConnections?.connections?.length);
  const filteredConnections = filterConnectionsByContext(audioConnections?.connections, contextArray);
  console.log(`[AudioInspector] 🔍 renderACStats: filteredConnections.length=`, filteredConnections.length);
  if (filteredConnections.length > 0) {
    html += renderConnectionGraph(filteredConnections, contextArray);
  }

  console.log(`[AudioInspector] 🔍 renderACStats: HTML length=${html.length}, container=`, container);
  console.log(`[AudioInspector] 🔍 renderACStats: HTML preview (first 500 chars):`, html.substring(0, 500));
  container.innerHTML = html;
  console.log(`[AudioInspector] 🔍 renderACStats: DOM updated, container.children.length=`, container.children.length);
}

/**
 * Render audio connection graph as a visual chain
 * Shows how AudioNodes are connected to each other
 * @param {Array} connections - Array of { sourceType, sourceId, destType, destId, ... }
 * @param {Array} [contexts] - Optional array of AudioContext data for enhanced AudioWorklet detection
 * @returns {string} HTML string
 */
function renderConnectionGraph(connections, contexts = []) {
  if (!connections || connections.length === 0) {
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USER-FRIENDLY SUMMARY: Show source, effects, and output in simple format
  // Instead of technical node connections, show what the user cares about
  // ═══════════════════════════════════════════════════════════════════════════

  // Helper: Check if an AudioWorkletNode processor name looks like VU meter
  const isVUMeterProcessor = (name) => {
    if (!name) return false;
    const lower = name.toLowerCase();
    return lower.includes('peak') || lower.includes('level') || lower.includes('meter') || lower.includes('vu');
  };

  // Get AudioWorkletNode processor names from contexts for VU meter detection
  const audioWorkletProcessorNames = [];
  for (const ctx of contexts) {
    const processors = ctx.pipeline?.processors || [];
    for (const p of processors) {
      if (p.type === 'audioWorkletNode' && p.processorName) {
        audioWorkletProcessorNames.push(p.processorName);
      }
    }
  }

  // Check if any AudioWorkletNode is a VU meter
  const hasVUMeter = audioWorkletProcessorNames.some(name => isVUMeterProcessor(name));

  // Collect unique node types
  const nodeTypes = new Set();
  for (const conn of connections) {
    nodeTypes.add(conn.sourceType);
    nodeTypes.add(conn.destType);
  }

  // Categorize nodes
  const sources = [];
  const effects = [];
  const outputs = [];

  // Node type mappings for user-friendly names
  const nodeLabels = {
    // Sources
    'MediaStreamAudioSource': { label: 'Microphone', category: 'source', icon: '🎤' },
    'MediaStreamSource': { label: 'Microphone', category: 'source', icon: '🎤' },
    'OscillatorNode': { label: 'Oscillator', category: 'source', icon: '〰️' },
    'Oscillator': { label: 'Oscillator', category: 'source', icon: '〰️' },
    'BufferSource': { label: 'Audio Buffer', category: 'source', icon: '📁' },
    // Effects
    'Gain': { label: 'Volume', category: 'effect', icon: '🔊' },
    'BiquadFilter': { label: 'EQ', category: 'effect', icon: '🎚️' },
    'Convolver': { label: 'Reverb', category: 'effect', icon: '🏛️' },
    'Delay': { label: 'Delay', category: 'effect', icon: '⏱️' },
    'DynamicsCompressor': { label: 'Compressor', category: 'effect', icon: '📊' },
    'WaveShaper': { label: 'Distortion', category: 'effect', icon: '⚡' },
    'Analyser': { label: 'Analyser', category: 'effect', icon: '📈' },
    'StereoPanner': { label: 'Panner', category: 'effect', icon: '↔️' },
    // Processors
    'AudioWorklet': { label: 'Processor', category: 'effect', icon: '⚙️' },
    'ScriptProcessor': { label: 'Processor', category: 'effect', icon: '⚙️' },
    // Outputs
    'AudioDestination': { label: 'Speaker', category: 'output', icon: '🔈' },
    'MediaStreamAudioDestination': { label: 'Stream', category: 'output', icon: '⏺️' },
    'MediaStreamDestination': { label: 'Stream', category: 'output', icon: '⏺️' }
  };

  // Categorize each unique node type
  for (const type of nodeTypes) {
    // Special handling: If AudioWorklet and we detected VU meter processor, use VU Meter label
    let info;
    if (type === 'AudioWorklet' && hasVUMeter) {
      info = { label: 'VU Meter', category: 'effect', icon: '📊' };
    } else {
      info = nodeLabels[type] || { label: type, category: 'effect', icon: '🔧' };
    }
    const item = { type, label: info.label, icon: info.icon };

    if (info.category === 'source' && !sources.some(s => s.label === info.label)) {
      sources.push(item);
    } else if (info.category === 'output' && !outputs.some(o => o.label === info.label)) {
      outputs.push(item);
    } else if (info.category === 'effect' && !effects.some(e => e.label === info.label)) {
      effects.push(item);
    }
  }

  // Detect feedback loops (Delay → Gain → Delay pattern)
  let hasFeedback = false;
  for (const conn of connections) {
    if (conn.sourceType === 'Delay' && conn.destType === 'Gain') {
      // Check if any Gain connects back to Delay
      const gainToDelay = connections.some(c =>
        c.sourceType === 'Gain' && c.destType === 'Delay'
      );
      if (gainToDelay) hasFeedback = true;
    }
  }

  // Build HTML - use same table structure as Audio Path for consistency
  let html = `
    <div class="ac-section">
      <div class="ac-section-header">
        <span class="ac-section-title">Audio Graph</span>
        <span class="ac-detected-time-subtle">(${connections.length})</span>
      </div>
      <table class="ac-main-table">
  `;

  // Source row
  if (sources.length > 0) {
    const sourceText = sources.map(s => s.label).join(', ');
    html += `<tr><td>Source</td><td>${sourceText}</td></tr>`;
  }

  // Effects row (only show meaningful effects, skip Gain if only used for routing)
  const meaningfulEffects = effects.filter(e =>
    e.label !== 'Volume' && e.label !== 'Processor' && e.label !== 'Analyser'
  );
  if (meaningfulEffects.length > 0) {
    const effectText = meaningfulEffects.map(e => e.label).join(', ');
    html += `<tr><td>Effects</td><td>${effectText}</td></tr>`;
  }

  // Feedback indicator - shows cyclic connections (e.g., Delay → Gain → Delay)
  if (hasFeedback) {
    html += `<tr><td><span class="has-tooltip" data-tooltip="Audio signal loops back (e.g., echo/reverb effect)">Loop</span></td><td class="graph-feedback">Feedback</td></tr>`;
  }

  // Output row
  if (outputs.length > 0) {
    const outputText = outputs.map(o => o.label).join(', ');
    html += `<tr><td>Output</td><td>${outputText}</td></tr>`;
  }

  html += `</table></div>`;
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENCODER DETECTORS - OCP Compliant Encoder Detection Pattern
// ═══════════════════════════════════════════════════════════════════════════════
//
// Purpose: Detect and extract encoding information from different sources
// Pattern: Array-based detector pattern for Open-Closed Principle compliance
//
// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY ORDER (CRITICAL - DO NOT REORDER WITHOUT UNDERSTANDING IMPACT)
// ─────────────────────────────────────────────────────────────────────────────
// Array.find() returns the FIRST matching detector, so order determines priority:
//
// 1. Detected Encoder        → Highest priority (explicit, most reliable)
//    - Direct encoder detection via WASM (libopus/libmp3lame), Blob analysis, etc.
//    - Provides: codec, bitrate, sample rate, channels
//    - Reliability: ★★★★★ (Kesin tespit)
//
// 2. WebRTC (RTCPeerConnection) → High priority (explicit from stats)
//    - RTCPeerConnection.getStats() outbound-rtp codec
//    - Provides: codec, bitrate, packetization
//    - Reliability: ★★★★☆ (Stats API'den kesin)
//
// 3. PendingMediaRecorder    → MediaRecorder active but mimeType empty
//    - Catches edge case where browser hasn't set mimeType yet
//    - Shows pulse animation until mimeType becomes available
//    - Reliability: ★★★☆☆ (API var ama codec henüz bilinmiyor)
//
// 4. MediaRecorder           → Medium-high priority (explicit from API)
//    - MediaRecorder.mimeType detection
//    - Provides: codec, bitrate (if specified)
//    - Reliability: ★★★★☆ (API'den kesin)
//
// 5. PendingWebAudio         → WebAudio pipeline detected, encoder pending
//    - AudioWorklet/ScriptProcessor with mic/system input
//    - Shows pulse animation until Blob is created
//    - Reliability: ★★★☆☆ (Pipeline var, encoder henüz bilinmiyor)
//
// 6. ScriptProcessor         → LOWEST priority (heuristic guess)
//    - ScriptProcessor presence in AudioContext pipeline
//    - Provides: educated guess (may encode to WAV/MP3)
//    - Reliability: ★★☆☆☆ (Tahmin - guarantee yok)
//    - Only shown when NO explicit encoder detected
//
// ⚠️ WARNING: Changing array order will break priority logic!
// ⚠️ ScriptProcessor MUST be last - it's a fallback heuristic
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO ADD NEW DETECTORS
// ─────────────────────────────────────────────────────────────────────────────
// 1. Determine reliability level:
//    - Explicit/API-based detection → Add BEFORE ScriptProcessor
//    - Heuristic/guess-based → Add AFTER existing detectors
//
// 2. Add detector object with:
//    { name, detect(data), extract(data) }
//
// 3. Insert at correct priority position (NOT at end if explicit!)
//
// 4. Update this comment block to document the new detector
//
// Example:
//   {
//     name: 'WebCodecs',
//     detect: (data) => !!data.webCodecs,
//     extract: (data) => ({ codec, bitrateKbps, source, rows })
//   }
//   → Insert AFTER MediaRecorder (explicit API detection)
//
// ─────────────────────────────────────────────────────────────────────────────
// Pattern to user-friendly confidence label mapping
// Shows detection method (Worker/AudioWorklet) and data quality (full/basic)
//
// ⚠️ SYNC REQUIRED: When adding new patterns in EarlyHook.js,
// add corresponding entry here. Pattern values must match exactly.
// Source: src/core/utils/EarlyHook.js → encoderInfo.pattern assignments
// Source: scripts/early-inject.js → Blob hook pattern assignments
const DETECTION_LABELS = {
  // AudioWorklet patterns (AudioWorklet.port.postMessage hook)
  'audioworklet-config': { text: 'AudioWorklet (full)', icon: '✓', tooltip: 'AudioWorklet.port.postMessage hook - all encoder parameters captured' },
  'audioworklet-init': { text: 'AudioWorklet (basic)', icon: '○', tooltip: 'AudioWorklet.port.postMessage hook - only basic parameters' },
  'audioworklet-deferred': { text: 'AudioWorklet (late)', icon: '◐', tooltip: 'AudioWorklet detected after context registration' },
  // Worker patterns (Worker.postMessage hook)
  'direct': { text: 'Worker Hook (full)', icon: '✓', tooltip: 'Worker.postMessage hook - full encoder configuration' },
  'nested': { text: 'Worker Hook (full)', icon: '✓', tooltip: 'Worker.postMessage hook - config in nested message' },
  'worker-init': { text: 'Worker Hook (basic)', icon: '○', tooltip: 'Worker.postMessage hook - basic initialization' },
  'worker-audio-init': { text: 'Worker (real-time)', icon: '◐', tooltip: 'Audio worker init detected - codec confirmed, bitrate may be default' },
  // Blob creation patterns (audio file created - post-hoc detection)
  'audio-blob': { text: 'Blob (post-hoc)', icon: '◑', tooltip: 'Audio file detected via Blob creation - encoding format confirmed after recording stopped' },
  // Default
  'unknown': { text: 'Detected', icon: '?', tooltip: 'Encoder detected but method unknown' }
};

const ENCODER_DETECTORS = [
  {
    name: 'DetectedEncoder',
    detect: (data) => {
      // Skip if no encoder data detected
      if (!data.detectedEncoder) return false;

      // If MediaRecorder is ACTIVE and encoder is from Blob detection only,
      // defer to MediaRecorder detector only when blob format matches MediaRecorder output.
      // Otherwise keep Blob signal (e.g., PCM/WAV export while a MediaRecorder exists on the page).
      const isOnlyBlobDetection = data.detectedEncoder.pattern === 'audio-blob';
      const mr = data.mediaRecorder;
      const mrIsActive = mr?.state === 'recording' || mr?.state === 'paused';
      const hasActiveMediaRecorder = mrIsActive && !!mr?.mimeType && mr?.hasAudioTrack !== false;
      if (isOnlyBlobDetection && hasActiveMediaRecorder) {
        const normalizeMime = (m) => (typeof m === 'string' ? m.split(';')[0].trim().toLowerCase() : '');
        const blobMimeBase = normalizeMime(data.detectedEncoder.mimeType);
        const mrMimeBase = normalizeMime(mr.mimeType);
        const sameBaseMime = blobMimeBase && mrMimeBase && blobMimeBase === mrMimeBase;

        const blobCodec = String(data.detectedEncoder.codec || '').toLowerCase();
        const blobContainer = String(data.detectedEncoder.container || '').toLowerCase();
        const isWavLike = blobCodec === 'pcm' || blobContainer === 'wav' || blobMimeBase === 'audio/wav' || blobMimeBase === 'audio/wave';

        if (!isWavLike && sameBaseMime) {
          return false; // Let MediaRecorder detector handle native recorder output
        }
      }

      return true;
    },
    extract: (data) => {
      const enc = data.detectedEncoder;

      // Build codec display with application type suffix if available
      // e.g., "OPUS (VoIP)", "OPUS (Audio)", "OPUS (LowDelay)"
      const rawCodec = enc.codec ?? 'unknown';
      const isUnknownCodec = typeof rawCodec === 'string' && rawCodec.toLowerCase() === 'unknown';

      const normalizeMime = (m) => (typeof m === 'string' ? m.split(';')[0].trim().toLowerCase() : '');
      const mimeBase = normalizeMime(enc.mimeType);
      const codecLower = String(rawCodec || '').toLowerCase();
      const containerLower = String(enc.container || '').toLowerCase();
      const isLinearPcmWav = codecLower === 'pcm' && (
        containerLower === 'wav' ||
        mimeBase === 'audio/wav' ||
        mimeBase === 'audio/wave'
      );

      // Show "Detecting..." for unknown codec (will be confirmed when Blob is created)
      // Codec = format (PCM, OPUS, MP3), Encoder = process (Linear PCM, Opus WASM)
      const codecBase = isUnknownCodec
        ? renderStatusPulse('Detecting...', 'Codec will be confirmed when recording stops and audio file is created')
        : (isLinearPcmWav ? 'PCM' : String(rawCodec).toUpperCase());
      const codecDisplay = enc.applicationName
        ? `${codecBase} (${enc.applicationName})`
        : codecBase;

      // Build rows dynamically based on available data
      const rows = [
        { label: 'Codec', value: codecDisplay, isMetric: true }
      ];

      // Encoder info (opus-wasm, mp3-wasm, aac-wasm, vorbis-wasm, flac-wasm, pcm)
      // Always show Encoder row - use "-" if not available
      if (enc.encoder) {
        // Display encoder type (e.g., "opus-wasm" → "Opus (WASM)", "pcm" → "Linear PCM")
        const encoderDisplay = formatEncoderDisplay(enc.encoder);

        // Build tooltip with library info (if available)
        const tooltipParts = [];
        if (enc.library) tooltipParts.push(`Library: ${enc.library}`);
        if (enc.workerFilename) tooltipParts.push(`Worker: ${enc.workerFilename}`);
        if (enc.encoderPath) tooltipParts.push(`Path: ${String(enc.encoderPath).split('/').pop()}`);
        const encoderTooltip = tooltipParts.length > 0 ? tooltipParts.join(' | ') : '';

        rows.push({
          label: 'Encoder',
          value: encoderTooltip
            ? `<span class="has-tooltip" data-tooltip="${escapeHtml(encoderTooltip)}">${encoderDisplay}</span>`
            : encoderDisplay,
          isMetric: true
        });
      } else {
        rows.push({ label: 'Encoder', value: '-', isMetric: false });
      }

      // Container format (OGG, WebM, WAV, MP4, etc.)
      // Always show - use "-" if not detected
      if (enc.container) {
        rows.push({ label: 'Container', value: enc.container.toUpperCase(), isMetric: true });
      } else {
        rows.push({ label: 'Container', value: '-', isMetric: false });
      }

      // Library (underlying C library: libopus, LAME, FDK AAC, etc.)
      // Always show - use "-" if not available (e.g., PCM has no library)
      if (enc.library) {
        rows.push({ label: 'Library', value: enc.library, isMetric: true });
      } else {
        rows.push({ label: 'Library', value: '-', isMetric: false });
      }

      // Bit Depth (important for PCM/WAV - shows sample format: 16-bit int, 32-bit float, etc.)
      if (enc.wavBitDepth) {
        rows.push({ label: 'Bit Depth', value: `${enc.wavBitDepth}bit`, isMetric: true });
      } else {
        rows.push({ label: 'Bit Depth', value: '-', isMetric: false });
      }

      // Bitrate - always show, dynamically calculated from blob size / duration
      if (enc.bitRate && enc.bitRate > 0) {
        rows.push({ label: 'Bitrate', value: `${Math.round(enc.bitRate / 1000)} kbps`, isMetric: true });
      } else if (enc.isLiveEstimate === true) {
        rows.push({
          label: 'Bitrate',
          value: '<span class="has-tooltip" data-tooltip="Recording in progress - bitrate will be calculated when recording stops">Calculating...</span>',
          isMetric: false
        });
      } else {
        rows.push({ label: 'Bitrate', value: '-', isMetric: false });
      }

      // Frame size (if available) - smart unit detection for Opus
      if (enc.frameSize) {
        // Opus frame sizes: 2.5, 5, 10, 20, 40, 60 ms OR 120, 240, 480, 960, 1920, 2880 samples (48kHz)
        const msValues = [2.5, 5, 10, 20, 40, 60];
        const unit = msValues.includes(enc.frameSize) || enc.frameSize < 100 ? 'ms' : 'samples';
        rows.push({ label: 'Frame', value: `${enc.frameSize} ${unit}`, isMetric: false });
      }

      // Input: Detect technology from AudioContext pipeline
      // Shows WHAT TECHNOLOGY processes audio before encoding (Worklet > ScriptProcessor > WebAudio)
      const deriveEncoderInput = () => {
        const contexts = Array.isArray(data.audioContext)
          ? data.audioContext
          : (data.audioContext ? [data.audioContext] : []);

        for (const ctx of contexts) {
          const processors = ctx?.pipeline?.processors || [];
          if (processors.length === 0) continue;

          const technology = detectEncoderInputTechnology(processors);
          if (technology) return technology;
        }
        return null;
      };

      const encoderInput = deriveEncoderInput();
      rows.push({
        label: 'Input',
        value: encoderInput || '-',
        isMetric: !!encoderInput
      });

      // Confidence indicator with source info on separate line
      // Note: Blob URL UUIDs are filtered at source (early-inject.js)
      const confidence = DETECTION_LABELS[enc.pattern] || DETECTION_LABELS['unknown'];
      const evidenceParts = [];
      if (enc.workerFilename) evidenceParts.push(`Worker: ${enc.workerFilename}`);
      if (enc.processorName) evidenceParts.push(`Worklet: ${enc.processorName}`);
      if (enc.encoderPath) evidenceParts.push(`Path: ${String(enc.encoderPath).split('/').pop()}`);
      const evidenceText = evidenceParts.length > 0 ? ` | ${evidenceParts.join(', ')}` : '';
      const confidenceText = `${confidence.icon} ${confidence.text}`;
      const confidenceTooltip = `${confidence.tooltip}${evidenceText}`;
      rows.push({
        label: 'Confidence',
        value: `<span class="has-tooltip" data-tooltip="${escapeHtml(confidenceTooltip)}">${confidenceText}</span>`,
        isMetric: false
      });

      return {
        codec: enc.codec ? String(enc.codec).toUpperCase() : 'UNKNOWN',
        bitrateKbps: enc.bitRate ? `${Math.round(enc.bitRate / 1000)}` : '-',
        source: enc.workerFilename || enc.processorName || 'Worker',
        timestamp: enc.timestamp || Date.now(),
        rows
      };
    }
  },
  {
    name: 'WebRTC',
    detect: (data) => data.rtcStats?.peerConnections?.length > 0,
    extract: (data) => {
      const pc = data.rtcStats.peerConnections.find(c => c.send) || data.rtcStats.peerConnections[0];
      if (!pc?.send?.codec) return null;

      const codecRaw = pc.send.codec.split('/')[1] || pc.send.codec;
      const codec = codecRaw.toUpperCase();
      const bitrateKbps = pc.send.bitrateKbps || '-';

      const rows = [
        { label: 'Codec', value: codec, isMetric: true },
        { label: 'Bitrate', value: `${bitrateKbps} kbps`, isMetric: true },
        // Encoder type - Browser's built-in WebRTC encoder
        {
          label: 'Encoder',
          value: '<span class="has-tooltip" data-tooltip="Browser\'s built-in WebRTC audio encoder">🌐 WebRTC Native</span>',
          isMetric: false
        }
      ];

      // Opus params (DTX, FEC, CBR/VBR, stereo) - if available
      if (pc.send.opusParams) {
        const op = pc.send.opusParams;
        const modeParts = [];
        if (op.cbr !== undefined) modeParts.push(op.cbr ? 'CBR' : 'VBR');
        if (op.dtx !== undefined) modeParts.push(`DTX:${op.dtx ? 'on' : 'off'}`);
        if (op.fec !== undefined) modeParts.push(`FEC:${op.fec ? 'on' : 'off'}`);
        if (op.stereo !== undefined) modeParts.push(op.stereo ? 'Stereo' : 'Mono');
        if (modeParts.length > 0) {
          rows.push({ label: 'Mode', value: modeParts.join(' / '), isMetric: false });
        }
      }

      return {
        codec,
        bitrateKbps,
        source: 'WebRTC',
        timestamp: data.rtcStats.timestamp || Date.now(),
        rows
      };
    }
  },
  // ─────────────────────────────────────────────────────────────────────
  // PendingMediaRecorder Detector
  // ─────────────────────────────────────────────────────────────────────
  // Detects MediaRecorder that is actively recording but mimeType is not yet available.
  // Some browsers/sites don't set mimeType until start() or first dataavailable event.
  // This ensures we show "recording in progress" instead of "no encoder".
  // Priority: BEFORE MediaRecorder (catches the "mimeType empty" edge case)
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'PendingMediaRecorder',
    detect: (data) => {
      const mr = data.mediaRecorder;
      if (!mr) return false;
      const isActive = mr.state === 'recording' || mr.state === 'paused';
      const hasMimeType = !!mr.mimeType;
      // Active MediaRecorder without mimeType
      return isActive && !hasMimeType;
    },
    extract: (data) => {
      const mr = data.mediaRecorder;
      const inputInfo = getInputSourceInfo(mr.audioSource, mr.hasAudioTrack);

      const rows = [
        {
          label: 'Codec',
          value: renderStatusPulse('Detecting...', 'Codec will be determined when first audio data is available'),
          isMetric: false
        },
        {
          label: 'Container',
          value: renderStatusPulse('Detecting...', 'Container format will be determined from mimeType'),
          isMetric: false
        },
        {
          label: 'Bitrate',
          value: mr.audioBitsPerSecond
            ? `${Math.round(mr.audioBitsPerSecond / 1000)} kbps`
            : renderStatusPulse('Detecting...', 'Bitrate will be available when encoding starts'),
          isMetric: !!mr.audioBitsPerSecond
        },
        {
          label: 'Encoder',
          value: '<span class="has-tooltip" data-tooltip="Browser\'s built-in MediaRecorder API">🌐 MediaRecorder API</span>',
          isMetric: true
        },
        {
          label: 'State',
          value: `<span class="badge badge-code">${mr.state}</span>`,
          isMetric: false
        }
      ];

      // Add input source if available
      const inputRow = buildInputRow(inputInfo);
      if (inputRow) rows.push(inputRow);

      return {
        codec: 'Detecting...',
        bitrateKbps: '-',
        source: 'MediaRecorder',
        timestamp: mr.timestamp || Date.now(),
        rows
      };
    }
  },
  {
    name: 'MediaRecorder',
    detect: (data) => !!data.mediaRecorder?.mimeType,
    extract: (data) => {
      const mr = data.mediaRecorder;
      const mimeTypeLower = (mr.mimeType || '').toLowerCase();

      // Extract codec from various sources
      let codecRaw = mr.parsedMimeType?.codec ||
        mr.mimeType.split('codecs=')[1]?.replace(/['"]/g, '') || '';

      // Edge Case: MP3 detection from mimeType when codecs= parameter is absent
      // MP3 is self-contained (codec IS the format), so mimeType alone is sufficient
      if (!codecRaw && (mimeTypeLower.includes('audio/mp3') || mimeTypeLower.includes('audio/mpeg'))) {
        codecRaw = 'mp3';
      }

      const codec = codecRaw ? codecRaw.toUpperCase() : '-';
      const container = mr.parsedMimeType?.container?.toUpperCase() || '';
      const bitrateKbps = mr.audioBitsPerSecond
        ? `${Math.round(mr.audioBitsPerSecond / 1000)}`
        : '-';

      const stateClass = mr.state === 'recording' ? 'good' :
        (mr.state === 'paused' ? 'warning' : '');

      const rows = [
        { label: 'Codec', value: codec, isMetric: true }
      ];

      if (container) {
        rows.push({ label: 'Container', value: container, isMetric: false });
      }

      rows.push({ label: 'Bitrate', value: `${bitrateKbps} kbps`, isMetric: true });

      // Encoder type - Browser's built-in MediaRecorder API (not WASM)
      // This distinguishes from WASM encoders like opus-recorder, lamejs, etc.
      rows.push({
        label: 'Encoder',
        value: '<span class="has-tooltip" data-tooltip="Browser\'s built-in MediaRecorder API - not a JavaScript/WASM library">🌐 MediaRecorder API</span>',
        isMetric: false
      });

      if (mr.state) {
        rows.push({
          label: 'State',
          value: `<span class="badge badge-code">${mr.state}</span>`,
          isMetric: false,
          cssClass: stateClass
        });
      }

      // Input source - shows where audio comes from (technical but useful)
      // 'synthesized' = AudioContext pipeline (PCM processed via ScriptProcessor/AudioWorklet)
      // 'microphone' = Direct microphone input
      // 'system' = System audio capture
      console.log('[Popup] MediaRecorder Input Debug:', {
        audioSource: mr.audioSource,
        hasAudioTrack: mr.hasAudioTrack,
        trackInfo: mr.trackInfo
      });
      const inputInfo = getInputSourceInfo(mr.audioSource, mr.hasAudioTrack);
      console.log('[Popup] getInputSourceInfo result:', inputInfo);
      const inputRow = buildInputRow(inputInfo);
      if (inputRow) {
        rows.push(inputRow);
      } else {
        console.log('[Popup] ⚠️ inputInfo is null - Input row NOT added');
      }

      return {
        codec,
        bitrateKbps,
        source: 'MediaRecorder',
        timestamp: mr.timestamp || Date.now(),
        rows
      };
    }
  },
  {
    name: 'PendingWebAudio',
    detect: (data) => {
      // ═══════════════════════════════════════════════════════════════════
      // SINGLE SOURCE OF TRUTH: Use recordingActive from early-inject.js
      // This is the ONLY reliable indicator - no complex heuristics needed
      // ═══════════════════════════════════════════════════════════════════
      if (data.detectedEncoder) return false;
      if (data.rtcStats?.peerConnections?.length > 0) return false;
      if (data.mediaRecorder?.mimeType) return false;
      if (!data.audioContext) return false;

      // Check for active audio pipeline with microphone input
      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      const hasActiveAudioPipeline = contexts.some(ctx => {
        const input = ctx?.pipeline?.inputSource;
        const processors = ctx?.pipeline?.processors || [];
        const hasProcessing = processors.some(p => p.type === 'audioWorkletNode' || p.type === 'scriptProcessor');
        return (input === 'microphone' || input === 'system' || input === 'synthesized') && hasProcessing;
      });

      if (!hasActiveAudioPipeline) return false;

      // SIMPLE: Just check if recording is active (set by MediaRecorder.start or Blob tracking)
      return data.recordingActive?.active === true;
    },
    extract: (data) => {
      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      const ctx = contexts.find(c => {
        const input = c?.pipeline?.inputSource;
        const processors = c?.pipeline?.processors || [];
        const hasProcessing = processors.some(p => p.type === 'audioWorkletNode' || p.type === 'scriptProcessor');
        return (input === 'microphone' || input === 'system' || input === 'synthesized') && hasProcessing;
      });
      if (!ctx) return null;

      const processors = ctx.pipeline?.processors || [];
      const pipelineType = processors.some(p => p.type === 'audioWorkletNode')
        ? 'AudioWorklet'
        : (processors.some(p => p.type === 'scriptProcessor') ? 'ScriptProcessor' : 'WebAudio');

      // Derive Input from AudioContext pipeline (this CAN be detected during recording)
      const encoderInput = detectEncoderInputTechnology(processors);

      return {
        codec: 'Detecting...',
        bitrateKbps: '-',
        source: 'WebAudio',
        timestamp: ctx.pipeline?.timestamp || ctx.static?.timestamp || Date.now(),
        rows: [
          {
            label: 'Codec',
            value: renderStatusPulse('Detecting...', 'Codec will be confirmed when the final audio Blob is created.'),
            isMetric: false
          },
          {
            label: 'Encoder',
            value: renderStatusPulse('Detecting...', `WebAudio pipeline detected (${pipelineType}). Encoder will be confirmed when encoding starts.`),
            isMetric: false
          },
          {
            label: 'Container',
            value: renderStatusPulse('Detecting...', 'Container format will be determined from the output Blob mimeType.'),
            isMetric: false
          },
          {
            label: 'Library',
            value: renderStatusPulse('Detecting...', 'Underlying library (libopus, LAME, etc.) will be detected from WASM/Worker analysis.'),
            isMetric: false
          },
          {
            label: 'Bit Depth',
            value: renderStatusPulse('Detecting...', 'Bit depth will be extracted from WAV header or encoder config.'),
            isMetric: false
          },
          {
            label: 'Bitrate',
            value: renderStatusPulse('Calculating...', 'Bitrate will be calculated from Blob size and duration when recording stops.'),
            isMetric: false
          },
          {
            label: 'Input',
            value: `<span class="has-tooltip" data-tooltip="Audio processing technology detected in WebAudio pipeline">${encoderInput || pipelineType}</span>`,
            isMetric: true
          },
          {
            label: 'Confidence',
            value: renderStatusPulse('Pending...', 'Confidence will be determined based on detection evidence.'),
            isMetric: false
          }
        ]
      };
    }
  },

  // ─────────────────────────────────────────────────────────────────────
  // ScriptProcessor Detector (Heuristic - LOWEST PRIORITY)
  // ─────────────────────────────────────────────────────────────────────
  // Detects ScriptProcessor usage which MAY indicate encoding to WAV/MP3
  // This is a fallback when no explicit encoder (WASM/WebRTC/MediaRecorder) is found
  // Priority: Lowest (only shown when no other encoder is detected)
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'ScriptProcessor',
    detect: (data) => {
      // Check if any AudioContext has ScriptProcessor in pipeline
      if (!data.audioContext) return false;

      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      return contexts.some(ctx =>
        ctx.pipeline?.processors?.some(p => p.type === 'scriptProcessor')
      );
    },
    extract: (data) => {
      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      const ctx = contexts.find(c =>
        c.pipeline?.processors?.some(p => p.type === 'scriptProcessor')
      );

      if (!ctx) return null;

      const sp = ctx.pipeline.processors.find(p => p.type === 'scriptProcessor');
      const bufferSize = sp?.bufferSize || '-';
      const channels = sp?.inputChannels || sp?.outputChannels || '-';

      // ScriptProcessor works with raw PCM data (uncompressed audio samples)
      // It's not a codec - it processes raw Float32Array audio buffers
      // The actual encoding (if any) happens downstream (WAV/MP3 encoding in JS or Worker)
      // NOTE: Buffer/Channels NOT shown here - already displayed in AudioContext section (DRY)
      return {
        codec: 'Raw PCM',
        bitrateKbps: '-',
        source: 'ScriptProcessor',
        timestamp: ctx.static?.timestamp || Date.now(),
        rows: [
          {
            label: 'Format',
            value: '<span class="has-tooltip" data-tooltip="ScriptProcessor processes raw PCM audio samples (Float32Array). Actual encoding may happen downstream.">Raw PCM</span>',
            isMetric: true
          },
          {
            label: 'Confidence',
            value: '<span class="has-tooltip" data-tooltip="ScriptProcessor detected - may be encoding to WAV/MP3 downstream. This is a heuristic, not confirmed.">○ Heuristic</span>',
            isMetric: false
          }
        ]
      };
    }
  }
];

// Render Encoding section - OCP compliant with detector pattern
function renderEncodingSection(detectedEncoder, rtcStats, mediaRecorder, audioContext, userMedia, recordingActive) {
  const container = document.getElementById('encodingContent');
  const timestamp = document.getElementById('encodingTimestamp');
  if (!container) return;

  const data = { detectedEncoder, rtcStats, mediaRecorder, audioContext, userMedia, recordingActive };

  // DEBUG: Log all available data
  console.log('[Popup] renderEncodingSection data:', {
    hasDetectedEncoder: !!detectedEncoder,
    detectedEncoderPattern: detectedEncoder?.pattern,
    hasRtcStats: !!rtcStats,
    hasMediaRecorder: !!mediaRecorder,
    mediaRecorderState: mediaRecorder?.state,
    mediaRecorderAudioSource: mediaRecorder?.audioSource,
    hasAudioContext: !!audioContext,
    hasUserMedia: !!userMedia,
    userMediaTimestamp: userMedia?.timestamp,
    recordingActive: recordingActive?.active
  });

  // Find first matching detector (priority order maintained by array order)
  const detector = ENCODER_DETECTORS.find(d => d.detect(data));
  console.log('[Popup] Selected detector:', detector?.name || 'NONE');

  if (!detector) {
    // No encoder detected
    container.innerHTML = '<div class="no-data">No encoder</div>';
    if (timestamp) timestamp.textContent = '';
    return;
  }

  const encoderData = detector.extract(data);

  if (!encoderData) {
    // Detected but extraction failed
    container.innerHTML = '<div class="no-data">No encoder</div>';
    if (timestamp) timestamp.textContent = '';
    return;
  }

  // Build HTML from rows
  let html = `<table><tbody>`;
  encoderData.rows.forEach(row => {
    const valueClass = row.isMetric ? 'class="metric-value"' : (row.cssClass ? `class="${row.cssClass}"` : '');
    html += `<tr><td>${row.label}</td><td ${valueClass}>${row.value}</td></tr>`;
  });
  html += `</tbody></table>`;

  container.innerHTML = html;
  if (timestamp) timestamp.textContent = formatTime(encoderData.timestamp);
}

/**
 * Get input source display info for MediaRecorder
 * Shows where the audio stream originates from
 * @param {string} audioSource - 'microphone', 'system', 'synthesized', 'remote', 'unknown', 'none'
 * @param {boolean} hasAudioTrack - Whether the stream has an audio track
 * @returns {{icon: string, label: string, tooltip?: string}|null}
 */
function getInputSourceInfo(audioSource, hasAudioTrack) {
  if (!hasAudioTrack) {
    return null; // Don't show input for video-only recordings
  }

  switch (audioSource) {
    case 'microphone':
      return {
        icon: '🎤',
        label: 'Microphone',
        tooltip: 'Direct microphone input (getUserMedia)'
      };
    case 'system':
      return {
        icon: '🔊',
        label: 'System Audio',
        tooltip: 'System audio capture (loopback/stereo mix)'
      };
    case 'synthesized':
      return {
        icon: '🔄',
        label: 'Web Audio',
        tooltip: 'Audio routed through Web Audio API (createMediaStreamDestination). PCM data may be processed via ScriptProcessor or AudioWorklet before encoding.'
      };
    case 'remote':
      return {
        icon: '📡',
        label: 'Remote',
        tooltip: 'Remote audio stream routed into the page (e.g., WebRTC remote track)'
      };
    case 'unknown':
      return {
        icon: '❓',
        label: 'Unknown',
        tooltip: 'Audio source could not be determined from track label'
      };
    default:
      // 'none' or truly undefined - don't show
      return null;
  }
}

/**
 * Build Input row object for ENCODER_DETECTORS
 * Centralizes input row creation to avoid DRY violations
 * @param {ReturnType<typeof getInputSourceInfo>} inputInfo - Result from getInputSourceInfo
 * @returns {{label: string, value: string, isMetric: boolean}|null}
 */
function buildInputRow(inputInfo) {
  if (!inputInfo) return null;
  return {
    label: 'Input',
    value: inputInfo.tooltip
      ? `<span class="has-tooltip" data-tooltip="${inputInfo.tooltip}">${inputInfo.icon} ${inputInfo.label}</span>`
      : `${inputInfo.icon} ${inputInfo.label}`,
    isMetric: false
  };
}

// Determine log line color class based on message content
function getLogColorClass(message, level) {
  // Priority 1: Level-based errors/warnings from logger
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';

  const msgLower = message.toLowerCase();

  // Priority 2: Explicit errors (highest priority after level)
  if (msgLower.includes('error') ||
      msgLower.includes('failed') ||
      msgLower.includes('❌')) {
    return 'error';
  }

  // Priority 3: Success states (green) - completed actions
  if (msgLower.includes('✅') ||
      msgLower.includes('started') ||    // "Started" = completed start
      msgLower.includes('ready') ||
      msgLower.includes('success') ||
      msgLower.includes('loaded')) {
    return 'success';
  }

  // Priority 4: Info states (blue) - ongoing/initialization
  // Use broader match to catch all variants
  if (msgLower.includes('initializ') ||  // initialize, initialized, initializing, initialization
      msgLower.includes('starting')) {   // "Starting..." = ongoing
    return 'info';
  }

  // Priority 5: Warning states (orange)
  if (msgLower.includes('waiting') ||
      msgLower.includes('warning') ||
      msgLower.includes('⚠️')) {
    return 'warn';
  }

  // Default: no special class (uses default colors)
  return '';
}

// Render Debug Logs (compact single-line format)
function renderDebugLogs(logs) {
  const container = document.getElementById('debugContent');
  const logCount = logs?.length || 0;

  // Update badge
  updateLogBadge(logCount);

  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="no-data">Waiting for events...</div>';
    return;
  }

  let html = '';
  logs.forEach(log => {
    const time = formatTime(log.timestamp);
    const colorClass = getLogColorClass(log.message, log.level);

    html += `<div class="log-line ${colorClass}">
      <span class="log-time">${time}</span>
      <span class="log-prefix">[${escapeHtml(log.prefix)}]</span>
      <span class="log-message">${escapeHtml(log.message)}</span>
    </div>`;
  });

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}



// Export function
function exportData() {
  if (!latestData) {
    alert('No data to export');
    return;
  }
  
  const json = JSON.stringify(latestData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `audio-inspector-${Date.now()}.json`;
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

// Copy logs to clipboard
async function copyLogs() {
  const result = await chrome.storage.local.get('debug_logs');
  const logs = result.debug_logs || [];

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
    const btn = document.getElementById('copyLogsBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.color = 'var(--accent-green)';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = '';
    }, 1500);
  } catch (err) {
    console.error('Failed to copy logs:', err);
    alert('Failed to copy logs');
  }
}

// Clear logs only
async function clearLogs() {
  await clearLogsOnly();
  renderDebugLogs([]);
  updateLogBadge(0);
}

// Toggle console drawer
function toggleDrawer() {
  drawerOpen = !drawerOpen;
  const drawer = document.getElementById('drawerOverlay');
  drawer.classList.toggle('open', drawerOpen);
}

// ========== Refresh Modal Functions ==========

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

// Event listeners
document.getElementById('toggleBtn').addEventListener('click', toggleInspector);
document.getElementById('exportBtn').addEventListener('click', exportData);
document.getElementById('clearBtn').addEventListener('click', clearData);
document.getElementById('copyLogsBtn').addEventListener('click', copyLogs);
document.getElementById('clearLogsBtn').addEventListener('click', clearLogs);
document.getElementById('drawerHandle').addEventListener('click', toggleDrawer);

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
      renderDebugLogs(changes.debug_logs.newValue);
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

// Initial load
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
