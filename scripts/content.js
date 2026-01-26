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
let DATA_STORAGE_KEYS = ['rtc_stats', 'user_media', 'audio_contexts', 'audio_worklet', 'media_recorder', 'detected_encoder', 'audio_connections'];

// ═══════════════════════════════════════════════════════════════════════════════
// DRY HELPER: Detected Encoder data merge with null-safe field preservation
// OCP: Add new fields to ENCODER_MERGE_FIELDS array, no logic change needed
// ═══════════════════════════════════════════════════════════════════════════════
const ENCODER_MERGE_FIELDS = [
  'encoder', 'library', 'bitRate', 'channels', 'sampleRate', 'application',
  'applicationName', 'frameSize', 'processorName', 'originalSampleRate',
  'wavBitDepth', 'container', 'encoderPath', 'sessionId',
  'recordingDuration', 'calculatedBitRate', 'isLiveEstimate', 'mimeType', 'blobSize', 'status'
];

function mergeEncoderData(existing, payload) {
  const merged = { ...existing, ...payload };

  // Special: codec can come from 'codec' (preferred) or legacy 'type' field.
  // IMPORTANT: payload.type is usually the message type (e.g., "detectedEncoder") - never treat that as a codec.
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

// ═══════════════════════════════════════════════════════════════════
// IN-MEMORY INSPECTOR STATE FLAG (sync control for race condition prevention)
// This flag is updated SYNCHRONOUSLY when STOP command arrives
// Queue processing checks this flag BEFORE writing to storage
// ═══════════════════════════════════════════════════════════════════
let inspectorRunning = false;
let softResetScheduled = false; // SOFT reset ile detected_encoder reset log çakışmasını önler

function processAudioContextQueue() {
  if (isProcessingAudioContext || audioContextQueue.length === 0) return;

  // ═══════════════════════════════════════════════════════════════════
  // RACE CONDITION PREVENTION: Check if inspector is still enabled
  // Clears queue and aborts if inspector was stopped (prevents stale writes)
  // ═══════════════════════════════════════════════════════════════════
  chrome.storage.local.get(['inspectorEnabled'], (enabledResult) => {
    if (!enabledResult.inspectorEnabled) {
      // Inspector stopped - clear queue and abort
      const clearedCount = audioContextQueue.length;
      audioContextQueue.length = 0;
      isProcessingAudioContext = false;
      if (clearedCount > 0) {
        logContent(`🧹 Cleared ${clearedCount} queued items (inspector stopped)`);
      }
      return;
    }

    // Inspector still enabled - proceed with processing
    processAudioContextQueueInternal();
  });
}

function processAudioContextQueueInternal() {
  // ═══════════════════════════════════════════════════════════════════
  // SYNC CHECK: Abort if inspector stopped (race condition prevention)
  // This check runs BEFORE any async operation
  // ═══════════════════════════════════════════════════════════════════
  if (!inspectorRunning) {
    const clearedCount = audioContextQueue.length;
    audioContextQueue.length = 0;
    isProcessingAudioContext = false;
    if (clearedCount > 0) {
      logContent(`🧹 processAudioContextQueueInternal: Cleared ${clearedCount} items (inspector stopped)`);
    }
    return;
  }

  if (audioContextQueue.length === 0) {
    isProcessingAudioContext = false;
    return;
  }

  isProcessingAudioContext = true;
  const queueItem = audioContextQueue.shift();

  chrome.storage.local.get(['audio_contexts'], (result) => {
    // ═══════════════════════════════════════════════════════════════════
    // SECOND SYNC CHECK: Abort if inspector stopped during async get
    // This prevents writing stale data after STOP command
    // ═══════════════════════════════════════════════════════════════════
    if (!inspectorRunning) {
      const clearedCount = audioContextQueue.length;
      audioContextQueue.length = 0;
      isProcessingAudioContext = false;
      logContent(`🧹 processAudioContextQueueInternal: Aborted write (inspector stopped during async get)`);
      return;
    }
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
          // detectedEncoder root level'da kalır
          detectedEncoder: payload.detectedEncoder || existing.detectedEncoder
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
      // ═══════════════════════════════════════════════════════════════════
      // RACE CONDITION FIX: Abort if inspector stopped during async set
      // Set tamamlandı ama inspector artık durmuş - döngüyü durdur
      // ═══════════════════════════════════════════════════════════════════
      if (!inspectorRunning) {
        audioContextQueue.length = 0;
        isProcessingAudioContext = false;
        logContent('🧹 Queue processing aborted (inspector stopped during set)');
        return;  // Döngüyü durdur, processAudioContextQueue() çağırma
      }

      if (chrome.runtime.lastError) {
        persistLogs(createLog('Content', `❌ audioContext SET error: ${chrome.runtime.lastError.message}`, 'error'));
      } else if (!queueItem._isWorkletUpdate) {
        persistLogs(createLog('Content', `✅ audioContext SET: ${contexts.length} context(s)`));
      }

      isProcessingAudioContext = false;
      // Use main function to re-check inspectorEnabled before processing next
      processAudioContextQueue();
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
  user_media: storageHandler('user_media', '🎤', 'getUserMedia'),

  // Special handler for audio_contexts - uses queue to prevent race conditions
  audio_contexts: (payload) => {
    persistLogs(createLog('Content', `🔊 audio_contexts queued: id=${payload?.contextId}, rate=${payload?.static?.sampleRate}`));
    audioContextQueue.push({ ...payload, sourceTabId: currentTabId });
    processAudioContextQueue();
    return null; // Handled internally
  },

  media_recorder: storageHandler('media_recorder', '🎙️', 'MediaRecorder'),

  // CANONICAL: Tüm encoder tespitleri bu handler'dan geçer (WASM, PCM, native)
  // AudioContextCollector hem URL pattern hem opus hook için buraya emit eder
  // popup.js bu storage key'den okur (tek doğru kaynak)
  // MERGE STRATEGY: Zengin field'ları koru, null override'i engelle
  detected_encoder: (() => {
    // In-memory session tracking to prevent race condition between reset and encoder data
    // When reset arrives, we track the new sessionId so concurrent encoder events
    // from the OLD session don't merge with stale storage data
    let currentSessionId = null;

    return (payload) => {
      // ═══════════════════════════════════════════════════════════════════
      // SYNC CHECK: Abort if inspector stopped (race condition prevention)
      // Reset commands are still allowed (cleanup operation)
      // ═══════════════════════════════════════════════════════════════════
      if (!inspectorRunning && payload?.reset !== true) {
        logContent('🚫 detected_encoder ignored (inspector stopped)');
        return null;
      }

      const incomingSessionId = Number.isInteger(payload?.sessionId) ? payload.sessionId : null;

      // New recording session signal: clear stale encoder info
      if (payload?.reset === true) {
        // SOFT reset tarafından handle edilecekse skip et (log karmaşasını önler)
        if (softResetScheduled) {
          persistLogs(createLog('Content', `⏭️ Encoder reset skipped (SOFT reset will handle)`));
          return null;
        }

        // ═══════════════════════════════════════════════════════════════════
        // RACE CONDITION FIX: Delay reset to allow SIGNATURE_CHANGE processing
        //
        // Problem: postMessage sırası garantili FIFO
        //   1. detected_encoder (reset) - getUserMedia hook'ta emit
        //   2. SIGNATURE_CHANGE - createScriptProcessor hook'ta emit
        //
        // Ama content.js'de detected_encoder handler ÖNCE çalışıyor (inspectorRunning=true)
        // setTimeout ile geciktirerek SIGNATURE_CHANGE'in önce işlenmesini sağlıyoruz
        // ═══════════════════════════════════════════════════════════════════
        const resetSessionId = incomingSessionId; // Capture for closure

        // ═══════════════════════════════════════════════════════════════════
        // SESSION-AWARE RESET: Update session tracker IMMEDIATELY
        // This prevents the 100ms delayed reset from deleting NEW session data
        // Scenario: Reset scheduled → New recording starts → Reset fires → Deletes new data
        // Fix: Update currentSessionId NOW, check in setTimeout before deleting
        // ═══════════════════════════════════════════════════════════════════
        if (resetSessionId !== null) {
          currentSessionId = resetSessionId;
        }

        setTimeout(() => {
          // ═══════════════════════════════════════════════════════════════════
          // STALE RESET CHECK: Skip if session changed during 100ms delay
          // This prevents deleting encoder data from a NEWER session
          // Example: T+0ms reset(#1), T+20ms encoder(#2), T+100ms reset fires → skip
          // ═══════════════════════════════════════════════════════════════════
          if (currentSessionId !== resetSessionId) {
            persistLogs(createLog('Content', `⏭️ Stale reset ignored (session ${resetSessionId} → ${currentSessionId})`));
            return;
          }

          // ═══════════════════════════════════════════════════════════════════
          // ASYNC RACE CONDITION CHECK (Line 352'deki sync check'ten FARKLI)
          // - Line 352: Sync filtering (non-reset encoder data, inspector stopped ise)
          // - Bu kontrol: Async race condition (100ms window içinde stop edilebilir)
          // Inspector, setTimeout scheduling ile execution arasında stop edilebilir.
          // ═══════════════════════════════════════════════════════════════════
          if (!inspectorRunning) {
            persistLogs(createLog('Content', `⏭️ Encoder reset skipped (inspector stopped)`));
            return;
          }

          chrome.storage.local.remove(['detected_encoder'], () => {
            if (chrome.runtime.lastError) {
              persistLogs(createLog('Content', `❌ detected_encoder RESET error: ${chrome.runtime.lastError.message}`, 'error'));
            } else {
              persistLogs(createLog('Content', `🧹 detected_encoder cleared (session #${resetSessionId})`));
            }
          });
        }, 100); // 100ms - SIGNATURE_CHANGE processing için yeterli

        return null; // Hemen dön, gecikmiş reset arka planda çalışacak
      }

      // CRITICAL: If incoming session is older than our tracked session, ignore it
      // This prevents race condition where old encoder data arrives after reset
      if (currentSessionId !== null && incomingSessionId !== null && incomingSessionId < currentSessionId) {
        persistLogs(createLog('Content', `⏭️ Ignoring stale encoder (session ${incomingSessionId} < current ${currentSessionId})`));
        return null;
      }

      // Update session tracker if newer session
      if (incomingSessionId !== null && (currentSessionId === null || incomingSessionId > currentSessionId)) {
        currentSessionId = incomingSessionId;
      }

      chrome.storage.local.get(['detected_encoder'], (result) => {
        const existing = result.detected_encoder || null;
        const existingSessionId = Number.isInteger(existing?.sessionId) ? existing.sessionId : null;

        // Double-check: if storage has older session data, don't merge with it
        // This handles the case where reset's remove() hasn't completed yet
        const shouldMerge = existingSessionId === null ||
                           incomingSessionId === null ||
                           existingSessionId === incomingSessionId;

        const merged = shouldMerge
          ? mergeEncoderData(existing || {}, payload)
          : { ...payload }; // Fresh start, no merge with stale data

        if (incomingSessionId !== null) {
          merged.sessionId = incomingSessionId;
        }

        chrome.storage.local.set({
          detected_encoder: { ...merged, sourceTabId: currentTabId },
          lastUpdate: Date.now()
        }, () => {
          // ═══════════════════════════════════════════════════════════════════
          // RACE CONDITION PROTECTION: Abort if stopped during async operation
          // Prevents stale encoder data from being logged after technology change
          // ═══════════════════════════════════════════════════════════════════
          if (!inspectorRunning) {
            logContent(`🚫 Encoder write completed but inspector stopped (async race)`);
            return;
          }

          if (chrome.runtime.lastError) {
            persistLogs(createLog('Content', `❌ detected_encoder SET error: ${chrome.runtime.lastError.message}`, 'error'));
          } else {
            const mergeInfo = shouldMerge && existing?.source
              ? ` (merged with ${existing.source})`
              : ' (fresh)';
            persistLogs(createLog('Content', `🔧 Encoder stored: ${payload.source}${mergeInfo}`));
          }
        });
      });

      return null; // Handled internally
    };
  })(),

  // Special handler for audio_worklet - uses queue to prevent race conditions with audio_contexts
  // NOTE: AudioContextCollector already handles worklets with proper context matching
  // This handler receives worklets and queues them for merge into audio_contexts
  audio_worklet: (payload) => {
    persistLogs(createLog('Content', `🎛️ audio_worklet queued: contextId=${payload?.contextId}, url=${payload?.moduleUrl}`));

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
  audio_connections: (payload) => {
    // ═══════════════════════════════════════════════════════════════════
    // SYNC CHECK: Abort if inspector stopped (race condition prevention)
    // Clear commands (isClear) are still allowed for cleanup
    // ═══════════════════════════════════════════════════════════════════
    if (!inspectorRunning && !payload?.isClear) {
      logContent(`🚫 audio_connections ignored (inspector stopped)`);
      return null;
    }

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
                   logContent('📥 Received START from background');

                   // Refresh/navigation/session restore: always start with a clean session (data + logs)
                   clearSessionData(() => {
                       persistLogs(createLog('Content', 'Background decision: START'));
                       logContent('🧹 Cleared stale session data before restore');
                       window.postMessage({
                           __audioPipelineInspector: true,
                           type: 'SET_ENABLED',
                          enabled: true
                      }, '*');
                      // Set flag AFTER SET_ENABLED sent - prevents premature queue processing
                      inspectorRunning = true;
                      logContent('✅ inspectorRunning = true (after SET_ENABLED)');
                  });
                  break;

               case 'STOP':
                   // Set flag FIRST (sync) - blocks queue processing
                   inspectorRunning = false;
                   logContent('🛑 inspectorRunning = false (background STOP)');

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

                   // Notify early-inject.js if another tab is locked (prevents unnecessary capture)
                   if (response.isOtherTabLocked) {
                       window.postMessage({
                           __audioPipelineInspector: true,
                           type: 'SET_TAB_LOCKED_ELSEWHERE',
                           locked: true
                       }, '*');
                       logContent('🔒 Another tab is locked - capture disabled');
                   }
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

  // ═══════════════════════════════════════════════════════════════════
  // SINGLE SOURCE OF TRUTH: Recording state from early-inject.js
  // This is the ONLY reliable indicator of active recording
  // Used by popup's PendingWebAudio detector instead of complex heuristics
  // ═══════════════════════════════════════════════════════════════════
  if (event.data.type === 'RECORDING_STATE') {
    const { active, timestamp } = event.data.payload || {};
    chrome.storage.local.set({
      recording_active: {
        active: active === true,
        timestamp: timestamp || Date.now(),
        sourceTabId: currentTabId
      },
      lastUpdate: Date.now()
    }, () => {
      persistLogs(createLog('Content', `🎬 Recording state: ${active ? 'ACTIVE' : 'STOPPED'}`));
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // SIGNATURE CHANGE: Technology change detection for smart session reset
  // Triggered by early-inject.js when audio path signature changes
  // - HARD reset: Technology changed (ScriptProcessor → AudioWorklet)
  // - SOFT reset: Same tech, new recording (only encoder data cleared)
  // ═══════════════════════════════════════════════════════════════════
  if (event.data.type === 'SIGNATURE_CHANGE') {
    const { resetType, sessionId, signature, previousSignature } = event.data.payload || {};

    if (resetType === 'hard') {
      // ═══════════════════════════════════════════════════════════════════
      // HARD RESET: Technology changed - STOP inspector, user must restart
      // UI shows "Stopped" with banner, lockedTab preserved for data review
      // inspectorRunning flag set FIRST (sync) to block in-flight queue processing
      // ═══════════════════════════════════════════════════════════════════
      const prevPath = previousSignature?.processingPath || 'unknown';
      const newPath = signature?.processingPath || 'unknown';
      persistLogs(createLog('Content', `🔄 Technology change: ${prevPath} → ${newPath} (session #${sessionId})`));

      // 0. SET FLAG FIRST (sync) - blocks any in-flight queue processing
      inspectorRunning = false;
      logContent('🛑 inspectorRunning = false (technology change, sync)');

      // 1. IMMEDIATELY disable hooks (race condition prevention)
      window.postMessage({
        __audioPipelineInspector: true,
        type: 'DISABLE_HOOKS'
      }, '*');

      // 2. Clear pending queue (stale data)
      const clearedCount = audioContextQueue.length;
      audioContextQueue.length = 0;
      if (clearedCount > 0) {
        logContent(`🧹 Cleared ${clearedCount} queued items on technology change`);
      }

      // 3. DON'T clear storage - data should be preserved for review
      // User can view old session data until they manually restart
      logContent('📦 Storage preserved (technology change - data kept for review)');

      // 4. STOP collectors (PageInspector stops, earlyCaptures cleared)
      window.postMessage({
        __audioPipelineInspector: true,
        type: 'SET_ENABLED',
        enabled: false
      }, '*');

      // 5. Merkezi stop: lockedTab korunur, eski veriler UI'da görünür
      chrome.runtime.sendMessage({ type: 'STOP_INSPECTOR', reason: 'technology_change' }, () => {
        persistLogs(createLog('Content', `⏹️ Inspector stopped due to technology change (data preserved)`));
      });
      // NO RESTART - user must manually press Start
    } else if (resetType === 'soft') {
      // SOFT RESET: Same technology, new recording - only clear encoder data
      // Flag set: detected_encoder reset handler'ı skip edecek (log karmaşasını önler)
      softResetScheduled = true;

      chrome.storage.local.remove(['detected_encoder'], () => {
        softResetScheduled = false; // Flag temizle - sonraki normal reset'ler çalışabilsin

        if (chrome.runtime.lastError) {
          persistLogs(createLog('Content', `❌ SOFT reset error: ${chrome.runtime.lastError.message}`, 'error'));
        } else {
          persistLogs(createLog('Content', `🔃 SOFT reset: encoder cleared (session #${sessionId})`));
        }

        // Forward to page script for collector reset
        window.postMessage({
          __audioPipelineInspector: true,
          type: 'COLLECTOR_RESET',
          payload: { resetType: 'soft', sessionId }
        }, '*');
      });
    }
    // 'none' type doesn't need any action
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
  // ═══════════════════════════════════════════════════════════════════
  // STOP PATH: Immediate hook disable + queue cleanup (race condition fix)
  // DISABLE_HOOKS is sent BEFORE SET_ENABLED to ensure hooks stop immediately
  // inspectorRunning flag is set FIRST (sync) to block any in-flight queue processing
  // ═══════════════════════════════════════════════════════════════════
  if (!message.enabled) {
    // 0. SET FLAG FIRST (sync) - blocks any in-flight queue processing
    inspectorRunning = false;
    logContent('🛑 inspectorRunning = false (sync)');

    // 1. IMMEDIATELY disable hooks in page script (before any async operations)
    window.postMessage({
      __audioPipelineInspector: true,
      type: 'DISABLE_HOOKS'
    }, '*');

    // 2. Clear pending queue items (stale data from hooks that were in-flight)
    const clearedCount = audioContextQueue.length;
    audioContextQueue.length = 0;
    if (clearedCount > 0) {
      logContent(`🧹 Cleared ${clearedCount} queued items on STOP`);
    }

    // 3. Update storage state
    await chrome.storage.local.set({ inspectorEnabled: false });

    // 4. Add log and forward stop command
    persistLogs(createLog('Content', '⏸️ Inspector stopped'));
    window.postMessage({
      __audioPipelineInspector: true,
      type: 'SET_ENABLED',
      enabled: false
    }, '*');
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // START PATH: Clear stale data, then enable
  // TIMING: Same as INSPECTOR_READY START handler for consistency
  // 1. Clear session data
  // 2. Send SET_ENABLED to page script
  // 3. Set inspectorRunning = true (AFTER data cleared)
  // This prevents queue processing from writing data WHILE clearSessionData runs
  // ═══════════════════════════════════════════════════════════════════

  // Persist state first (await to ensure completion)
  await chrome.storage.local.set({ inspectorEnabled: message.enabled });

  // Clear session artifacts on start (data + logs) - AWAIT completion to prevent race condition
  // This ensures old encoding data/logs are fully removed before collectors start emitting new data
  await new Promise(resolve => {
    clearSessionData(() => {
      logContent('🧹 Cleared stale session data from storage');
      resolve();
    });
  });

  // Add explicit log to storage
  persistLogs(createLog('Content', '✅ Inspector started'));

  // NOW forward enable command to page script (after storage operations complete)
  window.postMessage({
    __audioPipelineInspector: true,
    type: 'SET_ENABLED',
    enabled: true
  }, '*');

  // Set flag AFTER SET_ENABLED sent and data cleared - prevents premature queue processing
  // This matches INSPECTOR_READY START handler timing for consistency
  inspectorRunning = true;
  logContent('✅ inspectorRunning = true (after clearSessionData)');
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

// ═══════════════════════════════════════════════════════════════════
// STORAGE LISTENER: Watch for lockedTab changes
// When another tab's lock is released, enable capture in this tab
// ═══════════════════════════════════════════════════════════════════
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // lockedTab changed - check if lock was released
  if (changes.lockedTab) {
    const newLockedTab = changes.lockedTab.newValue;
    const oldLockedTab = changes.lockedTab.oldValue;

    // Lock released (lockedTab removed or changed to different tab)
    if (!newLockedTab || (oldLockedTab && newLockedTab.id !== oldLockedTab.id)) {
      // If we were locked out before, now we're free to capture
      window.postMessage({
        __audioPipelineInspector: true,
        type: 'SET_TAB_LOCKED_ELSEWHERE',
        locked: false
      }, '*');
      logContent('🔓 Tab lock released - capture enabled');
    }
  }
});
