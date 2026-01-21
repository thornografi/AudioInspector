// Content script - Bridge between page and extension
let injected = false;
let currentTabId = null; // Global tab ID for sourceTabId tagging

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

// Auto-inject on load with retry mechanism
const INJECTION_MAX_RETRIES = 3;
const INJECTION_RETRY_DELAY = 100; // ms, exponential backoff

async function injectPageScript(attempt = 1) {
  if (injected) return;

  // Don't inject on chrome:// URLs (extension, settings, etc)
  if (window.location.protocol === 'chrome:') {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'INJECT_PAGE_SCRIPT' });
    if (response?.success) {
      injected = true; // Only set on success
      logContent('✅ AudioInspector: page script injected via background script');

      // Get tab ID from injection response (sync - prevents race condition)
      // Previously used separate GET_TAB_ID message which could arrive late
      currentTabId = response.tabId || null;
      logContent(`📍 Tab ID acquired (sync): ${currentTabId}`);

      // Add initialization log to storage
      persistLogs(createLog('Inspector', '🚀 AudioInspector initialized'));

      // Note: State restoration moved to INSPECTOR_READY handler below
      // to avoid race condition with PageInspector initialization
    } else {
      throw new Error(response?.error || 'Unknown injection error');
    }
  } catch (error) {
    logContent(`⚠️ Injection attempt ${attempt}/${INJECTION_MAX_RETRIES} failed`, error);

    if (attempt < INJECTION_MAX_RETRIES) {
      // Exponential backoff retry
      const delay = INJECTION_RETRY_DELAY * attempt;
      await new Promise(r => setTimeout(r, delay));
      return injectPageScript(attempt + 1);
    } else {
      logContent('❌ All injection attempts failed - manual reload may be required');
      // Notify user via autoStopBanner mechanism
      chrome.storage.local.set({ autoStoppedReason: 'injection_failed' });
    }
  }
}

// --- Message Handlers (All payloads now have consistent 'type' field) ---

// ═══════════════════════════════════════════════════════════════════════════════
// DRY: Storage keys fetched from background.js (single source of truth)
// Fallback array used until background.js responds (prevents race condition)
// ═══════════════════════════════════════════════════════════════════════════════
let DATA_STORAGE_KEYS = ['rtc_stats', 'user_media', 'audio_contexts', 'audio_worklet', 'media_recorder', 'wasm_encoder', 'audio_connections'];

// ═══════════════════════════════════════════════════════════════════════════════
// DRY HELPER: WASM Encoder data merge with null-safe field preservation
// OCP: Add new fields to ENCODER_MERGE_FIELDS array, no logic change needed
// ═══════════════════════════════════════════════════════════════════════════════
const ENCODER_MERGE_FIELDS = [
  'encoder', 'bitRate', 'channels', 'sampleRate', 'application',
  'applicationName', 'frameSize', 'processorName', 'originalSampleRate',
  'wavBitDepth', 'container', 'encoderPath', 'sessionId',
  'recordingDuration', 'calculatedBitRate', 'isLiveEstimate', 'mimeType', 'blobSize', 'status'
];

function mergeEncoderData(existing, payload) {
  const merged = { ...existing, ...payload };

  // Special: codec can come from 'codec' (preferred) or legacy 'type' field.
  // IMPORTANT: payload.type is usually the message type (e.g., "wasmEncoder") - never treat that as a codec.
  const codecCandidate = payload.codec ?? payload.type;
  if (typeof codecCandidate === 'string') {
    const lc = codecCandidate.toLowerCase();
    const allowed = ['opus', 'mp3', 'aac', 'vorbis', 'flac', 'pcm', 'unknown'];
    merged.codec = allowed.includes(lc) ? lc : existing.codec;
  } else {
    merged.codec = existing.codec;
  }

  // Null-safe merge: preserve existing values if payload has null/undefined
  for (const field of ENCODER_MERGE_FIELDS) {
    merged[field] = payload[field] ?? existing[field];
  }

  // Source priority: 'audioworklet-*' > 'direct' > others
  merged.source = payload.source?.includes('audioworklet') ? payload.source :
                  (existing.source?.includes('audioworklet') ? existing.source :
                   (payload.source === 'direct' ? 'direct' : (existing.source || payload.source)));

  return merged;
}

// Fetch actual keys from background.js (async, updates DATA_STORAGE_KEYS)
chrome.runtime.sendMessage({ type: 'GET_STORAGE_KEYS' }, (response) => {
  if (response?.keys) {
    DATA_STORAGE_KEYS = response.keys;
  }
});

