// Content script - Bridge between page and extension
let injected = false;

// Helper to save logs - background.js üzerinden merkezi yönetim (race condition önleme)
function persistLogs(newEntry) {
    chrome.runtime.sendMessage({ type: 'ADD_LOG', entry: newEntry });
}

// Helper to create standardized log entries (DRY principle)
function createLog(prefix, message, level = 'info') {
    return {
        timestamp: Date.now(),
        level,
        prefix,
        message
    };
}

// Debug logging
const contentLogs = [];
function logContent(msg, data) {
  const entry = { timestamp: new Date().toISOString(), msg, data };
  contentLogs.push(entry);
  if (contentLogs.length > 30) contentLogs.shift();
  window.__contentScriptLogs = contentLogs;
  console.log('[Content]', msg, data || '');
}

// Auto-inject on load
async function injectPageScript() {
  if (injected) return;

  // Don't inject on chrome:// URLs (extension, settings, etc)
  if (window.location.protocol === 'chrome:') {
    return;
  }

  injected = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'INJECT_PAGE_SCRIPT' });
    if (response?.success) {
      logContent('✅ AudioInspector: page script injected via background script');

      // Add initialization log to storage
      persistLogs(createLog('Inspector', '🚀 AudioInspector initialized'));

      // Note: State restoration moved to INSPECTOR_READY handler below
      // to avoid race condition with PageInspector initialization
    } else {
      logContent('❌ AudioInspector: page script injection failed via background script', response?.error);
    }
  } catch (error) {
    logContent('❌ AudioInspector: error sending injection request to background script', error);
  }
}

// --- Message Handlers (All payloads now have consistent 'type' field) ---

// Storage keys for collected data (DRY - used in multiple places)
const DATA_STORAGE_KEYS = ['rtc_stats', 'user_media', 'audio_context', 'audio_worklet', 'media_recorder'];

// Helper to create storage handlers (DRY principle)
const storageHandler = (key, emoji, label) => (payload) => ({
  key,
  logMsg: `${emoji} Storing ${label}`
});

const MESSAGE_HANDLERS = {
  rtc_stats: storageHandler('rtc_stats', '📡', 'WebRTC stats'),
  userMedia: storageHandler('user_media', '🎤', 'getUserMedia'),
  audioContext: storageHandler('audio_context', '🔊', 'AudioContext'),
  mediaRecorder: storageHandler('media_recorder', '🎙️', 'MediaRecorder'),

  // Special handler for audioWorklet - merge into parent audioContext
  audioWorklet: (payload) => {
    chrome.storage.local.get(['audio_context'], (result) => {
      const context = result.audio_context || {};

      // Initialize audioWorklets array if needed
      if (!context.audioWorklets) {
        context.audioWorklets = [];
      }

      // Add new worklet (avoid duplicates by checking moduleUrl)
      const existingIndex = context.audioWorklets.findIndex(w => w.moduleUrl === payload.moduleUrl);
      if (existingIndex >= 0) {
        // Update existing entry
        context.audioWorklets[existingIndex] = {
          moduleUrl: payload.moduleUrl,
          timestamp: payload.timestamp
        };
      } else {
        // Add new entry
        context.audioWorklets.push({
          moduleUrl: payload.moduleUrl,
          timestamp: payload.timestamp
        });
      }

      // Save merged data back
      chrome.storage.local.set({
        audio_context: context,
        lastUpdate: Date.now()
      });

      logContent('🎛️ AudioWorklet merged into AudioContext', payload.moduleUrl);
    });

    return null; // Handled internally
  },

  // Special handler for log entries
  LOG_ENTRY: (payload) => {
    persistLogs(payload);
    return null;
  }
};

