// Early Inject - MAIN world content script
// Runs BEFORE any page scripts to capture API calls
// This is the fastest possible hook injection method in Manifest V3

(function() {
  'use strict';

  // Prevent double injection
  if (window.__audioInspectorEarlyHooksInstalled) return;
  window.__audioInspectorEarlyHooksInstalled = true;

  // ═══════════════════════════════════════════════════════════════════
  // GLOBAL INSPECTOR STATE FLAG
  // Used to immediately disable hooks when inspector stops
  // Prevents race condition where hooks continue firing after STOP
  // ═══════════════════════════════════════════════════════════════════
  window.__audioInspectorEnabled = false;

  // ═══════════════════════════════════════════════════════════════════
  // TAB LOCK FLAG: Skip capture when another tab is locked
  // Prevents memory waste from capturing data in inactive tabs
  // ═══════════════════════════════════════════════════════════════════
  window.__otherTabLocked = false;

  // ═══════════════════════════════════════════════════════════════════
  // Debug Log Helper - Sends logs to extension's console panel
  // ═══════════════════════════════════════════════════════════════════
  const debugLog = (message, data = null) => {
    // Console log (DevTools)
    if (data) {
      console.log(`[AudioInspector] Early: ${message}`, data);
    } else {
      console.log(`[AudioInspector] Early: ${message}`);
    }
    // Send to extension console panel via postMessage
    window.postMessage({
      __audioPipelineInspector: true,
      type: 'DEBUG_LOG',
      payload: {
        prefix: 'Early',
        message: data ? `${message}: ${typeof data === 'string' ? data : JSON.stringify(data).substring(0, 200)}` : message,
        timestamp: Date.now()
      }
    }, '*');
  };

  // ═══════════════════════════════════════════════════════════════════
  // Console Forwarding (DevTools logs → UI Console drawer)
  // Enabled only when inspector is running (SET_ENABLED=true).
  // ═══════════════════════════════════════════════════════════════════
  let forwardConsoleEnabled = false;
  let isForwarding = false;
  const originalConsole = {
    log: console.log.bind(console),
    info: (console.info || console.log).bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: (console.debug || console.log).bind(console)
  };

  const safeStringify = (value) => {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      return JSON.stringify(value);
    } catch {
      try {
        return String(value);
      } catch {
        return '[unstringifiable]';
      }
    }
  };

  const formatConsoleArgs = (args) => {
    const parts = [];
    for (let i = 0; i < args.length; i += 1) {
      parts.push(safeStringify(args[i]));
    }
    const joined = parts.join(' ');
    // Keep UI lightweight; avoid megabyte logs.
    return joined.length > 800 ? `${joined.slice(0, 800)}…` : joined;
  };

  const forwardConsole = (level, args) => {
    if (!forwardConsoleEnabled) return;
    if (isForwarding) return;
    isForwarding = true;
    try {
      const message = formatConsoleArgs(args);
      if (!message) return;

      window.postMessage({
        __audioPipelineInspector: true,
        type: 'DEBUG_LOG',
        payload: {
          prefix: 'Console',
          level,
          message,
          timestamp: Date.now()
        }
      }, '*');
    } catch {
      // Never break the page due to logging.
    } finally {
      isForwarding = false;
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // SINGLE SOURCE OF TRUTH: Broadcast recording state changes to storage
  // This is the ONLY reliable way to know if recording is active
  // ═══════════════════════════════════════════════════════════════════
  const broadcastRecordingState = (active) => {
    window.postMessage({
      __audioPipelineInspector: true,
      type: 'RECORDING_STATE',
      payload: {
        active: active,
        timestamp: Date.now()
      }
    }, '*');
  };

  // ═══════════════════════════════════════════════════════════════════
  // DRY Helper: Check if createMediaStreamSource should trigger PCM/WAV recording
  // Called from both AudioContext instance hook and prototype hook
  // ═══════════════════════════════════════════════════════════════════
  const tryBroadcastPcmRecordingStart = (stream, logPrefix = 'Early') => {
    if (!stream) return;

    const isMicrophoneStream = window.__earlyCaptures?.getUserMedia?.some(
      gum => gum.stream?.id === stream.id
    );
    const hasMediaRecorder = window.__earlyCaptures?.mediaRecorders?.length > 0;

    // PCM/WAV path: Microphone connected to AudioContext, no MediaRecorder
    // IMPORTANT: Only broadcast if NOT already active (prevents duplicate broadcasts)
    if (isMicrophoneStream && !window.__recordingState?.active && !hasMediaRecorder) {
      broadcastRecordingState(true);
      console.log(`[AudioInspector] ${logPrefix}: Microphone connected (PCM/WAV path) - recording state: ACTIVE`);
    }
  };

  const installConsoleForwarding = () => {
    if (console.__audioInspectorForwardingInstalled) return;
    console.__audioInspectorForwardingInstalled = true;

    console.log = (...args) => {
      originalConsole.log(...args);
      forwardConsole('info', args);
    };
    console.info = (...args) => {
      originalConsole.info(...args);
      forwardConsole('info', args);
    };
    console.warn = (...args) => {
      originalConsole.warn(...args);
      forwardConsole('warn', args);
    };
    console.error = (...args) => {
      originalConsole.error(...args);
      forwardConsole('error', args);
    };
    console.debug = (...args) => {
      originalConsole.debug(...args);
      forwardConsole('info', args);
    };
  };

  // ═══════════════════════════════════════════════════════════════════
  // INSPECTOR STATE CONTROL: Handle SET_ENABLED and DISABLE_HOOKS
  // SET_ENABLED: Normal start/stop from popup or background
  // DISABLE_HOOKS: Immediate hook disable (race condition prevention)
  // ═══════════════════════════════════════════════════════════════════
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data?.__audioPipelineInspector) return;

    // DISABLE_HOOKS: Immediate disable, no other processing
    // This is sent BEFORE SET_ENABLED=false to prevent hook race condition
    if (event.data.type === 'DISABLE_HOOKS') {
      window.__audioInspectorEnabled = false;
      debugLog('Hooks disabled immediately (DISABLE_HOOKS)');
      return;
    }

    // SET_TAB_LOCKED_ELSEWHERE: Another tab is locked - skip capture
    // Prevents memory waste from capturing data in inactive tabs
    if (event.data.type === 'SET_TAB_LOCKED_ELSEWHERE') {
      window.__otherTabLocked = event.data.locked === true;
      debugLog(`Tab lock status: ${window.__otherTabLocked ? 'OTHER_TAB_LOCKED' : 'NOT_LOCKED'}`);
      return;
    }

    // SET_ENABLED: Normal inspector start/stop
    if (event.data.type === 'SET_ENABLED') {
      window.__audioInspectorEnabled = event.data.enabled === true;
      forwardConsoleEnabled = event.data.enabled === true;

      if (forwardConsoleEnabled) {
        installConsoleForwarding();
      }

      debugLog(`Inspector state: ${window.__audioInspectorEnabled ? 'ENABLED' : 'DISABLED'}`);
    }
  });

  // Registry for early-captured calls (before full inspector loads)
  // NOTE: Use clearEarlyCaptures() to reset on stop (prevents memory leak)
  window.__earlyCaptures = {
    getUserMedia: [],      // { stream, constraints, timestamp }
    audioContexts: [],     // { instance, timestamp, sampleRate, state }
    rtcPeerConnections: [], // { instance, timestamp }
    mediaRecorders: [],    // { instance, timestamp }
    workers: [],           // { instance, url, timestamp, isEncoder }
    connections: []        // { sourceType, sourceId, destType, destId, timestamp }
  };

  // ═══════════════════════════════════════════════════════════════════
  // AUDIO PATH SIGNATURE: Technology detection for session reset logic
  // Tracks processingPath, encodingType, outputPath to detect tech changes
  // ═══════════════════════════════════════════════════════════════════
  window.__audioSignatures = {
    previous: null,
    current: null
  };

  // ═══════════════════════════════════════════════════════════════════
  // SESSION-SCOPED SIGNATURE CHECK FLAG
  // Ensures signature is checked only once per recording session
  // Reset on: recording stop, getUserMedia (new session)
  // ═══════════════════════════════════════════════════════════════════
  let signatureCheckedThisSession = false;

  /**
   * Calculate current audio path signature from early captures
   * @returns {{processingPath: string, encodingType: string, outputPath: string}|null}
   */
  const calculateCurrentSignature = () => {
    const earlyCaptures = window.__earlyCaptures;
    if (!earlyCaptures) return null;

    // Check for AudioWorklet nodes (peak-worklet, opus-encoder, etc.)
    const hasWorklet = earlyCaptures.audioWorkletNodes?.length > 0;

    // Check for ScriptProcessor in any AudioContext's methodCalls
    const hasScriptProcessor = earlyCaptures.audioContexts?.some(ctx =>
      ctx.methodCalls?.some(m => m.type === 'scriptProcessor')
    );

    // Determine processing path
    let processingPath = 'none';
    if (hasWorklet) {
      processingPath = 'audioWorklet';
    } else if (hasScriptProcessor) {
      processingPath = 'scriptProcessor';
    }

    // Check for MediaRecorder (browser native encoding)
    const hasMediaRecorder = earlyCaptures.mediaRecorders?.length > 0;

    // Check for WASM encoder workers
    const hasWasmWorker = earlyCaptures.workers?.some(w => w.isEncoder);

    // Check for encoder AudioWorklet (opus-encoder, mp3-encoder, etc.)
    const hasEncoderWorklet = earlyCaptures.audioWorkletNodes?.some(n => {
      const name = (n.processorName || '').toLowerCase();
      return name.includes('encoder') || name.includes('opus') || name.includes('mp3') ||
             name.includes('aac') || name.includes('vorbis') || name.includes('flac');
    });

    // Determine encoding type
    let encodingType = 'browser_native';
    if (hasEncoderWorklet) {
      encodingType = 'wasm_audioworklet';
    } else if (hasWasmWorker) {
      encodingType = 'wasm_worker';
    } else if (hasMediaRecorder) {
      encodingType = 'browser_native';
    }

    // Check for MediaStreamDestination (output to stream instead of speakers)
    const hasMediaStreamDest = earlyCaptures.audioContexts?.some(ctx =>
      ctx.methodCalls?.some(m => m.type === 'mediaStreamDestination')
    );

    // Also check connections for MediaStreamAudioDestination
    const hasMediaStreamDestConnection = earlyCaptures.connections?.some(c =>
      c.destType === 'MediaStreamAudioDestination'
    );

    // Determine output path
    const outputPath = (hasMediaStreamDest || hasMediaStreamDestConnection)
      ? 'mediaStreamDestination'
      : 'speakers';

    return {
      processingPath,
      encodingType,
      outputPath
    };
  };

  /**
   * Compare two signatures and determine reset type
   * @param {Object|null} previous
   * @param {Object|null} current
   * @returns {'hard' | 'soft' | 'none'}
   */
  const determineResetType = (previous, current) => {
    // First recording - no reset needed, just store signature
    if (!previous) return 'none';

    // No current signature (shouldn't happen, but handle gracefully)
    if (!current) return 'none';

    // Check for technology changes (HARD reset)
    if (previous.processingPath !== current.processingPath ||
        previous.encodingType !== current.encodingType ||
        previous.outputPath !== current.outputPath) {
      return 'hard';
    }

    // Same technology, new recording (SOFT reset - only encoder)
    return 'soft';
  };

  /**
   * Broadcast signature change to content.js for session management
   * @param {'hard' | 'soft' | 'none'} resetType
   */
  const broadcastSignatureChange = (resetType) => {
    const sessionId = window.__recordingState?.sessionCount || 0;

    window.postMessage({
      __audioPipelineInspector: true,
      type: 'SIGNATURE_CHANGE',
      payload: {
        resetType,
        signature: window.__audioSignatures.current,
        previousSignature: window.__audioSignatures.previous,
        sessionId,
        timestamp: Date.now()
      }
    }, '*');

    debugLog(`Signature change: ${resetType}`, {
      previous: window.__audioSignatures.previous,
      current: window.__audioSignatures.current,
      sessionId
    });
  };

  /**
   * Check for signature change and broadcast if detected (EARLY CHECK)
   * Called from critical hooks BEFORE destination connect
   * Enables early detection of technology changes
   * @param {string} trigger - Hook name for debugging
   * @returns {boolean} - True if hard reset was triggered
   */
  const checkSignatureChange = (trigger) => {
    // Already checked this session (prevents multiple broadcasts)
    if (signatureCheckedThisSession) return false;

    // Need previous signature for comparison
    if (!window.__audioSignatures.previous) return false;

    // Calculate current signature from earlyCaptures
    const newSignature = calculateCurrentSignature();
    if (!newSignature) return false;

    // Compare with previous
    const resetType = determineResetType(
      window.__audioSignatures.previous,
      newSignature
    );

    if (resetType === 'hard') {
      signatureCheckedThisSession = true;

      debugLog(`Early signature check (${trigger})`, {
        previous: window.__audioSignatures.previous,
        current: newSignature,
        trigger
      });

      // Update current signature BEFORE broadcast (so broadcastSignatureChange reads correct value)
      window.__audioSignatures.current = newSignature;

      // Now broadcast HARD reset
      broadcastSignatureChange('hard');

      return true;
    }

    return false;
  };

  /**
   * Check signature and broadcast if technology changed
   * Called at recording start (getUserMedia, MediaRecorder.start)
   */
  const checkAndBroadcastSignature = () => {
    // Calculate current signature
    const newSignature = calculateCurrentSignature();

    // Store previous and update current
    window.__audioSignatures.previous = window.__audioSignatures.current;
    window.__audioSignatures.current = newSignature;

    // Determine reset type
    const resetType = determineResetType(
      window.__audioSignatures.previous,
      newSignature
    );

    // Broadcast if any reset is needed
    if (resetType !== 'none') {
      broadcastSignatureChange(resetType);
    }
  };

  // Shared AudioContext ID map (used by page.js collectors and audio graph)
  const getContextIdMap = () => {
    const existing = window.__audioInspectorContextIdMap;
    if (existing && typeof existing.get === 'function' && typeof existing.set === 'function') {
      return existing;
    }
    const map = new WeakMap();
    window.__audioInspectorContextIdMap = map;
    return map;
  };

  const getNextContextId = () => {
    const current = Number.isInteger(window.__audioInspectorContextIdCounter)
      ? window.__audioInspectorContextIdCounter
      : 0;
    const next = current + 1;
    window.__audioInspectorContextIdCounter = next;
    return `ctx_${next}`;
  };

  const getOrAssignContextId = (ctx) => {
    if (!ctx) return null;
    const map = getContextIdMap();
    let id = map.get(ctx);
    if (!id) {
      id = getNextContextId();
      map.set(ctx, id);
    }
    return id;
  };

  /**
   * Clear early captures registry to prevent memory leak
   * Called by PageInspector.stop() via global handler
   * Preserves hooks but resets captured data
   */
  window.__clearEarlyCaptures = function() {
    window.__earlyCaptures.getUserMedia = [];
    window.__earlyCaptures.audioContexts = [];
    window.__earlyCaptures.rtcPeerConnections = [];
    window.__earlyCaptures.mediaRecorders = [];
    window.__earlyCaptures.workers = [];
    window.__earlyCaptures.connections = [];
    window.__earlyCaptures.audioWorkletNodes = [];

    // Preserve previous signature for technology change detection across sessions
    // Only clear current - previous is needed to detect tech changes after restart
    if (window.__audioSignatures.current) {
      window.__audioSignatures.previous = window.__audioSignatures.current;
    }
    window.__audioSignatures.current = null;

    // Reset session-scoped signature check flag
    signatureCheckedThisSession = false;

    console.log('[AudioInspector] Early: Registry cleared (previous signature preserved)');
  };

  // ═══════════════════════════════════════════════════════════════════
  // Connection Status Helper - DRY filter for active connections
  // Supports: 'connect' action AND legacy connections without action field
  // ═══════════════════════════════════════════════════════════════════
  const isActiveConnection = (c) => c.action === 'connect' || !c.action;

  // ═══════════════════════════════════════════════════════════════════
  // findEncodingScriptProcessor - Heuristic to find which SP is encoding
  // Used when Worker→ScriptProcessor direct connection is unavailable
  // Returns: { nodeId: string, confidence: 'high'|'medium'|'low' } | null
  // ═══════════════════════════════════════════════════════════════════
  window.__findEncodingScriptProcessor = function(contextId = null) {
    const connections = window.__earlyCaptures?.connections || [];
    if (connections.length === 0) return null;

    // Filter connections by contextId if provided
    const ctxConnections = contextId
      ? connections.filter(c => c.contextId === contextId)
      : connections;

    // Find all ScriptProcessor connections (active only)
    const spConnections = ctxConnections.filter(c =>
      c.sourceType === 'ScriptProcessor' && isActiveConnection(c)
    );

    if (spConnections.length === 0) return null;

    // ───────────────────────────────────────────────────────────────────
    // Strategy 1: SP → MediaStreamAudioDestination (HIGH CONFIDENCE)
    // If a ScriptProcessor connects to MediaStreamAudioDestination,
    // it's almost certainly for encoding (sending audio to a Worker/Blob)
    // ───────────────────────────────────────────────────────────────────
    const spToStreamDest = spConnections.filter(c =>
      c.destType === 'MediaStreamAudioDestination'
    );
    if (spToStreamDest.length === 1) {
      return { nodeId: spToStreamDest[0].sourceId, confidence: 'high' };
    }
    // Multiple SP→MediaStreamDest is rare, take the most recent one
    if (spToStreamDest.length > 1) {
      const sorted = [...spToStreamDest].sort((a, b) => b.timestamp - a.timestamp);
      return { nodeId: sorted[0].sourceId, confidence: 'high' };
    }

    // ───────────────────────────────────────────────────────────────────
    // Strategy 2: Elimination - SP NOT connected to Speakers (MEDIUM)
    // Speakers connection = playback/monitoring, not encoding
    // ───────────────────────────────────────────────────────────────────
    const speakerConnectedSPs = new Set(
      spConnections
        .filter(c => c.destType === 'AudioDestination')
        .map(c => c.sourceId)
    );

    const nonSpeakerSPs = spConnections
      .map(c => c.sourceId)
      .filter(id => !speakerConnectedSPs.has(id));

    // Unique non-speaker SP nodeIds
    const uniqueNonSpeakerSPs = [...new Set(nonSpeakerSPs)];

    if (uniqueNonSpeakerSPs.length === 1) {
      return { nodeId: uniqueNonSpeakerSPs[0], confidence: 'medium' };
    }

    // ───────────────────────────────────────────────────────────────────
    // Strategy 3: Single SP (MEDIUM)
    // If there's only one ScriptProcessor, it's likely the encoder
    // ───────────────────────────────────────────────────────────────────
    const uniqueSPIds = [...new Set(spConnections.map(c => c.sourceId))];
    if (uniqueSPIds.length === 1) {
      return { nodeId: uniqueSPIds[0], confidence: 'medium' };
    }

    // ───────────────────────────────────────────────────────────────────
    // Strategy 4: Multiple SPs, can't determine (LOW)
    // Return the first one with low confidence
    // ───────────────────────────────────────────────────────────────────
    if (uniqueSPIds.length > 1) {
      return { nodeId: uniqueSPIds[0], confidence: 'low' };
    }

    return null;
  };

  // ═══════════════════════════════════════════════════════════════════
  // findEncodingAudioWorklet - Heuristic for passthrough/WAV AudioWorklets
  // Used when port.postMessage() is never called (no init message)
  // Returns: { nodeId: string, processorName: string, confidence: 'high'|'medium'|'low' } | null
  // ═══════════════════════════════════════════════════════════════════
  window.__findEncodingAudioWorklet = function(contextId = null) {
    const workletNodes = window.__earlyCaptures?.audioWorkletNodes || [];
    const connections = window.__earlyCaptures?.connections || [];

    if (workletNodes.length === 0) return null;

    // Filter by contextId if provided
    const ctxWorklets = contextId
      ? workletNodes.filter(w => {
          // Match via contextId stored during capture
          return w.contextId === contextId;
        })
      : workletNodes;

    if (ctxWorklets.length === 0) return null;

    // ─────────────────────────────────────────────────────────────────
    // Strategy 1: AudioWorklet → MediaStreamAudioDestination (HIGH)
    // If AudioWorklet connects to MediaStreamAudioDestination,
    // it's in the encoding path (sending audio to Worker/Blob)
    // ─────────────────────────────────────────────────────────────────
    const workletToStreamDest = connections.filter(c =>
      c.sourceType === 'AudioWorklet' &&
      c.destType === 'MediaStreamAudioDestination' &&
      isActiveConnection(c)
    );

    if (workletToStreamDest.length > 0) {
      const match = ctxWorklets.find(w => {
        const nodeId = w.nodeId || w.instance?.__nodeId;
        return workletToStreamDest.some(c => c.sourceId === nodeId);
      });
      if (match) {
        return {
          nodeId: match.nodeId || match.instance?.__nodeId,
          processorName: match.processorName,
          confidence: 'high'
        };
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Strategy 2: Single AudioWorklet (MEDIUM)
    // If there's only one AudioWorkletNode, it's likely the encoder
    // ─────────────────────────────────────────────────────────────────
    if (ctxWorklets.length === 1) {
      const w = ctxWorklets[0];
      return {
        nodeId: w.nodeId || w.instance?.__nodeId,
        processorName: w.processorName,
        confidence: 'medium'
      };
    }

    // ─────────────────────────────────────────────────────────────────
    // Strategy 3: Most recent AudioWorklet (LOW)
    // Multiple worklets - pick the most recently created one
    // ─────────────────────────────────────────────────────────────────
    const sorted = [...ctxWorklets].sort((a, b) => b.timestamp - a.timestamp);
    const w = sorted[0];
    return {
      nodeId: w.nodeId || w.instance?.__nodeId,
      processorName: w.processorName,
      confidence: 'low'
    };
  };

  // ═══════════════════════════════════════════════════════════════════
  // getUserMedia Hook - Critical for voice recorder sites
  // ═══════════════════════════════════════════════════════════════════
  if (navigator.mediaDevices?.getUserMedia) {
    const originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const stream = await originalGUM(constraints);

      // ═══════════════════════════════════════════════════════════════════
      // EARLY RETURN: Skip capture if another tab is locked
      // Prevents memory waste from capturing data in inactive tabs
      // ═══════════════════════════════════════════════════════════════════
      if (window.__otherTabLocked) {
        return stream;
      }

      if (constraints?.audio) {
        const capture = {
          stream,
          constraints,
          timestamp: Date.now()
        };
        window.__earlyCaptures.getUserMedia.push(capture);

        // ═══════════════════════════════════════════════════════════════
        // NEW SESSION SIGNAL: Reset encoder detection on new mic capture
        // This ensures stale encoder data is cleared BEFORE recording starts
        // Critical for PCM/WAV recordings where Blob is created only at END
        // ═══════════════════════════════════════════════════════════════
        if (window.__recordingState) {
          window.__recordingState.sessionCount = (window.__recordingState.sessionCount || 0) + 1;
          const sessionNum = window.__recordingState.sessionCount;

          // ═══════════════════════════════════════════════════════════════
          // FIX: Set startTime for PCM/WAV path (blob tracking için)
          // CRITICAL: active set ETMEYİN - createMediaStreamSource'da set edilecek
          // Aksi halde broadcastRecordingState çağrılmaz ve pulse kaybolur
          //
          // Akış: getUserMedia → startTime set (flicker fix)
          //       createMediaStreamSource → !active TRUE → broadcast → pulse
          // ═══════════════════════════════════════════════════════════════
          if (!window.__recordingState.startTime) {
            window.__recordingState.startTime = Date.now();
            window.__recordingState.duration = null;
            window.__recordingState.startedByBlob = false;  // getUserMedia başlattı, blob değil
            // active BURADA set edilmemeli - createMediaStreamSource broadcast'i tetiklemeli
          }

          // Clear stale encoder detection
          window.__detectedEncoderData = null;
          if (window.__newRecordingSessionHandler) {
            window.__newRecordingSessionHandler(sessionNum);
          }

          // ═══════════════════════════════════════════════════════════════
          // PIPELINE RESET: Clear pipeline-specific captures from previous session
          // AudioContext instances are preserved (pre-warmed context reuse), but
          // pipeline nodes (AudioWorkletNodes, methodCalls) are reset.
          // This ensures technology change detection works correctly when user
          // switches from AudioWorklet to ScriptProcessor (or vice versa).
          //
          // NOTE: connections are NOT cleared - they are needed for UI tree rendering
          // when inspector stops due to technology change. Context filtering in
          // renderACStats will select the appropriate context based on connections.
          // ═══════════════════════════════════════════════════════════════
          const prevWorkletCount = window.__earlyCaptures.audioWorkletNodes?.length || 0;
          window.__earlyCaptures.audioWorkletNodes = [];
          // connections TEMİZLENMESİN - tree UI için korunmalı
          // Clear methodCalls in each AudioContext (pipeline setup is session-specific)
          window.__earlyCaptures.audioContexts.forEach(ctx => {
            ctx.methodCalls = [];
          });
          if (prevWorkletCount > 0) {
            debugLog('Pipeline reset', `Cleared ${prevWorkletCount} worklet(s) (connections preserved for UI)`);
          }

          // ═══════════════════════════════════════════════════════════════
          // SIGNATURE PRESERVATION: Save current as previous BEFORE new session
          // Critical for WASM encoder path where MediaRecorder.stop doesn't fire
          // This ensures technology change detection works even without stop event
          // ═══════════════════════════════════════════════════════════════
          if (window.__audioSignatures.current) {
            window.__audioSignatures.previous = window.__audioSignatures.current;
            window.__audioSignatures.current = null;
          }
          signatureCheckedThisSession = false;

          console.log(`[AudioInspector] Early: New recording session #${sessionNum} (getUserMedia trigger)`);
        }

        // Notify collector handler if already registered (late page.js load)
        if (window.__getUserMediaCollectorHandler) {
          window.__getUserMediaCollectorHandler(stream, [constraints]);
        }

        console.log('[AudioInspector] Early: getUserMedia captured (stream ' + stream.id + ')');
      }

      return stream;
    };

    console.log('[AudioInspector] Early: Hooked navigator.mediaDevices.getUserMedia');
  }

  // ═══════════════════════════════════════════════════════════════════
  // AudioContext Hook
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Extract minimal args for method call recording
   * @param {string} methodName
   * @param {any[]} args
   * @returns {Object}
   */
  const extractMethodArgs = (methodName, args) => {
    switch (methodName) {
      case 'createMediaStreamSource':
        return { streamId: args[0]?.id || null };
      case 'createScriptProcessor':
        // args: [bufferSize, numberOfInputChannels, numberOfOutputChannels]
        return {
          bufferSize: args[0] || 4096,
          inputChannels: args[1] || 2,
          outputChannels: args[2] || 2
        };
      case 'createMediaStreamDestination':
      case 'createAnalyser':
      default:
        return {};
    }
  };

  /**
   * Map method names to registry type keys (must match METHOD_CALL_SYNC_HANDLERS)
   */
  const METHOD_TYPE_MAP = {
    'createMediaStreamSource': 'mediaStreamSource',
    'createMediaStreamDestination': 'mediaStreamDestination',
    'createScriptProcessor': 'scriptProcessor',
    'createAnalyser': 'analyser'
  };

  // ═══════════════════════════════════════════════════════════════════
  // AudioWorkletNode Early Capture Registry
  // Stores AudioWorkletNode instances created before inspector starts
  // ═══════════════════════════════════════════════════════════════════
  window.__earlyCaptures.audioWorkletNodes = [];

  /**
   * Single source of truth for methods to hook
   * Derived from METHOD_TYPE_MAP keys to ensure consistency
   */
  const METHODS_TO_HOOK = Object.keys(METHOD_TYPE_MAP);

  const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
  if (OriginalAudioContext) {
    window.AudioContext = new Proxy(OriginalAudioContext, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);

        // ═══════════════════════════════════════════════════════════════════
        // EARLY RETURN: Skip capture if another tab is locked
        // Prevents memory waste from capturing data in inactive tabs
        // ═══════════════════════════════════════════════════════════════════
        if (window.__otherTabLocked) {
          return instance;
        }

        const contextId = getOrAssignContextId(instance);

        const capture = {
          instance,
          contextId,
          timestamp: Date.now(),
          sampleRate: instance.sampleRate,
          state: instance.state,
          methodCalls: []  // ← NEW: Store method calls for late sync
        };

        // ═══════════════════════════════════════════════════════════════
        // INSTANCE-LEVEL METHOD HOOKS
        // These hooks capture method calls BEFORE page.js loads
        // Critical for sites that set up audio pipeline immediately
        // ═══════════════════════════════════════════════════════════════
        METHODS_TO_HOOK.forEach(methodName => {
          const original = instance[methodName];
          if (typeof original === 'function') {
            instance[methodName] = function(...methodArgs) {
              const result = original.apply(this, methodArgs);

              // Record method call with normalized type
              const methodType = METHOD_TYPE_MAP[methodName];
              capture.methodCalls.push({
                type: methodType,
                ...extractMethodArgs(methodName, methodArgs),
                timestamp: Date.now()
              });

              // ═══════════════════════════════════════════════════════════════════
              // SIGNATURE CHECK: ScriptProcessor or MediaStreamDestination creation
              // Early detection of AudioWorklet → ScriptProcessor or output path change
              // ═══════════════════════════════════════════════════════════════════
              if (methodType === 'scriptProcessor' || methodType === 'mediaStreamDestination') {
                checkSignatureChange(methodName);
              }

              // PCM/WAV recording start signal (DRY: uses helper)
              if (methodName === 'createMediaStreamSource') {
                tryBroadcastPcmRecordingStart(methodArgs[0], 'Early');
              }

              console.log('[AudioInspector] Early: ' + methodName + '() captured');
              return result;
            };
          }
        });

        window.__earlyCaptures.audioContexts.push(capture);

        // Notify collector handler if already registered
        if (window.__audioContextCollectorHandler) {
          window.__audioContextCollectorHandler(instance, args);
        }

        console.log('[AudioInspector] Early: AudioContext created (' + instance.sampleRate + 'Hz)');

        return instance;
      }
    });

    // Handle webkitAudioContext alias
    if (window.webkitAudioContext) {
      window.webkitAudioContext = window.AudioContext;
    }

    console.log('[AudioInspector] Early: Hooked AudioContext constructor');

    // ═══════════════════════════════════════════════════════════════════
    // PROTOTYPE-LEVEL METHOD HOOKS (Fallback for pre-existing instances)
    // Catches method calls on AudioContexts created BEFORE our Proxy was installed
    // Critical for sites that create AudioContext in inline <script> tags
    // ═══════════════════════════════════════════════════════════════════
    const AudioContextProto = OriginalAudioContext.prototype;
    METHODS_TO_HOOK.forEach(methodName => {
      const original = AudioContextProto[methodName];
      if (typeof original === 'function') {
        AudioContextProto[methodName] = function(...args) {
          const result = original.apply(this, args);

          // Find existing capture for this context, or create new one
          let capture = window.__earlyCaptures.audioContexts.find(
            c => c.instance === this
          );
          if (!capture) {
            // Context was created before our Proxy - register it now
            capture = {
              instance: this,
              contextId: getOrAssignContextId(this),
              timestamp: Date.now(),
              sampleRate: this.sampleRate,
              state: this.state,
              methodCalls: []
            };
            window.__earlyCaptures.audioContexts.push(capture);
            console.log('[AudioInspector] Early: (proto) Late-discovered AudioContext (' + this.sampleRate + 'Hz)');

            // Notify collector handler if already registered
            if (window.__audioContextCollectorHandler) {
              window.__audioContextCollectorHandler(this, []);
            }
          }

          // Record method call
          const methodType = METHOD_TYPE_MAP[methodName];
          capture.methodCalls.push({
            type: methodType,
            ...extractMethodArgs(methodName, args),
            timestamp: Date.now()
          });

          // ═══════════════════════════════════════════════════════════════════
          // SIGNATURE CHECK: ScriptProcessor or MediaStreamDestination creation
          // Early detection of AudioWorklet → ScriptProcessor or output path change
          // ═══════════════════════════════════════════════════════════════════
          if (methodType === 'scriptProcessor' || methodType === 'mediaStreamDestination') {
            checkSignatureChange(methodName);
          }

          // PCM/WAV recording start signal (DRY: uses helper)
          if (methodName === 'createMediaStreamSource') {
            tryBroadcastPcmRecordingStart(args[0], 'Early (proto)');
          }

          console.log('[AudioInspector] Early: (proto) ' + methodName + '() captured');
          return result;
        };
      }
    });

    // Also hook webkitAudioContext prototype if different from AudioContext
    if (window.webkitAudioContext && window.webkitAudioContext !== OriginalAudioContext) {
      const webkitProto = window.webkitAudioContext.prototype;
      METHODS_TO_HOOK.forEach(methodName => {
        const original = webkitProto[methodName];
        if (typeof original === 'function') {
          webkitProto[methodName] = AudioContextProto[methodName];
        }
      });
      console.log('[AudioInspector] Early: Hooked webkitAudioContext prototype methods');
    }

    console.log('[AudioInspector] Early: Hooked AudioContext prototype methods');

    // ═══════════════════════════════════════════════════════════════════
    // AnalyserNode Usage Detection Hooks
    // Determines if analyser is used for spectrum visualization or waveform/VU meter
    // ═══════════════════════════════════════════════════════════════════

    // ⚠️ SYNC: Duplicate in EarlyHook.js - keep both in sync
    const getAnalyserUsageMap = () => {
      const existing = window.__audioInspectorAnalyserUsageMap;
      if (existing && typeof existing.get === 'function' && typeof existing.set === 'function') {
        return existing;
      }
      const map = new WeakMap();
      window.__audioInspectorAnalyserUsageMap = map;
      return map;
    };

    // ⚠️ SYNC: Duplicate in EarlyHook.js - keep both in sync
    const markAnalyserUsage = (node, usageType) => {
      if (!node) return;
      const map = getAnalyserUsageMap();
      // First call wins - don't overwrite existing usage type
      if (!map.has(node)) {
        map.set(node, usageType);
        console.log(`[AudioInspector] Early: AnalyserNode usage detected: ${usageType}`);

        // Notify handler if registered (for real-time UI updates)
        if (window.__analyserUsageHandler) {
          window.__analyserUsageHandler(node, usageType);
        }
      }
    };

    // Hook AnalyserNode prototype methods
    if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype) {
      const analyserProto = AnalyserNode.prototype;

      // Spectrum analysis methods (frequency domain)
      const spectrumMethods = ['getByteFrequencyData', 'getFloatFrequencyData'];
      // Waveform/VU meter methods (time domain)
      const waveformMethods = ['getByteTimeDomainData', 'getFloatTimeDomainData'];

      // Helper to hook analyser methods with usage type
      const hookAnalyserMethods = (methods, usageType) => {
        for (const methodName of methods) {
          if (typeof analyserProto[methodName] === 'function') {
            const original = analyserProto[methodName];
            analyserProto[methodName] = function(array) {
              markAnalyserUsage(this, usageType);
              return original.call(this, array);
            };
          }
        }
      };

      hookAnalyserMethods(spectrumMethods, 'spectrum');
      hookAnalyserMethods(waveformMethods, 'waveform');

      console.log('[AudioInspector] Early: Hooked AnalyserNode prototype methods for usage detection');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // AudioNode.connect() Hook - Audio Graph Topology Tracking
  // ═══════════════════════════════════════════════════════════════════
  // Captures connections between AudioNodes to build audio graph
  // Critical for understanding: ScriptProcessor → destination flow
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get a human-readable type name for an AudioNode
   * @param {AudioNode} node
   * @returns {string}
   */
  const getNodeTypeName = (node) => {
    if (!node) return 'unknown';
    const name = node.constructor?.name || 'AudioNode';
    // Simplify common names
    return name.replace('Node', '');
  };

  /**
   * Generate a stable unique ID for an AudioNode (for tracking)
   * Shared on window to keep IDs consistent between early-inject.js and page.js collectors
   * @param {any} node
   * @returns {string}
   */
  // ⚠️ SYNC: Duplicate in EarlyHook.js - keep both in sync
  const getNodeIdMap = () => {
    const win = /** @type {any} */ (window);
    const existing = win.__audioInspectorNodeIdMap;
    if (existing && typeof existing.get === 'function' && typeof existing.set === 'function') {
      return existing;
    }
    const map = new WeakMap();
    win.__audioInspectorNodeIdMap = map;
    return map;
  };

  // ⚠️ SYNC: Duplicate in EarlyHook.js - keep both in sync
  const getNextNodeId = () => {
    const win = /** @type {any} */ (window);
    const current = Number.isInteger(win.__audioInspectorNodeIdCounter)
      ? win.__audioInspectorNodeIdCounter
      : 0;
    const next = current + 1;
    win.__audioInspectorNodeIdCounter = next;
    return `node_${next}`;
  };

  const getNodeId = (node) => {
    if (!node || (typeof node !== 'object' && typeof node !== 'function')) return 'null';
    const map = getNodeIdMap();
    let id = map.get(node);
    if (!id) {
      id = getNextNodeId();
      map.set(node, id);
    }
    return id;
  };

  // Hook AudioNode.prototype.connect
  if (typeof AudioNode !== 'undefined' && AudioNode.prototype.connect) {
    const originalConnect = AudioNode.prototype.connect;

    AudioNode.prototype.connect = function(destination, outputIndex, inputIndex) {
      // Call original connect first
      const result = originalConnect.apply(this, arguments);

      // ═══════════════════════════════════════════════════════════════════
      // EARLY RETURN: Skip capture if another tab is locked
      // Prevents memory waste from capturing data in inactive tabs
      // ═══════════════════════════════════════════════════════════════════
      if (window.__otherTabLocked) {
        return result;
      }

      // Capture connection info
      const sourceType = getNodeTypeName(this);
      const sourceId = getNodeId(this);

      // Destination can be AudioNode or AudioParam
      const isAudioParam = destination instanceof AudioParam;
      const destType = isAudioParam
        ? `AudioParam(${destination.constructor?.name || 'param'})`
        : getNodeTypeName(destination);
      const destId = isAudioParam ? 'param' : getNodeId(destination);
      const contextId = getOrAssignContextId(this.context);

      const connection = {
        action: 'connect',
        sourceType,
        sourceId,
        destType,
        destId,
        outputIndex: outputIndex ?? 0,
        inputIndex: inputIndex ?? 0,
        timestamp: Date.now(),
        contextId
      };

      window.__earlyCaptures.connections.push(connection);

      // Notify handler if registered (for late sync with collector)
      if (window.__audioConnectionHandler) {
        window.__audioConnectionHandler(connection);
      }

      // Log important connections (destination nodes)
      // Note: getNodeTypeName() returns 'MediaStreamAudioDestination' (from constructor.name.replace('Node', ''))
      if (destType === 'AudioDestination' || destType === 'MediaStreamAudioDestination') {
        console.log(`[AudioInspector] Early: ${sourceType} → ${destType}`);
      }

      // ═══════════════════════════════════════════════════════════════════
      // SIGNATURE CHECK: First destination connection triggers check
      // This is the optimal timing - pipeline is definitely ready
      // Triggered by: AudioDestination (speakers) or MediaStreamAudioDestination
      // ═══════════════════════════════════════════════════════════════════
      if (!signatureCheckedThisSession &&
          (destType === 'AudioDestination' || destType === 'MediaStreamAudioDestination')) {

        signatureCheckedThisSession = true;

        const newSignature = calculateCurrentSignature();
        const resetType = determineResetType(
          window.__audioSignatures.previous,
          newSignature
        );

        if (resetType === 'hard') {
          broadcastSignatureChange('hard');
        }

        window.__audioSignatures.current = newSignature;

        debugLog('Signature check (connect)', {
          resetType,
          previous: window.__audioSignatures.previous,
          current: newSignature
        });
      }

      return result;
    };

    console.log('[AudioInspector] Early: Hooked AudioNode.prototype.connect');
  }

  // Hook AudioNode.prototype.disconnect (graph teardown tracking)
  if (typeof AudioNode !== 'undefined' && AudioNode.prototype.disconnect) {
    const originalDisconnect = AudioNode.prototype.disconnect;

    AudioNode.prototype.disconnect = function(...args) {
      const result = originalDisconnect.apply(this, args);

      // ═══════════════════════════════════════════════════════════════════
      // EARLY RETURN: Skip capture if another tab is locked
      // Prevents memory waste from capturing data in inactive tabs
      // ═══════════════════════════════════════════════════════════════════
      if (window.__otherTabLocked) {
        return result;
      }

      const sourceType = getNodeTypeName(this);
      const sourceId = getNodeId(this);
      const contextId = getOrAssignContextId(this.context);

      /** @type {any} */
      let destination = null;
      let outputIdx = null;
      let inputIdx = null;

      // Signature variants:
      // - disconnect()
      // - disconnect(output)
      // - disconnect(destination)
      // - disconnect(destination, output)
      // - disconnect(destination, output, input)
      if (args.length > 0) {
        if (typeof args[0] === 'number') {
          outputIdx = args[0];
        } else {
          destination = args[0];
          if (typeof args[1] === 'number') outputIdx = args[1];
          if (typeof args[2] === 'number') inputIdx = args[2];
        }
      }

      const isAudioParam = destination instanceof AudioParam;
      const destType = destination
        ? (isAudioParam
          ? `AudioParam(${destination.constructor?.name || 'param'})`
          : getNodeTypeName(destination))
        : null;
      const destId = destination
        ? (isAudioParam ? 'param' : getNodeId(destination))
        : null;

      const disconnection = {
        action: 'disconnect',
        sourceType,
        sourceId,
        destType,
        destId,
        outputIndex: outputIdx,
        inputIndex: inputIdx,
        timestamp: Date.now(),
        contextId
      };

      window.__earlyCaptures.connections.push(disconnection);

      if (window.__audioConnectionHandler) {
        window.__audioConnectionHandler(disconnection);
      }

      return result;
    };

    console.log('[AudioInspector] Early: Hooked AudioNode.prototype.disconnect');
  }

  // ═══════════════════════════════════════════════════════════════════
  // AudioWorkletNode Constructor Hook - Early Capture for VU Meters
  // Captures AudioWorkletNode instances (e.g., peak-worklet-processor)
  // BEFORE inspector starts, ensuring UI consistency on refresh vs initial start
  // ═══════════════════════════════════════════════════════════════════
  const OriginalAudioWorkletNode = window.AudioWorkletNode;
  if (OriginalAudioWorkletNode) {
    window.AudioWorkletNode = new Proxy(OriginalAudioWorkletNode, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);

        // ═══════════════════════════════════════════════════════════════════
        // EARLY RETURN: Skip capture if another tab is locked
        // Prevents memory waste from capturing data in inactive tabs
        // ═══════════════════════════════════════════════════════════════════
        if (window.__otherTabLocked) {
          return instance;
        }

        const context = args[0];      // AudioContext
        const processorName = args[1]; // 'peak-worklet-processor', 'opus-encoder', etc.
        const options = args[2];       // Optional parameters

        const contextId = context ? getOrAssignContextId(context) : null;

        const capture = {
          instance,
          nodeId: getNodeId(instance),
          context,
          contextId,
          processorName,
          options,
          timestamp: Date.now()
        };

        window.__earlyCaptures.audioWorkletNodes.push(capture);

        // Notify collector handler if already registered (real-time capture)
        if (window.__audioWorkletNodeHandler) {
          window.__audioWorkletNodeHandler(instance, args);
        }

        // ═══════════════════════════════════════════════════════════════════
        // SIGNATURE CHECK: AudioWorkletNode = potential processingPath change
        // Early detection of ScriptProcessor → AudioWorklet technology change
        // ═══════════════════════════════════════════════════════════════════
        checkSignatureChange('AudioWorkletNode');

        console.log(`[AudioInspector] Early: AudioWorkletNode created (${processorName})`);

        return instance;
      }
    });

    console.log('[AudioInspector] Early: Hooked AudioWorkletNode constructor');
  }

  // ═══════════════════════════════════════════════════════════════════
  // RTCPeerConnection Hook
  // ═══════════════════════════════════════════════════════════════════
  const OriginalRTCPC = window.RTCPeerConnection;
  if (OriginalRTCPC) {
    window.RTCPeerConnection = new Proxy(OriginalRTCPC, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);

        // ═══════════════════════════════════════════════════════════════════
        // EARLY RETURN: Skip capture if another tab is locked
        // Prevents memory waste from capturing data in inactive tabs
        // ═══════════════════════════════════════════════════════════════════
        if (window.__otherTabLocked) {
          return instance;
        }

        const capture = {
          instance,
          timestamp: Date.now()
        };
        window.__earlyCaptures.rtcPeerConnections.push(capture);

        // Notify collector handler if already registered
        if (window.__rtcPeerConnectionCollectorHandler) {
          window.__rtcPeerConnectionCollectorHandler(instance, args);
        }

        console.log('[AudioInspector] Early: RTCPeerConnection created');

        return instance;
      }
    });

    console.log('[AudioInspector] Early: Hooked RTCPeerConnection constructor');

    // ═══════════════════════════════════════════════════════════════════
    // RTCPeerConnection.addTrack Hook - WebRTC Audio Track Detection
    // WebRTC doesn't use AudioNode.connect(), so we hook addTrack instead
    // This triggers signature check for WebRTC-only audio pipelines
    // ═══════════════════════════════════════════════════════════════════
    const originalAddTrack = RTCPeerConnection.prototype.addTrack;
    if (originalAddTrack) {
      RTCPeerConnection.prototype.addTrack = function(track, ...streams) {
        const result = originalAddTrack.apply(this, arguments);

        // Audio track signature check (WebRTC path)
        if (track && track.kind === 'audio' && !signatureCheckedThisSession) {
          signatureCheckedThisSession = true;

          // WebRTC signature: processingPath='none', encodingType='browser_native'
          const newSignature = calculateCurrentSignature();
          const resetType = determineResetType(
            window.__audioSignatures.previous,
            newSignature
          );

          if (resetType === 'hard') {
            broadcastSignatureChange('hard');
          }

          window.__audioSignatures.current = newSignature;

          debugLog('Signature check (addTrack)', {
            resetType,
            trackKind: track.kind,
            previous: window.__audioSignatures.previous,
            current: newSignature
          });
        }

        return result;
      };

      console.log('[AudioInspector] Early: Hooked RTCPeerConnection.prototype.addTrack');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MediaRecorder Hook - with duration tracking for bitrate calculation
  // ═══════════════════════════════════════════════════════════════════
  const OriginalMediaRecorder = window.MediaRecorder;

  // Global recording state for bitrate calculation
  // Stored globally so Blob hook can access duration
  window.__recordingState = {
    startTime: null,
    duration: null,  // Duration in seconds (set when recording stops)
    totalBytes: 0,
    lastBlobSize: 0,
    mode: 'unknown', // 'unknown' | 'chunked' | 'cumulative'
    lastBitrateUpdateAt: 0,
    lastBlobAt: 0,
    finalizedAt: 0,
    active: false,
    startedByBlob: false,
    finalizeTimer: null,
    sessionCount: 0  // Track recording sessions for stale-reset logic
  };
  const BITRATE_UPDATE_INTERVAL_MS = 2000;

  if (OriginalMediaRecorder) {
    window.MediaRecorder = new Proxy(OriginalMediaRecorder, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);

        // ═══════════════════════════════════════════════════════════════════
        // EARLY RETURN: Skip capture if another tab is locked
        // Prevents memory waste from capturing data in inactive tabs
        // ═══════════════════════════════════════════════════════════════════
        if (window.__otherTabLocked) {
          return instance;
        }

        // Capture stream and options for late processing by MediaRecorderCollector
        const capture = {
          instance,
          stream: args[0],    // MediaStream
          options: args[1],   // MediaRecorderOptions (mimeType, audioBitsPerSecond, etc.)
          timestamp: Date.now()
        };
        window.__earlyCaptures.mediaRecorders.push(capture);

        // ═══════════════════════════════════════════════════════════════════
        // SIGNATURE CHECK: MediaRecorder = potential encodingType change
        // Early detection of WASM → MediaRecorder (browser_native) switch
        // ═══════════════════════════════════════════════════════════════════
        checkSignatureChange('MediaRecorder');

        // Track recording duration for bitrate calculation
        // NOTE: Session reset is now handled in getUserMedia hook (earlier signal)
        // This prevents double reset when getUserMedia → MediaRecorder flow is used
        instance.addEventListener('start', () => {
          // Timing state only - session management moved to getUserMedia
          window.__recordingState.startTime = Date.now();
          window.__recordingState.duration = null;
          window.__recordingState.totalBytes = 0;
          window.__recordingState.lastBlobSize = 0;
          window.__recordingState.mode = 'unknown';
          window.__recordingState.lastBitrateUpdateAt = 0;
          window.__recordingState.active = true;

          // Broadcast to storage for popup's PendingWebAudio detector
          broadcastRecordingState(true);

          // NOTE: Signature check moved to connect() hook for precise timing
          // MediaRecorder.start no longer triggers signature check directly
          // The check will happen when audio pipeline connects to destination

          debugLog('MediaRecorder started', `Session #${window.__recordingState.sessionCount}`);
        });

        instance.addEventListener('stop', () => {
          if (window.__recordingState.startTime) {
            window.__recordingState.duration = (Date.now() - window.__recordingState.startTime) / 1000;
            window.__recordingState.active = false;
            // Broadcast to storage for popup's PendingWebAudio detector
            broadcastRecordingState(false);
            debugLog('MediaRecorder stopped', `Duration: ${window.__recordingState.duration.toFixed(1)}s`);
          }

          // ═══════════════════════════════════════════════════════════════════
          // SIGNATURE PRESERVATION: Save current signature as previous
          // This enables technology change detection for next recording
          // Also reset session flag to allow check on next recording
          // ═══════════════════════════════════════════════════════════════════
          window.__audioSignatures.previous = calculateCurrentSignature();
          signatureCheckedThisSession = false;
        });

        // Notify collector handler if already registered
        if (window.__mediaRecorderCollectorHandler) {
          window.__mediaRecorderCollectorHandler(instance, args);
        }

        console.log('[AudioInspector] Early: MediaRecorder created');

        return instance;
      }
    });

    console.log('[AudioInspector] Early: Hooked MediaRecorder constructor');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Worker Hook - Capture encoder worker URLs (WASM and others)
  // Critical for detecting encoder modules (opus, mp3, etc.)
  // ═══════════════════════════════════════════════════════════════════
  const OriginalWorker = window.Worker;

  // WeakMap to store Worker metadata (filename, isEncoder) for postMessage hook
  const workerMetadataMap = new WeakMap();

  if (OriginalWorker) {
    // Keywords that indicate an encoder/audio worker
    // ⚠️ SYNC: Keep in sync with src/core/constants.js → ENCODER_KEYWORDS
    const ENCODER_KEYWORDS = [
      'encoder', 'opus', 'ogg', 'mp3', 'aac', 'vorbis', 'flac',
      'lame', 'audio', 'media', 'wasm', 'codec', 'voice', 'recorder'
    ];

    /**
     * Extract useful info from Worker URL
     * @param {string|URL} url
     * @returns {{url: string, filename: string, isEncoder: boolean, domain: string|null}}
     */
    const analyzeWorkerUrl = (url) => {
      const urlStr = url instanceof URL ? url.href : String(url);
      const urlLower = urlStr.toLowerCase();

      // Extract filename from URL
      let filename = '';
      try {
        const urlObj = new URL(urlStr, window.location.href);
        filename = urlObj.pathname.split('/').pop() || '';
      } catch {
        filename = urlStr.split('/').pop() || '';
      }

      // Extract domain
      let domain = null;
      try {
        const urlObj = new URL(urlStr, window.location.href);
        domain = urlObj.hostname;
      } catch {
        // Blob or data URL
      }

      // Check if it looks like an encoder worker
      const isEncoder = ENCODER_KEYWORDS.some(kw => urlLower.includes(kw));

      return { url: urlStr, filename, isEncoder, domain };
    };

    window.Worker = new Proxy(OriginalWorker, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);

        // ═══════════════════════════════════════════════════════════════════
        // EARLY RETURN: Skip capture if another tab is locked
        // Prevents memory waste from capturing data in inactive tabs
        // ═══════════════════════════════════════════════════════════════════
        if (window.__otherTabLocked) {
          return instance;
        }

        const workerUrl = args[0];

        if (workerUrl) {
          const analysis = analyzeWorkerUrl(workerUrl);

          // Store metadata in WeakMap for postMessage hook to access
          // Skip Blob URL UUIDs - they're meaningless (e.g., "8c4648b1-a60e-4760-96dd-cbe779af630e")
          // UUID v4 format: 8-4-4-4-12 hex chars = exactly 36 chars with hyphens
          const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const isBlobUUID = analysis.filename && UUID_PATTERN.test(analysis.filename);
          workerMetadataMap.set(instance, {
            filename: isBlobUUID ? null : analysis.filename,
            url: analysis.url,
            isEncoder: analysis.isEncoder
          });

          const capture = {
            instance,
            url: analysis.url,
            filename: analysis.filename,
            domain: analysis.domain,
            isEncoder: analysis.isEncoder,
            timestamp: Date.now()
          };
          window.__earlyCaptures.workers.push(capture);

          // Note: Worker collector handler not implemented yet
          // Worker data is captured in __earlyCaptures.workers for later use

          if (analysis.isEncoder) {
            // ═══════════════════════════════════════════════════════════════════
            // SIGNATURE CHECK: Encoder Worker = potential encodingType change
            // Early detection of MediaRecorder → WASM encoder switch
            // ═══════════════════════════════════════════════════════════════════
            checkSignatureChange('encoder-worker');

            console.log('[AudioInspector] Early: Encoder Worker created (' + analysis.filename + ')');
          }
        }

        return instance;
      }
    });

    console.log('[AudioInspector] Early: Hooked Worker constructor');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Worker.postMessage Hook - Detect encoder init (WASM: lamejs, opus-recorder, etc.)
  // Captures encoder configuration BEFORE recording starts (real-time detection)
  // ═══════════════════════════════════════════════════════════════════
  const originalWorkerPostMessage = Worker.prototype.postMessage;
  let workerMessageCount = 0;  // Debug counter
  Worker.prototype.postMessage = function(message, ...args) {
    // ═══════════════════════════════════════════════════════════════════
    // EARLY RETURN: Skip capture if another tab is locked
    // Prevents memory waste from capturing data in inactive tabs
    // ═══════════════════════════════════════════════════════════════════
    if (window.__otherTabLocked) {
      return originalWorkerPostMessage.apply(this, [message, ...args]);
    }

    workerMessageCount++;

    // ═══════════════════════════════════════════════════════════════════
    // EARLY RETURN: Skip encode/data commands immediately (performance)
    // These fire every ~85ms with huge audio buffers - no analysis needed
    // Only "init" commands contain encoder configuration we need to capture
    // ═══════════════════════════════════════════════════════════════════
    const cmd = message?.cmd || message?.command || message?.type;
    if (cmd === 'encode' || cmd === 'data' || cmd === 'chunk' || cmd === 'process') {
      return originalWorkerPostMessage.apply(this, [message, ...args]);
    }

    // ─────────────────────────────────────────────────────────────────
    // DEBUG: Log Worker.postMessage calls (only init/config messages reach here)
    // ─────────────────────────────────────────────────────────────────
    const msgType = message === null ? 'null' :
                    message === undefined ? 'undefined' :
                    ArrayBuffer.isView(message) ? `TypedArray(${message.constructor.name}, ${message.length})` :
                    message instanceof ArrayBuffer ? `ArrayBuffer(${message.byteLength})` :
                    Array.isArray(message) ? `Array(${message.length})` :
                    typeof message;

    if (workerMessageCount <= 10) {
      const logData = typeof message === 'object' && message !== null && !ArrayBuffer.isView(message)
        ? JSON.stringify(message, null, 2).substring(0, 500)
        : '(binary/array data)';
      debugLog(`Worker.postMessage #${workerMessageCount} type=${msgType}`, logData);

      // Also log to browser console for DevTools debugging
      if (typeof message === 'object' && message !== null && !ArrayBuffer.isView(message)) {
        console.log(`[AudioInspector] Early: Worker.postMessage #${workerMessageCount} type=${msgType}:`, JSON.stringify(message, null, 2).substring(0, 500));

        // Check if this looks like audio-related message
        const keys = Object.keys(message);
        const audioKeywords = ['sample', 'rate', 'buffer', 'channel', 'bit', 'encode', 'init', 'start', 'record', 'audio', 'codec', 'mp3', 'opus', 'aac'];
        const hasAudioKey = keys.some(k => audioKeywords.some(kw => k.toLowerCase().includes(kw)));
        if (hasAudioKey) {
          console.log(`[AudioInspector] Early: Worker.postMessage AUDIO:`, JSON.stringify(message, null, 2));
        }
      }
    }

    if (message && typeof message === 'object' && !ArrayBuffer.isView(message) && !(message instanceof ArrayBuffer)) {
      let encoderInfo = null;

      // ─────────────────────────────────────────────────────────────────
      // DEBUG: Log audio-related Worker.postMessage calls
      // ─────────────────────────────────────────────────────────────────
      const msgKeys = Object.keys(message);
      const msgCmd = message.cmd || message.command || message.type;
      const isLikelyAudio = msgKeys.some(k =>
        ['sample', 'rate', 'bit', 'channel', 'encode', 'init', 'config', 'audio', 'buffer'].some(
          term => k.toLowerCase().includes(term)
        )
      );
      if (isLikelyAudio) {
        debugLog('Worker.postMessage AUDIO', JSON.stringify(message, null, 2).substring(0, 300));
      }

      // ─────────────────────────────────────────────────────────────────
      // Encoder init patterns (lamejs, opus-recorder, online-voice-recorder, etc.)
      // ─────────────────────────────────────────────────────────────────
      // Pattern A: { cmd: 'init', config: { sampleRate, bitRate, ... } }
      // Pattern B: { command: 'init', sampleRate, bitRate, ... }
      // Pattern C: { type: 'init', sampleRate, bufferSize } (online-voice-recorder.com)
      // Pattern D: { config: { sampleRate, ... } } (no explicit command)

      const cmd = message.cmd || message.command || message.type;
      const config = message.config || message;

      // Check for init-like commands
      const isInitCommand = cmd === 'init' || cmd === 'initialize' || message.init === true;

      // Check for encoder-related fields
      // Pattern 1: Explicit encoder config (bitRate, kbps, mode)
      const hasExplicitEncoderFields = (
        config.bitRate !== undefined ||
        config.kbps !== undefined ||
        config.mp3BitRate !== undefined ||
        config.encoderSampleRate !== undefined ||
        config.encoderBitRate !== undefined ||
        config.mode !== undefined  // lamejs mode (CBR/VBR)
      );

      // Pattern 2: Audio worker init (sampleRate + bufferSize) - online-voice-recorder.com pattern
      // This is a heuristic: init message with audio processing params suggests encoder
      const hasAudioWorkerInit = (
        isInitCommand &&
        config.sampleRate !== undefined &&
        config.bufferSize !== undefined
      );

      const hasEncoderFields = hasExplicitEncoderFields || hasAudioWorkerInit;

      // Detect codec type from message fields AND Worker URL
      // Worker URL is more reliable for audio-worker-init pattern where message has no codec info
      // ⚠️ SYNC: Similar logic in EarlyHook.js:detectCodecType() - keep patterns consistent
      const detectCodec = (msg, isExplicitEncoder, workerMeta) => {
        // 1. Explicit codec field in message (highest priority)
        if (msg.codec) return msg.codec.toLowerCase();

        // 2. Codec-specific message fields
        if (msg.mp3BitRate !== undefined || msg.mp3Mode !== undefined || msg.lameConfig !== undefined || msg.vbrQuality !== undefined) return 'mp3';
        if (msg.encoderApplication !== undefined) return 'opus';
        if (msg.aacProfile !== undefined || msg.aacObjectType !== undefined || msg.afterburner !== undefined) return 'aac';
        if (msg.vorbisQuality !== undefined || msg.vorbisMode !== undefined) return 'vorbis';
        if (msg.flacCompression !== undefined || msg.flacBlockSize !== undefined) return 'flac';

        // 3. Worker URL/filename detection (critical for audio-worker-init pattern)
        // Many sites use generic init messages but encoder-specific worker files
        if (workerMeta) {
          const filename = (workerMeta.filename || '').toLowerCase();
          const url = (workerMeta.url || '').toLowerCase();

          // Check for codec keywords in worker filename/URL
          if (filename.includes('lame') || filename.includes('mp3') || url.includes('lame') || url.includes('mp3')) return 'mp3';
          if (filename.includes('opus') || url.includes('opus')) return 'opus';
          if (filename.includes('aac') || filename.includes('fdk') || url.includes('aac')) return 'aac';
          if (filename.includes('vorbis') || filename.includes('ogg') || url.includes('vorbis')) return 'vorbis';
          if (filename.includes('flac') || url.includes('flac')) return 'flac';
          // WAV container → PCM codec
          if (filename.includes('wav') || url.includes('wav')) return 'pcm';
        }

        // 4. Fallback: explicit encoder patterns default to mp3, otherwise unknown
        return isExplicitEncoder ? 'mp3' : 'unknown';
      };

      // Detect encoder library from Worker URL or message fields
      const detectLibrary = (codec, workerMeta, msg) => {
        // From Worker filename/URL (most reliable)
        const filename = (workerMeta?.filename || '').toLowerCase();
        const url = (workerMeta?.url || '').toLowerCase();
        const path = msg.encoderPath?.toLowerCase() || '';

        if (filename.includes('lame') || url.includes('lame') || path.includes('lame')) return 'LAME';
        if (filename.includes('opus') || url.includes('opus') || path.includes('opus')) return 'libopus';
        if (filename.includes('fdk') || url.includes('fdk') || filename.includes('aac') || path.includes('aac')) return 'FDK AAC';
        if (filename.includes('vorbis') || url.includes('vorbis') || path.includes('vorbis')) return 'libvorbis';
        if (filename.includes('flac') || url.includes('flac') || path.includes('flac')) return 'libFLAC';

        // Default by codec
        const defaultLibraries = {
          mp3: 'LAME',
          opus: 'libopus',
          aac: 'FDK AAC',
          vorbis: 'libvorbis',
          flac: 'libFLAC'
        };
        return defaultLibraries[codec] || null;
      };

      // Get generic encoder type from codec (process type, not library)
      const getEncoderType = (codec) => {
        const encoderTypes = {
          mp3: 'mp3-wasm',
          opus: 'opus-wasm',
          aac: 'aac-wasm',
          vorbis: 'vorbis-wasm',
          flac: 'flac-wasm',
          pcm: 'pcm'
        };
        return encoderTypes[codec] || null;
      };

      if (isInitCommand && hasEncoderFields) {
        // Get Worker metadata FIRST (needed for codec detection)
        // 'this' is the Worker instance in postMessage context
        const workerMeta = workerMetadataMap.get(this);

        // Detect codec from message fields AND Worker URL
        const codec = detectCodec(config, hasExplicitEncoderFields, workerMeta);

        // Determine bitRate: explicit > calculated > default
        let bitRate = config.bitRate || config.kbps * 1000 || config.mp3BitRate || config.encoderBitRate;
        if (!bitRate && hasAudioWorkerInit) {
          // Default MP3 bitrate for voice recorders (most use 128-256kbps)
          // We mark as 0 to indicate "unknown" and let Blob detection confirm later
          bitRate = 0;
        }

        // Detect library from worker metadata and message fields
        const library = detectLibrary(codec, workerMeta, config);
        const encoder = getEncoderType(codec);

        encoderInfo = {
          type: codec,
          codec: codec,
          encoder: encoder,  // opus-wasm, mp3-wasm, aac-wasm, vorbis-wasm, flac-wasm, pcm
          library: library,  // libopus, LAME, FDK AAC, libvorbis, libFLAC
          // Container: keep separate from codec (PCM → WAV container)
          container: codec === 'unknown' ? null : (codec === 'pcm' ? 'wav' : codec),
          sampleRate: config.sampleRate || config.encoderSampleRate || 44100,
          bitRate: bitRate || 0,
          bufferSize: config.bufferSize,  // Capture bufferSize for audio worker pattern
          channels: config.channels || config.numChannels || config.numberOfChannels || 1,
          mode: config.mode,  // CBR/VBR for lamejs
          timestamp: Date.now(),
          source: 'worker-postmessage',
          pattern: hasExplicitEncoderFields ? 'worker-init' : 'worker-audio-init',
          workerFilename: workerMeta?.filename || null,  // Worker JS filename for UI
          workerUrl: workerMeta?.url || null
        };

        const libraryInfo = library ? ` [${library}]` : '';
        debugLog(`Encoder init detected (${encoderInfo.pattern})`, `${codec.toUpperCase()}${libraryInfo}, ${encoderInfo.sampleRate}Hz, buffer=${encoderInfo.bufferSize}, worker=${workerMeta?.filename || 'unknown'}`);

        // Also log to browser console for DevTools debugging
        console.log(`[AudioInspector] Early: Encoder init detected (${encoderInfo.pattern}): ${codec.toUpperCase()}${libraryInfo}, ${encoderInfo.sampleRate}Hz, buffer=${encoderInfo.bufferSize}, worker=${workerMeta?.filename || 'unknown'}`);
        console.log(`[AudioInspector] Early: Full encoderInfo:`, JSON.stringify(encoderInfo, null, 2));
      }

      // Notify handler if encoder detected
      if (encoderInfo) {
        // Attach current recording session id to prevent stale overwrites/reset races
        // sessionCount is incremented on MediaRecorder start or BlobTracking start
        encoderInfo.sessionId = window.__recordingState?.sessionCount || 0;

        console.log(`[AudioInspector] Early: Notifying handler, registered: ${!!window.__detectedEncoderHandler}`);
        if (window.__detectedEncoderHandler) {
          window.__detectedEncoderHandler(encoderInfo);
        } else {
          console.log(`[AudioInspector] Early: WARNING: Handler not registered, encoderInfo will be lost!`);
        }
      }
    }

    return originalWorkerPostMessage.apply(this, [message, ...args]);
  };
  console.log('[AudioInspector] Early: Hooked Worker.prototype.postMessage');

  // ═══════════════════════════════════════════════════════════════════
  // Blob Hook - Detect audio file creation (MP3, WAV, OGG, etc.)
  // When audio is encoded and saved, a Blob is created with audio MIME type
  // ═══════════════════════════════════════════════════════════════════
  const OriginalBlob = window.Blob;
  if (OriginalBlob) {
    // Audio MIME types that indicate encoding
    // encoder: generic process type (opus-wasm, mp3-wasm, etc.)
    // library: underlying C library (libopus, LAME, etc.)
    // libraryPackage: JS/NPM package name if detectable (opus-recorder, lamejs, etc.)
    const AUDIO_MIME_TYPES = {
      'audio/mp3': { codec: 'mp3', container: 'mp3', encoder: 'mp3-wasm', library: 'LAME' },
      'audio/mpeg': { codec: 'mp3', container: 'mp3', encoder: 'mp3-wasm', library: 'LAME' },
      'audio/wav': { codec: 'pcm', container: 'wav', encoder: 'pcm', library: null },
      'audio/wave': { codec: 'pcm', container: 'wav', encoder: 'pcm', library: null },
      'audio/ogg': { codec: 'vorbis', container: 'ogg', encoder: 'vorbis-wasm', library: 'libvorbis' },
      'audio/opus': { codec: 'opus', container: 'ogg', encoder: 'opus-wasm', library: 'libopus' },
      'audio/webm': { codec: 'opus', container: 'webm', encoder: 'opus-wasm', library: 'libopus' },
      'audio/aac': { codec: 'aac', container: 'aac', encoder: 'aac-wasm', library: 'FDK AAC' },
      'audio/flac': { codec: 'flac', container: 'flac', encoder: 'flac-wasm', library: 'libFLAC' }
    };

    const getLastGumAt = () => {
      // @ts-ignore
      const gum = window.__earlyCaptures?.getUserMedia;
      if (Array.isArray(gum) && gum.length > 0) {
        const last = gum[gum.length - 1];
        return typeof last?.timestamp === 'number' ? last.timestamp : 0;
      }
      return 0;
    };

    const readFourCC = (view, offset) => {
      if (!view || offset + 4 > view.byteLength) return null;
      return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
    };

    const parseWavHeader = (buffer) => {
      try {
        const view = new DataView(buffer);
        if (view.byteLength < 12) return null;
        const riff = readFourCC(view, 0);
        const wave = readFourCC(view, 8);
        if (riff !== 'RIFF' || wave !== 'WAVE') return null;

        let offset = 12;
        /** @type {{channels:number, sampleRate:number, byteRate:number, bitsPerSample:number}|null} */
        let fmt = null;
        let dataSize = null;

        while (offset + 8 <= view.byteLength) {
          const id = readFourCC(view, offset);
          const size = view.getUint32(offset + 4, true);
          const chunkStart = offset + 8;

          if (id === 'fmt ') {
            if (chunkStart + 16 <= view.byteLength) {
              fmt = {
                channels: view.getUint16(chunkStart + 2, true),
                sampleRate: view.getUint32(chunkStart + 4, true),
                byteRate: view.getUint32(chunkStart + 8, true),
                bitsPerSample: view.getUint16(chunkStart + 14, true)
              };
            }
          } else if (id === 'data') {
            dataSize = size;
            break;
          }

          // Chunk sizes are padded to even bytes.
          offset = chunkStart + size + (size % 2);
        }

        if (!fmt || !fmt.byteRate || fmt.byteRate <= 0) return null;

        const durationSec = (typeof dataSize === 'number' && dataSize > 0)
          ? (dataSize / fmt.byteRate)
          : null;

        return { ...fmt, dataSize, durationSec };
      } catch {
        return null;
      }
    };

    window.Blob = new Proxy(OriginalBlob, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);

        // ═══════════════════════════════════════════════════════════════════
        // EARLY RETURN: Skip capture if another tab is locked
        // Prevents memory waste from capturing data in inactive tabs
        // ═══════════════════════════════════════════════════════════════════
        if (window.__otherTabLocked) {
          return instance;
        }

        const options = args[1];

        if (options?.type) {
          const mimeType = options.type.toLowerCase();
          const audioInfo = AUDIO_MIME_TYPES[mimeType];

            if (audioInfo) {
              const blobSize = instance.size;

              // Only report significant blobs (> 1KB) to avoid metadata blobs
              if (blobSize > 1024) {
                const recordingState = window.__recordingState || {};
                const now = Date.now();

                // ───────────────────────────────────────────────────────────────
                // Blob-based Session Management (WAV / custom recorders)
                // Some sites don't use MediaRecorder events; they create audio Blob(s) directly.
                // We treat the first meaningful audio Blob as "recording started" and ensure
                // subsequent recordings on the same page increment sessionCount correctly.
                // ───────────────────────────────────────────────────────────────

                const startBlobSession = () => {
                  // Clear any pending finalize timer from previous session
                  if (recordingState.finalizeTimer) {
                    clearTimeout(recordingState.finalizeTimer);
                    recordingState.finalizeTimer = null;
                  }

                  // Check if getUserMedia already started a new session recently
                  // getUserMedia hook increments sessionCount and triggers reset
                  // We don't want to double-increment if getUserMedia already handled it
                  const lastGumTimestamp = getLastGumAt();
                  const gumTriggeredSession = lastGumTimestamp > 0 &&
                    (now - lastGumTimestamp) < 5000 && // Within 5 seconds
                    recordingState.sessionCount > 0;   // Session already incremented

                  let sessionNum;
                  if (gumTriggeredSession) {
                    // getUserMedia already started this session - reuse it
                    sessionNum = recordingState.sessionCount;
                    debugLog('Blob tracking', `Using existing session #${sessionNum} (getUserMedia triggered)`);
                  } else {
                    // FALLBACK: Custom recorder without getUserMedia - increment here
                    recordingState.sessionCount = (recordingState.sessionCount || 0) + 1;
                    sessionNum = recordingState.sessionCount;

                    // Reset encoder detection (fallback path only)
                    window.__detectedEncoderData = null;
                    if (window.__newRecordingSessionHandler) {
                      window.__newRecordingSessionHandler(sessionNum);
                    }
                    debugLog('Recording started', `Session #${sessionNum} (source: BlobTracking fallback)`);
                  }

                  // Timing state - always update
                  recordingState.startTime = now;
                  recordingState.duration = null;
                  recordingState.totalBytes = 0;
                  recordingState.lastBlobSize = 0;
                  recordingState.mode = 'unknown';
                  recordingState.lastBitrateUpdateAt = 0;
                  recordingState.lastBlobAt = now;
                  recordingState.finalizedAt = 0;
                  recordingState.active = true;
                  recordingState.startedByBlob = true;
                  window.__recordingState = recordingState;

                  // Broadcast to storage for popup's PendingWebAudio detector
                  broadcastRecordingState(true);

                  // Log only once for initial fallback activation
                  if (sessionNum === 1 && !gumTriggeredSession) {
                    debugLog('Blob tracking started', 'No MediaRecorder events detected, using blob-based tracking');
                  }

                  return sessionNum;
                };

                const lastGumAt = getLastGumAt();
                const finalizedAt = typeof recordingState.finalizedAt === 'number' ? recordingState.finalizedAt : 0;
                const hasNewGumSinceFinalize = finalizedAt > 0 && lastGumAt > finalizedAt;

                const RESUME_GRACE_MS = 2500;
                const NEW_SESSION_GAP_MS = 2500;
                const lastBlobAt = typeof recordingState.lastBlobAt === 'number' ? recordingState.lastBlobAt : 0;
                const hasNewGumSinceLastBlob = lastBlobAt > 0 && lastGumAt > lastBlobAt;
                const gapSinceFinalize = finalizedAt > 0 ? (now - finalizedAt) : 0;
                const gapSinceLastBlob = lastBlobAt > 0 ? (now - lastBlobAt) : 0;

                const likelyExportBlob = recordingState.lastBlobSize
                  ? (blobSize > (recordingState.lastBlobSize * 1.7))
                  : false;

                // Export blob = kayıt bitti. Hemen finalize et.
                // Bu, pulse → sonuç geçişinin tek seferde olmasını sağlar (flickering önler).
                if (likelyExportBlob && recordingState.active) {
                  if (recordingState.finalizeTimer) {
                    clearTimeout(recordingState.finalizeTimer);
                    recordingState.finalizeTimer = null;
                  }
                  recordingState.active = false;
                  recordingState.duration = recordingState.startTime
                    ? (Date.now() - recordingState.startTime) / 1000
                    : null;
                  recordingState.finalizedAt = Date.now();
                }

                const blobSessionInactive = recordingState.startedByBlob === true && recordingState.active !== true;
                const shouldStartNewBlobSession = (
                  // First ever blob-based detection (but NOT if getUserMedia already started a session)
                  (!recordingState.startTime && !recordingState.duration && recordingState.sessionCount === 0) ||
                  // New mic capture since last blob (strong signal for a new recording)
                  (recordingState.startedByBlob === true && hasNewGumSinceLastBlob) ||
                  // Inactive blob session + new mic capture since finalize (strong signal)
                  // Guard: Export blobs (>1.7x last size) should NOT start new sessions
                  (blobSessionInactive && hasNewGumSinceFinalize && !likelyExportBlob) ||
                  // Inactive blob session + long gap (likely a new recording)
                  // Guard: Export blobs should NOT restart session even with time gap
                  (blobSessionInactive && !likelyExportBlob && ((gapSinceFinalize > NEW_SESSION_GAP_MS) || (gapSinceLastBlob > NEW_SESSION_GAP_MS)))
                );

                if (shouldStartNewBlobSession) {
                  startBlobSession();
                } else if (blobSessionInactive && !likelyExportBlob && gapSinceLastBlob > 0 && gapSinceLastBlob <= RESUME_GRACE_MS) {
                  // Resume: blobs continued after a short gap (avoid premature finalize splitting a session)
                  // CRITICAL: Clear finalize timer to prevent it from setting active=false
                  // Without this, timer fires 1s later → active=false → isLiveEstimate=false → pulse lost
                  if (recordingState.finalizeTimer) {
                    clearTimeout(recordingState.finalizeTimer);
                    recordingState.finalizeTimer = null;
                  }
                  recordingState.active = true;
                  recordingState.duration = null;
                  // Broadcast resumed state
                  broadcastRecordingState(true);
                }

                const elapsedSec = recordingState.startTime
                  ? (now - recordingState.startTime) / 1000
                  : null;

              if (recordingState.active) {
                if (recordingState.mode === 'cumulative') {
                  recordingState.totalBytes = blobSize;
                } else if (recordingState.mode === 'chunked') {
                  recordingState.totalBytes += blobSize;
                } else if (recordingState.lastBlobSize) {
                  const isCumulative = blobSize > (recordingState.lastBlobSize * 1.7);
                  recordingState.mode = isCumulative ? 'cumulative' : 'chunked';
                  recordingState.totalBytes = isCumulative
                    ? blobSize
                    : (recordingState.totalBytes + blobSize);
                } else {
                  recordingState.totalBytes += blobSize;
                }
              } else if (recordingState.duration) {
                recordingState.totalBytes = Math.max(recordingState.totalBytes || 0, blobSize);
              }

                recordingState.lastBlobSize = blobSize;
                recordingState.lastBlobAt = now;

                const recordingDuration = recordingState.duration ||
                  (recordingState.active && elapsedSec ? elapsedSec : null);
                const shouldUpdateBitrate = !recordingState.active ||
                  !recordingState.lastBitrateUpdateAt ||
                (now - recordingState.lastBitrateUpdateAt) >= BITRATE_UPDATE_INTERVAL_MS;

              // Calculate bitrate from blob size and recording duration
              let calculatedBitRate = null;
              if (shouldUpdateBitrate && recordingDuration && recordingDuration > 0) {
                const bytes = recordingState.totalBytes || blobSize;
                calculatedBitRate = Math.round((bytes * 8) / recordingDuration);
                recordingState.lastBitrateUpdateAt = now;
              }

              const audioContextSampleRate = (() => {
                // Best-effort: use first captured AudioContext sampleRate if available
                // @ts-ignore
                const contexts = window.__earlyCaptures?.audioContexts;
                const sr = Array.isArray(contexts) && contexts.length > 0
                  ? contexts[0]?.sampleRate
                  : null;
                return (typeof sr === 'number' && sr > 0) ? sr : null;
              })();

                const encoderInfo = {
                  type: audioInfo.codec,
                  codec: audioInfo.codec,
                  encoder: audioInfo.encoder,  // opus-wasm, mp3-wasm, aac-wasm, vorbis-wasm, flac-wasm, pcm
                  library: audioInfo.library,  // libopus, LAME, FDK AAC, libvorbis, libFLAC
                  container: audioInfo.container,
                  mimeType: mimeType,
                  blobSize: blobSize,
                  recordingDuration: recordingDuration,  // Duration in seconds
                  calculatedBitRate: calculatedBitRate,  // Calculated from blob size / duration
                  isLiveEstimate: recordingState.active === true,
                  sampleRate: audioContextSampleRate,
                  bitRate: calculatedBitRate || 0,
                  timestamp: Date.now(),
                  source: 'blob-creation',
                  pattern: 'audio-blob'
                };

              const encoderNameInfo = audioInfo.encoder ? ` [${audioInfo.encoder}]` : '';
              const durationInfo = recordingDuration ? `, ${recordingDuration.toFixed(1)}s` : '';
              const bitrateInfo = calculatedBitRate ? `, ~${Math.round(calculatedBitRate / 1000)}kbps` : '';
              debugLog(`Audio Blob created`, `${mimeType}${encoderNameInfo}, ${(blobSize / 1024).toFixed(1)}KB${durationInfo}${bitrateInfo}`);

                // Notify encoder handler (unified detection)
                // Note: All blob data goes through detectedEncoderHandler for pattern priority
                if (shouldUpdateBitrate && window.__detectedEncoderHandler) {
                  const sessionId = recordingState.sessionCount || 0;

                  // WAV: enrich via header (bitDepth/channels/sampleRate/duration/bitrate) for stable UI
                  if (mimeType === 'audio/wav' || mimeType === 'audio/wave') {
                    const headerLen = Math.min(2048, blobSize);
                    instance.slice(0, headerLen).arrayBuffer().then((buf) => {
                      const wav = parseWavHeader(buf);
                      if (wav) {
                        encoderInfo.sampleRate = wav.sampleRate || encoderInfo.sampleRate;
                        encoderInfo.channels = wav.channels || encoderInfo.channels;
                        encoderInfo.wavBitDepth = wav.bitsPerSample || encoderInfo.wavBitDepth;
                        if (typeof wav.durationSec === 'number' && wav.durationSec > 0) {
                          encoderInfo.recordingDuration = wav.durationSec;
                        }
                        if (typeof wav.byteRate === 'number' && wav.byteRate > 0) {
                          const br = Math.round(wav.byteRate * 8);
                          encoderInfo.calculatedBitRate = br;
                          encoderInfo.bitRate = br;
                        }
                      }

                      if (window.__detectedEncoderHandler) {
                        encoderInfo.sessionId = sessionId;
                        window.__detectedEncoderHandler(encoderInfo);
                      }
                    }).catch(() => {
                      // Header parse failed - fall back to size/duration based estimate
                      if (window.__detectedEncoderHandler) {
                        encoderInfo.sessionId = sessionId;
                        window.__detectedEncoderHandler(encoderInfo);
                      }
                    });
                  } else {
                    encoderInfo.sessionId = sessionId;
                    window.__detectedEncoderHandler(encoderInfo);
                  }
                }

                // Finalize blob-based recording: if blobs stop arriving, mark inactive and emit a final update
                // This prevents "Calculating..." from persisting after stop and enables a final bitrate calc.
                if (recordingState.startedByBlob) {
                if (recordingState.finalizeTimer) {
                  clearTimeout(recordingState.finalizeTimer);
                }
                  recordingState.finalizeTimer = setTimeout(() => {
                    if (!recordingState.startTime) return;
                    recordingState.duration = (Date.now() - recordingState.startTime) / 1000;
                    recordingState.active = false;
                    recordingState.finalizedAt = Date.now();
                    // Broadcast finalized state
                    broadcastRecordingState(false);

                    // ═══════════════════════════════════════════════════════════
                    // SIGNATURE PRESERVATION: Save current signature as previous
                    // PCM/WAV path: No MediaRecorder.stop event, so save here
                    // Also reset session flag to allow check on next recording
                    // ═══════════════════════════════════════════════════════════
                    window.__audioSignatures.previous = calculateCurrentSignature();
                    signatureCheckedThisSession = false;

                    const finalBytes = recordingState.totalBytes || blobSize;
                    const finalDuration = recordingState.duration || recordingDuration;
                    const finalBitRate = (finalDuration && finalDuration > 0)
                      ? Math.round((finalBytes * 8) / finalDuration)
                    : null;

                  if (window.__detectedEncoderHandler) {
                    window.__detectedEncoderHandler({
                      ...encoderInfo,
                      sessionId: recordingState.sessionCount || 0,
                      isLiveEstimate: false,
                      recordingDuration: finalDuration,
                      calculatedBitRate: finalBitRate,
                      bitRate: finalBitRate || encoderInfo.bitRate || 0,
                      timestamp: Date.now()
                    });
                  }
                }, 1000);
              }
            }
          }
        }

        return instance;
      }
    });

    console.log('[AudioInspector] Early: Hooked Blob constructor');
  }

  console.log('[AudioInspector] Early hooks installed successfully');
})();