/**
 * Clear current session artifacts (measurement data + debug logs), keep state.
 * DRY: Delegates to background.js (single source of truth)
 * Used on every START to ensure refresh/navigation behaves consistently.
 * @param {Function} [callback] - Optional callback after removal
 */
function clearSessionData(callback) {
  chrome.runtime.sendMessage({ type: 'CLEAR_INSPECTOR_DATA', preset: 'SESSION' }, () => {
    if (callback) callback();
  });
}

// Queue for audioContext updates to prevent race conditions
// NOTE: audioWorklet updates also go through this queue to prevent race conditions
let audioContextQueue = [];
let isProcessingAudioContext = false;

function processAudioContextQueue() {
  if (isProcessingAudioContext || audioContextQueue.length === 0) return;

  isProcessingAudioContext = true;
  const queueItem = audioContextQueue.shift();

  chrome.storage.local.get(['audio_contexts'], (result) => {
    let contexts = result.audio_contexts || [];

    // Handle audioWorklet updates (merge into existing context)
    if (queueItem._isWorkletUpdate) {
      const { contextId, moduleUrl, timestamp, sourceTabId } = queueItem;

      if (contextId) {
        const targetContext = contexts.find(c => c.contextId === contextId);

        if (targetContext) {
          // Ensure pipeline structure exists
          if (!targetContext.pipeline) {
            targetContext.pipeline = { processors: [], timestamp: Date.now() };
          }
          if (!targetContext.pipeline.processors) {
            targetContext.pipeline.processors = [];
          }

          // Find existing audioWorklet processor by moduleUrl
          const existingIndex = targetContext.pipeline.processors.findIndex(
            p => p.type === 'audioWorklet' && p.moduleUrl === moduleUrl
          );

          const workletEntry = {
            type: 'audioWorklet',
            moduleUrl: moduleUrl,
            timestamp: timestamp
          };

          if (existingIndex >= 0) {
            targetContext.pipeline.processors[existingIndex] = workletEntry;
          } else {
            targetContext.pipeline.processors.push(workletEntry);
          }
          targetContext.pipeline.timestamp = Date.now();

          logContent(`🎛️ AudioWorklet merged into context ${contextId}`, moduleUrl);
        } else {
          logContent(`⚠️ AudioWorklet target context not found: ${contextId}`, moduleUrl);
        }
      } else {
        // ORPHAN worklet - context not found, just log
        logContent('🎛️ AudioWorklet detected (orphan - context not matched)', moduleUrl);
        persistLogs(createLog('Content', `⚠️ Orphan AudioWorklet: ${moduleUrl} (context unknown)`));
      }
    } else {
      // Standard audioContext update
      const payload = queueItem;
      const existingIndex = contexts.findIndex(c => c.contextId === payload.contextId);

      if (existingIndex >= 0) {
        // Deep merge with existing (static/pipeline yapısı)
        const existing = contexts[existingIndex];
        contexts[existingIndex] = {
          ...existing,
          ...payload,
          // Static: shallow merge (sadece timestamp değişmez, diğerleri güncellenebilir)
          static: { ...existing.static, ...payload.static },
          // Pipeline: processors array özel merge
          // Note: Empty array ([]) is a valid reset - don't fall back to existing
          pipeline: {
            ...existing.pipeline,
            ...payload.pipeline,
            processors: Array.isArray(payload.pipeline?.processors)
              ? payload.pipeline.processors  // Use new array (even if empty = reset)
              : existing.pipeline?.processors || []
          },
          // wasmEncoder root level'da kalır
          wasmEncoder: payload.wasmEncoder || existing.wasmEncoder
        };
      } else {
        // New context
        contexts.push(payload);
      }
    }

    chrome.storage.local.set({
      audio_contexts: contexts,
      lastUpdate: Date.now()
    }, () => {
      if (chrome.runtime.lastError) {
        persistLogs(createLog('Content', `❌ audioContext SET error: ${chrome.runtime.lastError.message}`, 'error'));
      } else if (!queueItem._isWorkletUpdate) {
        persistLogs(createLog('Content', `✅ audioContext SET: ${contexts.length} context(s)`));
      }

      isProcessingAudioContext = false;
      processAudioContextQueue(); // Process next in queue
    });
  });
}

// Helper to create storage handlers (DRY principle)
const storageHandler = (key, emoji, label) => (payload) => ({
  key,
  logMsg: `${emoji} Storing ${label}`
});

