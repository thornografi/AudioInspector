// Content script - Bridge between page and extension
let injected = false;
let storedLogs = []; // Cache for logs
const MAX_STORED_LOGS = 100;

// Helper to save logs to storage
function persistLogs(newEntry) {
    // Add new entry
    storedLogs.push(newEntry);
    
    // Trim if too big
    if (storedLogs.length > MAX_STORED_LOGS) {
        storedLogs = storedLogs.slice(-MAX_STORED_LOGS);
    }
    
    // Save to storage
    chrome.storage.local.set({ 'debug_logs': storedLogs });
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
      logContent('✅ VoiceInspector: page script injected via background script');

      // Add initialization log to storage
      const initLog = {
        timestamp: Date.now(),
        level: 'info',
        prefix: 'Inspector',
        message: '🚀 VoiceInspector initialized'
      };
      persistLogs(initLog);

      // Note: State restoration moved to INSPECTOR_READY handler below
      // to avoid race condition with PageInspector initialization
    } else {
      logContent('❌ VoiceInspector: page script injection failed via background script', response?.error);
    }
  } catch (error) {
    logContent('❌ VoiceInspector: error sending injection request to background script', error);
  }
}

// --- Message Handlers (All payloads now have consistent 'type' field) ---

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
  
  // Handle INSPECTOR_READY - restore state if needed
  if (event.data.type === 'INSPECTOR_READY') {
      chrome.storage.local.get(['inspectorEnabled'], (result) => {
          if (result.inspectorEnabled === true) {
              logContent('🔄 Restoring inspector state after READY signal');

              const restoreLog = {
                timestamp: Date.now(),
                level: 'info',
                prefix: 'Content',
                message: '🔄 Restoring inspector state'
              };
              persistLogs(restoreLog);

              window.postMessage({
                  __audioPipelineInspector: true,
                  type: 'SET_ENABLED',
                  enabled: true
              }, '*');
          } else {
              logContent('Inspector READY but state is stopped (not restoring)');

              const stopLog = {
                timestamp: Date.now(),
                level: 'info',
                prefix: 'Content',
                message: 'Inspector state: stopped (not restoring)'
              };
              persistLogs(stopLog);
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


// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_ENABLED') {
    // Persist state
    chrome.storage.local.set({ inspectorEnabled: message.enabled });

    // Add explicit log to storage
    const statusLog = {
      timestamp: Date.now(),
      level: 'info',
      prefix: 'Content',
      message: message.enabled ? '✅ Inspector started' : '⏸️ Inspector stopped'
    };
    persistLogs(statusLog);

    // Forward enable/disable command to page script
    window.postMessage({
      __audioPipelineInspector: true,
      type: 'SET_ENABLED',
      enabled: message.enabled
    }, '*');
    sendResponse({success: true});
  }
});

// Inject immediately
injectPageScript();