// Listen for messages from page script
window.addEventListener('message', (event) => {
  // Only accept messages from same origin
  if (event.source !== window) return;
  if (!event.data?.__audioPipelineInspector) return;
  
  // Handle INSPECTOR_READY - restore state if needed (with tab lock check)
  if (event.data.type === 'INSPECTOR_READY') {
      chrome.storage.local.get(['inspectorEnabled', 'lockedTab'], (result) => {
          if (result.inspectorEnabled === true && result.lockedTab) {
              // Tab ID kontrolü yap
              chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
                  const currentTabId = response?.tabId;
                  const lockedTabId = result.lockedTab.id;
                  const currentOrigin = window.location.origin;
                  let lockedOrigin;
                  try {
                      lockedOrigin = new URL(result.lockedTab.url).origin;
                  } catch {
                      lockedOrigin = null;
                  }

                  // Debug log - tab ID ve origin karşılaştırması
                  logContent(`Tab check: current=${currentTabId}, locked=${lockedTabId}, origins: ${currentOrigin} vs ${lockedOrigin}`);
                  persistLogs(createLog('Content', `Tab check: current=${currentTabId}, locked=${lockedTabId}`));

                  // Tab ID kontrolü
                  if (currentTabId !== lockedTabId) {
                      // Farklı tab, başlatma
                      logContent('Inspector active but this tab is not locked (not starting)');
                      persistLogs(createLog('Content', `Different tab (${currentTabId} != ${lockedTabId}) - not starting`));
                      return;
                  }

                  // Origin kontrolü - aynı tab'da farklı siteye gidilmiş olabilir
                  if (currentOrigin !== lockedOrigin) {
                      logContent(`Same tab but different origin: ${currentOrigin} vs ${lockedOrigin} (not starting)`);
                      persistLogs(createLog('Content', `Same tab, different origin (${currentOrigin}) - not starting`));
                      return;
                  }

                  // Hem tab ID hem origin eşleşti, başlat
                  logContent('🔄 Restoring inspector state (tab + origin match)');
                  persistLogs(createLog('Content', '🔄 Restoring inspector state'));

                  // Clear stale data before restoring
                  chrome.storage.local.remove(DATA_STORAGE_KEYS, () => {
                    logContent('🧹 Cleared stale data before restore');

                    window.postMessage({
                        __audioPipelineInspector: true,
                        type: 'SET_ENABLED',
                        enabled: true
                    }, '*');
                  });
              });
          } else {
              logContent('Inspector READY but state is stopped (not restoring)');
              persistLogs(createLog('Content', 'Inspector state: stopped (not restoring)'));
          }
      });
      return;
  }

  // Separate handling for direct types like LOG_ENTRY
  if (event.data.type === 'LOG_ENTRY') {
      persistLogs(event.data.payload);
      return;
  }

  const payload = event.data.payload;

  // All payloads now have consistent 'type' field
  const handlerType = payload?.type;

  const handler = MESSAGE_HANDLERS[handlerType];

  if (handler) {
    const result = handler(payload);
    if (!result) return; // Handler handled it internally (like LOG_ENTRY)

    const { key, logMsg, logData } = result;
    const dataToStore = {
      [key]: payload,
      lastUpdate: Date.now()
    };

    logContent(logMsg, logData || payload);

    chrome.storage.local.set(dataToStore, () => {
      if (chrome.runtime.lastError) {
        logContent('❌ Error storing data:', chrome.runtime.lastError);
      }
    });
  } else {
    logContent('⚠️ Unknown data type received', payload);
  }
});


// Listen for messages from popup (main frame only to prevent duplication)
if (window.self === window.top) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SET_ENABLED') {
      // Persist state
      chrome.storage.local.set({ inspectorEnabled: message.enabled });

      // Clear all data storage on start to prevent stale data from previous sessions
      if (message.enabled) {
        chrome.storage.local.remove(DATA_STORAGE_KEYS, () => {
          logContent('🧹 Cleared stale data from storage');
        });
      }

      // Add explicit log to storage
      persistLogs(createLog('Content', message.enabled ? '✅ Inspector started' : '⏸️ Inspector stopped'));

      // Forward enable/disable command to page script
      window.postMessage({
        __audioPipelineInspector: true,
        type: 'SET_ENABLED',
        enabled: message.enabled
      }, '*');
      sendResponse({success: true});
    }
  });
} else {
  logContent(`⚠️ Running in iframe - message handling disabled`);
}

// Inject immediately
injectPageScript();