const MESSAGE_HANDLERS = {
  rtc_stats: storageHandler('rtc_stats', '📡', 'WebRTC stats'),
  userMedia: storageHandler('user_media', '🎤', 'getUserMedia'),

  // Special handler for audioContext - uses queue to prevent race conditions
  audioContext: (payload) => {
    persistLogs(createLog('Content', `🔊 audioContext queued: id=${payload?.contextId}, rate=${payload?.static?.sampleRate}`));
    audioContextQueue.push({ ...payload, sourceTabId: currentTabId });
    processAudioContextQueue();
    return null; // Handled internally
  },

  mediaRecorder: storageHandler('media_recorder', '🎙️', 'MediaRecorder'),

  // CANONICAL: Tüm WASM encoder tespitleri bu handler'dan geçer
  // AudioContextCollector hem URL pattern hem opus hook için buraya emit eder
  // popup.js bu storage key'den okur (tek doğru kaynak)
  // MERGE STRATEGY: Zengin field'ları koru, null override'i engelle
  wasmEncoder: (payload) => {
    chrome.storage.local.get(['wasm_encoder'], (result) => {
      const existing = result.wasm_encoder || null;
      const existingSessionId = Number.isInteger(existing?.sessionId) ? existing.sessionId : null;
      const incomingSessionId = Number.isInteger(payload?.sessionId) ? payload.sessionId : null;

      // New recording session signal: clear stale encoder info
      // IMPORTANT: Reset must be monotonic by sessionId to avoid race where reset arrives after encoder data.
      if (payload?.reset === true) {
        if (incomingSessionId !== null && existingSessionId !== null && existingSessionId >= incomingSessionId) {
          return; // Ignore stale/duplicate reset
        }

        chrome.storage.local.remove(['wasm_encoder'], () => {
          if (chrome.runtime.lastError) {
            persistLogs(createLog('Content', `❌ wasm_encoder RESET error: ${chrome.runtime.lastError.message}`, 'error'));
          } else {
            persistLogs(createLog('Content', '🧹 wasm_encoder cleared (new recording session)'));
          }
        });
        return;
      }

      // Ignore stale encoder events from previous sessions
      if (incomingSessionId !== null && existingSessionId !== null && incomingSessionId < existingSessionId) {
        return;
      }

      const merged = mergeEncoderData(existing || {}, payload);
      if (incomingSessionId !== null) {
        merged.sessionId = incomingSessionId;
      } else if (existingSessionId !== null) {
        merged.sessionId = existingSessionId;
      }

      chrome.storage.local.set({
        wasm_encoder: { ...merged, sourceTabId: currentTabId },
        lastUpdate: Date.now()
      }, () => {
        if (chrome.runtime.lastError) {
          persistLogs(createLog('Content', `❌ wasm_encoder SET error: ${chrome.runtime.lastError.message}`, 'error'));
        } else {
          const existingSource = existing?.source;
          const sourceInfo = payload.source === existingSource ? payload.source : `${payload.source} (merged with ${existingSource || 'none'})`;
          persistLogs(createLog('Content', `🔧 WASM Encoder stored: ${sourceInfo}`));
        }
      });
    });

    return null; // Handled internally
  },

  // Special handler for audioWorklet - uses queue to prevent race conditions with audioContext
  // NOTE: AudioContextCollector already handles worklets with proper context matching
  // This handler receives worklets and queues them for merge into audio_contexts
  audioWorklet: (payload) => {
    persistLogs(createLog('Content', `🎛️ audioWorklet queued: contextId=${payload?.contextId}, url=${payload?.moduleUrl}`));

    // Queue worklet update with special flag for queue processor
    audioContextQueue.push({
      _isWorkletUpdate: true,
      contextId: payload.contextId,
      moduleUrl: payload.moduleUrl,
      timestamp: payload.timestamp,
      sourceTabId: currentTabId
    });
    processAudioContextQueue();

    return null; // Handled internally
  },

  // Handler for audio connection graph (AudioNode.connect() calls)
  // Stores the audio graph topology showing who connects to whom
  audioConnection: (payload) => {
    chrome.storage.local.get(['audio_connections'], (result) => {
      // Store all connections array directly from payload
      const connections = payload.allConnections || [];

      chrome.storage.local.set({
        audio_connections: {
          connections,
          lastUpdate: Date.now(),
          sourceTabId: currentTabId
        }
      }, () => {
        if (chrome.runtime.lastError) {
          persistLogs(createLog('Content', `❌ audio_connections SET error: ${chrome.runtime.lastError.message}`, 'error'));
        } else {
          // Log: single connection or batch sync
          const conn = payload.connection;
          if (conn) {
            persistLogs(createLog('Content', `🔗 Connection: ${conn.sourceType} → ${conn.destType}`));
          } else {
            persistLogs(createLog('Content', `🔗 Connections synced: ${connections.length} total`));
          }
        }
      });
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
  // Security: Only accept messages from same window and same origin
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!event.data?.__audioPipelineInspector) return;

  // Handle DEBUG_LOG - forward to extension console panel
  if (event.data.type === 'DEBUG_LOG') {
    const { prefix, message, level } = event.data.payload || {};
    if (message) {
      persistLogs(createLog(prefix || 'Debug', message, level || 'info'));
    }
    return;
  }

  // Handle INSPECTOR_READY - delegate state decision to background.js (centralized)
  // ═══════════════════════════════════════════════════════════════════════════
  // CENTRALIZED APPROACH: All state decisions are made by background.js
  // content.js only forwards page info and executes commands from background.js
  // This prevents race conditions and duplicate logic
  // ═══════════════════════════════════════════════════════════════════════════
  if (event.data.type === 'INSPECTOR_READY') {
      logContent('📡 INSPECTOR_READY - delegating to background.js');

      // Send page info to background.js for centralized decision making
      chrome.runtime.sendMessage({
          type: 'PAGE_READY',
          tabId: currentTabId,
          url: window.location.href,
          origin: window.location.origin,
          title: document.title
      }, (response) => {
          if (chrome.runtime.lastError) {
              logContent('⚠️ PAGE_READY message failed:', chrome.runtime.lastError.message);
              return;
          }

          if (!response) {
              logContent('⚠️ No response from background.js');
              return;
           }

           logContent(`📥 Background response: action=${response.action}`, response);

           // Execute action based on background.js decision
           switch (response.action) {
               case 'START':
                   // Refresh/navigation/session restore: always start with a clean session (data + logs)
                   clearSessionData(() => {
                       persistLogs(createLog('Content', 'Background decision: START'));
                       logContent('🧹 Cleared stale session data before restore');
                       window.postMessage({
                           __audioPipelineInspector: true,
                           type: 'SET_ENABLED',
                          enabled: true
                      }, '*');
                  });
                  break;

               case 'STOP':
                   // Just ensure page script is stopped (background already updated storage)
                   persistLogs(createLog('Content', 'Background decision: STOP'));
                   window.postMessage({
                       __audioPipelineInspector: true,
                       type: 'SET_ENABLED',
                       enabled: false
                  }, '*');
                  break;

               case 'NONE':
               default:
                   // Do nothing - inspector should stay stopped
                   persistLogs(createLog('Content', `Background decision: ${response.action || 'NONE'}`));
                   logContent('Inspector READY but staying stopped (background decision: NONE)');
                   break;
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

    // Helper to create storage data object (DRY)
    const createDataToStore = () => ({
      [key]: { ...payload, sourceTabId: currentTabId },
      lastUpdate: Date.now()
    });

    // Normal flow (no reset needed)
    logContent(logMsg, logData || payload);

    chrome.storage.local.set(createDataToStore(), () => {
      if (chrome.runtime.lastError) {
        logContent('❌ Error storing data:', chrome.runtime.lastError);
      }
    });
  } else {
    logContent('⚠️ Unknown data type received', payload);
  }
});


/**
 * Async handler for SET_ENABLED messages
 * Ensures storage operations complete before forwarding to page script
 * @param {Object} message - The message object containing enabled state
 */
async function handleSetEnabled(message) {
  // Persist state (await to ensure completion)
  await chrome.storage.local.set({ inspectorEnabled: message.enabled });

  // Clear session artifacts on start (data + logs) - AWAIT completion to prevent race condition
  // This ensures old encoding data/logs are fully removed before collectors start emitting new data
  if (message.enabled) {
    await new Promise(resolve => {
      clearSessionData(() => {
        logContent('🧹 Cleared stale session data from storage');
        resolve();
      });
    });
  }

  // Add explicit log to storage
  persistLogs(createLog('Content', message.enabled ? '✅ Inspector started' : '⏸️ Inspector stopped'));

  // NOW forward enable/disable command to page script (after storage operations complete)
  window.postMessage({
    __audioPipelineInspector: true,
    type: 'SET_ENABLED',
    enabled: message.enabled
  }, '*');
}

// Listen for messages from popup (main frame only to prevent duplication)
if (window.self === window.top) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SET_ENABLED') {
      // Handle async operations - return true to keep channel open
      handleSetEnabled(message).then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        logContent(`❌ Error handling SET_ENABLED: ${error.message}`);
        sendResponse({ success: false, error: error.message });
      });
      return true;  // Keep message channel open for async response
    }
  });
} else {
  logContent(`⚠️ Running in iframe - message handling disabled`);
}

// Inject immediately (top frame only - prevents duplicate PageInspector instances & duplicate logs)
if (window.self === window.top) {
  injectPageScript();
} else {
  // Avoid injecting into iframes - top frame acts as single source of truth
  injected = true;
}
