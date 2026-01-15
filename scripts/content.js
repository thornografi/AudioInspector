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

// Measurement data storage keys
// SOURCE OF TRUTH: src/core/constants.js → DATA_STORAGE_KEYS
// (Duplicated here because content.js cannot import ES modules)
const DATA_STORAGE_KEYS = ['rtc_stats', 'user_media', 'audio_contexts', 'audio_worklet', 'media_recorder', 'wasm_encoder'];

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
          pipeline: {
            ...existing.pipeline,
            ...payload.pipeline,
            processors: payload.pipeline?.processors?.length > 0
              ? payload.pipeline.processors
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
      const existing = result.wasm_encoder || {};

      // Merge: yeni veri önde, ama null'lar eskiyi korur
      const merged = {
        ...existing,
        ...payload,
        // Zengin field'ları koru (source: 'direct' genelde daha detaylı)
        bitRate: payload.bitRate ?? existing.bitRate,
        channels: payload.channels ?? existing.channels,
        sampleRate: payload.sampleRate ?? existing.sampleRate,
        application: payload.application ?? existing.application,
        // Source priority: 'direct' > 'audioworklet' (daha fazla detay içerir)
        source: payload.source === 'direct' ? 'direct' : (existing.source || payload.source)
      };

      chrome.storage.local.set({
        wasm_encoder: { ...merged, sourceTabId: currentTabId },
        lastUpdate: Date.now()
      }, () => {
        if (chrome.runtime.lastError) {
          persistLogs(createLog('Content', `❌ wasm_encoder SET error: ${chrome.runtime.lastError.message}`, 'error'));
        } else {
          const sourceInfo = payload.source === existing.source ? payload.source : `${payload.source} (merged with ${existing.source || 'none'})`;
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
  
  // Handle INSPECTOR_READY - restore state if needed (with tab lock check)
  if (event.data.type === 'INSPECTOR_READY') {
      chrome.storage.local.get(['inspectorEnabled', 'lockedTab'], (result) => {
          if (result.inspectorEnabled === true && result.lockedTab) {
              // currentTabId zaten injection'da senkron olarak alındı (line 50)
              // Async GET_TAB_ID çağrısına gerek yok - DRY prensibi
              const thisTabId = currentTabId;
              const lockedTabId = result.lockedTab.id;
              const thisOrigin = window.location.origin;
              let lockedOrigin;
              try {
                  lockedOrigin = new URL(result.lockedTab.url).origin;
              } catch {
                  lockedOrigin = null;
              }

              // Debug log - tab ID ve origin karşılaştırması
              logContent(`Tab check: current=${thisTabId}, locked=${lockedTabId}, origins: ${thisOrigin} vs ${lockedOrigin}`);
              persistLogs(createLog('Content', `Tab check: current=${thisTabId}, locked=${lockedTabId}`));

              // Tab ID kontrolü
              if (thisTabId !== lockedTabId) {
                  // Farklı tab, başlatma
                  logContent('Inspector active but this tab is not locked (not starting)');
                  persistLogs(createLog('Content', `Different tab (${thisTabId} != ${lockedTabId}) - not starting`));
                  return;
              }

              // Origin kontrolü - aynı tab'da farklı siteye gidilmiş olabilir
              if (thisOrigin !== lockedOrigin) {
                  logContent(`Same tab but different origin: ${thisOrigin} vs ${lockedOrigin} (auto-stopping)`);
                  persistLogs(createLog('Content', `Origin changed (${thisOrigin}) - inspector auto-stopped`));

                  // Auto-stop: Set reason flag first, then clear inspector state AND measurement data
                  chrome.storage.local.set({ autoStoppedReason: 'origin_change' }, () => {
                      chrome.storage.local.remove(['inspectorEnabled', 'lockedTab', ...DATA_STORAGE_KEYS], () => {
                          logContent('🛑 Inspector auto-stopped due to origin change (state + data cleared)');
                      });
                  });
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

    // Helper to create storage data object (DRY)
    const createDataToStore = () => ({
      [key]: { ...payload, sourceTabId: currentTabId },
      lastUpdate: Date.now()
    });

    // Check if new recording started - clear all audio data first
    if (payload.resetData) {
      chrome.storage.local.remove(DATA_STORAGE_KEYS, () => {
        logContent('🧹 New recording started - cleared all audio data');

        logContent(logMsg, logData || payload);
        chrome.storage.local.set(createDataToStore());

        // Signal collectors to re-emit their current data
        window.postMessage({
          __audioPipelineInspector: true,
          type: 'RE_EMIT_ALL'
        }, '*');
        logContent('📤 Sent RE_EMIT_ALL signal to collectors');
      });
      return; // Early return - async callback handles the rest
    }

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

  // Clear all data storage on start - AWAIT completion to prevent race condition
  // This ensures old encoding data is fully removed before collectors start emitting new data
  if (message.enabled) {
    await new Promise(resolve => {
      chrome.storage.local.remove(DATA_STORAGE_KEYS, () => {
        logContent('🧹 Cleared stale data from storage');
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

// Inject immediately
injectPageScript();
