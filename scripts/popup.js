// Side panel script
let latestData = null;
let autoRefresh = true;
let enabled = false; // Default to false (stopped)
let drawerOpen = false; // Console drawer state
let currentTabId = null; // Track which tab this panel is associated with

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

// Main update function
async function updateUI() {
  // Get all relevant data from storage in one go
  const result = await chrome.storage.local.get([
    'rtc_stats',
    'user_media',
    'audio_context',
    'media_recorder',
    'debug_logs',
    'lastUpdate'
  ]);

  latestData = result; // Keep a copy for export

  // Render each section with its own data
  // The render functions are designed to handle null/undefined data gracefully
  renderRTCStats(result.rtc_stats);
  renderGUMStats(result.user_media);
  renderACStats(result.audio_context); // Now includes audioWorklets merged in
  renderMRStats(result.media_recorder);
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
  enabled = !enabled;

  // Get active tab in current window
  const tabs = await chrome.tabs.query({active: true, currentWindow: true, url: ["http://*/*", "https://*/*"]});
  const activeTab = tabs[0];

  // STOP durumunda kilitli tab bilgisini al (mesajı oraya göndermek için)
  const result = await chrome.storage.local.get(['lockedTab']);
  const lockedTab = result.lockedTab;

  if (enabled && activeTab) {
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

    await chrome.storage.local.remove(['inspectorEnabled', 'lockedTab']);
  }

  // Clear data when toggling (both ON and OFF)
  // This ensures fresh start for each session
  await chrome.storage.local.remove(['rtc_stats', 'user_media', 'audio_context', 'audio_worklet', 'media_recorder']);

  // Update button AND UI to reflect new state
  updateToggleButton();
  await checkTabLock(); // Banner durumunu güncelle (Start'ta hemen göster)
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
    statusText.textContent = 'Started';
    body.classList.add('recording');
  } else {
    // Inspector durmuş → Start butonu göster
    btn.innerHTML = '<span>Start</span>';
    statusText.textContent = 'Stopped';
    body.classList.remove('recording');
  }

  // Note: Icon is automatically updated by background.js storage listener
}

// Tab kilitleme kontrolü - popup açıldığında çağrılır
async function checkTabLock() {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.storage.local.get(['lockedTab', 'inspectorEnabled']);

  debugLog(`checkTabLock: currentTab=${currentTab?.id}, lockedTab=${result.lockedTab?.id}, enabled=${result.inspectorEnabled}`);

  if (result.inspectorEnabled && result.lockedTab) {
    const isSameTab = result.lockedTab.id === currentTab?.id;

    // Her zaman banner'ı göster - aynı veya farklı tab fark etmez
    showLockedTabInfo(result.lockedTab, isSameTab);
    debugLog(`Banner gösteriliyor (${isSameTab ? 'aynı tab' : 'farklı tab'}): ${result.lockedTab.url}`);

    return isSameTab;
  } else {
    debugLog('Inspector kapalı veya lockedTab yok');
    hideLockedTabInfo();
    return true;
  }
}

// Kilitli tab bilgisini göster
function showLockedTabInfo(lockedTab, isSameTab = false) {
  const banner = document.getElementById('lockedTabBanner');
  const domainSpan = document.getElementById('lockedTabDomain');
  const infoText = document.querySelector('.locked-tab-banner .info-text');
  const controls = document.querySelector('.controls');

  if (!banner || !domainSpan) {
    debugLog('❌ showLockedTabInfo: DOM element bulunamadı!');
    return;
  }

  // URL'den domain çıkar
  let domain;
  try {
    domain = new URL(lockedTab.url).hostname;
    domainSpan.textContent = domain;
  } catch {
    domain = lockedTab.title || 'Bilinmeyen';
    domainSpan.textContent = domain;
  }

  // Aynı tab vs farklı tab için farklı metin ve stil
  if (isSameTab) {
    banner.classList.add('visible', 'same-tab');
    banner.classList.remove('different-tab');
  } else {
    banner.classList.add('visible', 'different-tab');
    banner.classList.remove('same-tab');
    // NOT: Farklı tab'da da Stop butonu aktif - kullanıcı inspector'ı durdurabilmeli
  }
  controls?.classList.remove('disabled'); // Stop butonu her zaman aktif

  debugLog(`✅ Banner gösterildi: ${domain} (${isSameTab ? 'aynı' : 'farklı'} tab)`);
}

// Kilitli tab bilgisini gizle
function hideLockedTabInfo() {
  const banner = document.getElementById('lockedTabBanner');
  const controls = document.querySelector('.controls');

  banner?.classList.remove('visible', 'same-tab', 'different-tab');
  controls?.classList.remove('disabled');
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

// Format jitter (seconds to ms)
function formatJitter(jitterSec) {
  if (!jitterSec) return 'N/A';
  return `${(jitterSec * 1000).toFixed(2)} ms`;
}

// Format bitrate
function formatBitrate(bytes, duration) {
  if (!bytes || !duration) return 'N/A';
  const bps = (bytes * 8) / duration;
  if (bps > 1000000) return `${(bps / 1000000).toFixed(2)} Mbps`;
  if (bps > 1000) return `${(bps / 1000).toFixed(2)} Kbps`;
  return `${bps.toFixed(0)} bps`;
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

// Render getUserMedia stats (fixed layout)
function renderGUMStats(data) {
  const container = document.getElementById('gumContent');
  const timestamp = document.getElementById('gumTimestamp');

  let html = `<table><tbody>`;

  if (!data || !data.settings) {
    html += `<tr><td>Rate</td><td>-</td></tr>`;
    html += `<tr><td>Format</td><td>-</td></tr>`;
    html += `<tr><td>DSP</td><td>-</td></tr>`;
    html += `</tbody></table>`;
    container.innerHTML = html;
    timestamp.textContent = '';
    return;
  }

  timestamp.textContent = formatTime(data.timestamp);
  const s = data.settings;

  // DSP flags: AEC/AGC/NS
  const flags = [];
  if (s.echoCancellation) flags.push('AEC');
  if (s.autoGainControl) flags.push('AGC');
  if (s.noiseSuppression) flags.push('NS');
  const dspText = flags.length > 0 ? flags.join('+') : 'Off';

  html += `<tr><td>Rate</td><td class="metric-value">${s.sampleRate || '-'} Hz</td></tr>`;
  html += `<tr><td>Format</td><td>${s.channelCount || '?'}ch / ${s.sampleSize || '?'}bit</td></tr>`;
  html += `<tr><td>DSP</td><td class="${flags.length > 0 ? 'good' : ''}">${dspText}</td></tr>`;
  html += `</tbody></table>`;
  container.innerHTML = html;
}

// Render AudioContext stats with processing sub-section
function renderACStats(data) {
  const container = document.getElementById('acContent');
  const timestamp = document.getElementById('acTimestamp');

  if (!data) {
    container.innerHTML = '<div class="no-data">No context</div>';
    timestamp.textContent = '';
    return;
  }

  timestamp.textContent = formatTime(data.timestamp);

  // Main AudioContext info
  const latencyMs = data.baseLatency ? `${(data.baseLatency * 1000).toFixed(1)}ms` : '-';
  const stateClass = data.state === 'running' ? 'good' : (data.state === 'suspended' ? 'warning' : '');

  let html = `
    <table class="ac-main-table">
      <tbody>
        <tr><td>Rate</td><td class="metric-value">${data.sampleRate || '-'} Hz</td></tr>
        <tr><td>State</td><td class="${stateClass}"><span class="badge badge-code">${data.state || '-'}</span></td></tr>
        <tr><td>Latency</td><td>${latencyMs}</td></tr>
      </tbody>
    </table>
  `;

  // Processing Sub-section
  const hasScriptProcessor = data.scriptProcessors && data.scriptProcessors.length > 0;
  const hasAudioWorklet = data.audioWorklets && data.audioWorklets.length > 0;

  if (hasScriptProcessor || hasAudioWorklet) {
    html += `<div class="processing-section">`;

    // ScriptProcessor (deprecated)
    if (hasScriptProcessor) {
      data.scriptProcessors.forEach(sp => {
        html += `
          <div class="processing-item subheader">
            <span class="detail-label">Processor</span>
            <span class="detail-value">ScriptProcessorNode <span class="has-tooltip has-tooltip--warning" data-tooltip="Deprecated API">⚠</span></span>
          </div>
          <div class="processing-item sub-item">
            <span class="detail-label">Buffer</span>
            <span class="detail-value">${sp.bufferSize || '?'}</span>
          </div>`;
      });
    }

    // AudioWorklet (modern)
    if (hasAudioWorklet) {
      data.audioWorklets.forEach(aw => {
        const filename = aw.moduleUrl ? aw.moduleUrl.split('/').pop() : '-';
        html += `
          <div class="processing-item subheader">
            <span class="detail-label">Processor</span>
            <span class="detail-value" title="${escapeHtml(aw.moduleUrl)}">${escapeHtml(filename)}</span>
          </div>`;
      });
    }

    // Output bilgisi
    if (data.destinationType) {
      html += `
        <div class="processing-item sub-item">
          <span class="detail-label">Output</span>
          <span class="detail-value">${escapeHtml(data.destinationType)}</span>
        </div>`;
    }

    html += `</div>`;
  }

  container.innerHTML = html;
}

// Render MediaRecorder stats (fixed layout)
function renderMRStats(data) {
  const container = document.getElementById('mrContent');
  const timestamp = document.getElementById('mrTimestamp');

  let html = `<table><tbody>`;

  if (!data) {
    html += `<tr><td>Format</td><td>-</td></tr>`;
    html += `<tr><td>State</td><td>-</td></tr>`;
    html += `<tr><td>Bitrate</td><td>-</td></tr>`;
    html += `</tbody></table>`;
    container.innerHTML = html;
    timestamp.textContent = '';
    return;
  }

  timestamp.textContent = formatTime(data.timestamp);

  const codec = data.parsedMimeType?.codec || data.mimeType?.split('codecs=')[1]?.replace(/['"]/g, '') || '-';
  const container_fmt = data.parsedMimeType?.container || '';
  const format = container_fmt ? `${codec}/${container_fmt}` : codec;

  // State with color
  const stateClass = data.state === 'recording' ? 'good' : (data.state === 'paused' ? 'warning' : '');

  // Bitrate if available
  const bitrateText = data.audioBitsPerSecond ? `${Math.round(data.audioBitsPerSecond / 1000)} kbps` : '-';

  html += `<tr><td>Format</td><td class="metric-value">${format}</td></tr>`;
  html += `<tr><td>State</td><td class="${stateClass}"><span class="badge badge-code">${data.state || '-'}</span></td></tr>`;
  html += `<tr><td>Bitrate</td><td>${bitrateText}</td></tr>`;
  html += `</tbody></table>`;
  container.innerHTML = html;
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
  // Clear all storage
  await chrome.storage.local.clear();
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
  await chrome.storage.local.remove('debug_logs');
  renderDebugLogs([]);
  updateLogBadge(0);
}

// Toggle console drawer
function toggleDrawer() {
  drawerOpen = !drawerOpen;
  const drawer = document.getElementById('drawerOverlay');
  drawer.classList.toggle('open', drawerOpen);
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

// Sidebar modunda tab değişikliğini dinle
chrome.tabs.onActivated.addListener((activeInfo) => {
  // Aktif tab değişti, banner durumunu kontrol et
  checkTabLock();
});

// Listen for storage changes instead of polling
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    // Only update UI if relevant keys changed
    // Note: audioWorklet data is now merged into audio_context
    const relevantKeys = ['rtc_stats', 'user_media', 'audio_context', 'media_recorder'];
    const shouldUpdate = Object.keys(changes).some(key => relevantKeys.includes(key));

    if (shouldUpdate) {
      updateUI();
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
    }

    // lockedTab değişikliği (tab kapatıldığında background.js tarafından silinir)
    if (changes.lockedTab) {
      // lockedTab silindiyse veya değiştiyse tab lock kontrolü yap
      checkTabLock();
    }
  }
});

// Notify background when panel closes (X button or other means)
window.addEventListener('beforeunload', () => {
  if (currentTabId) {
    chrome.runtime.sendMessage({ type: 'PANEL_CLOSED', tabId: currentTabId });
  }
});

// Initial load
loadEnabledState().then(async () => {
  // Panel açıldığında aktif tab ID'sini kaydet (kapanma bildirim için)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = activeTab?.id;

  // Sayfa yenilendiğinde logları temizle
  await chrome.storage.local.remove(['debug_logs']);
  renderDebugLogs([]);

  // Tab kilitleme kontrolü
  await checkTabLock();

  // If inspector is not enabled on initial load, clear any old data
  if (!enabled) {
    await chrome.storage.local.remove(['rtc_stats', 'user_media', 'audio_context', 'audio_worklet', 'media_recorder']);
  }
  updateUI();
});
