// Early Inject - MAIN world content script
// Runs BEFORE any page scripts to capture API calls
// This is the fastest possible hook injection method in Manifest V3

(function() {
  'use strict';

  // Prevent double injection
  if (window.__audioInspectorEarlyHooksInstalled) return;
  window.__audioInspectorEarlyHooksInstalled = true;

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
    console.log('[AudioInspector] Early: Registry cleared');
  };

  // ═══════════════════════════════════════════════════════════════════
  // getUserMedia Hook - Critical for voice recorder sites
  // ═══════════════════════════════════════════════════════════════════
  if (navigator.mediaDevices?.getUserMedia) {
    const originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const stream = await originalGUM(constraints);

      if (constraints?.audio) {
        const capture = {
          stream,
          constraints,
          timestamp: Date.now()
        };
        window.__earlyCaptures.getUserMedia.push(capture);

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
              capture.methodCalls.push({
                type: METHOD_TYPE_MAP[methodName],
                ...extractMethodArgs(methodName, methodArgs),
                timestamp: Date.now()
              });

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
            console.log('[AudioInspector] Early (proto): Late-discovered AudioContext (' + this.sampleRate + 'Hz)');

            // Notify collector handler if already registered
            if (window.__audioContextCollectorHandler) {
              window.__audioContextCollectorHandler(this, []);
            }
          }

          // Record method call
          capture.methodCalls.push({
            type: METHOD_TYPE_MAP[methodName],
            ...extractMethodArgs(methodName, args),
            timestamp: Date.now()
          });

          console.log('[AudioInspector] Early (proto): ' + methodName + '() captured');
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
   * Generate a unique ID for an AudioNode (for tracking)
   * Uses WeakMap to avoid polluting node objects
   * @param {AudioNode} node
   * @returns {string}
   */
  const nodeIdMap = new WeakMap();
  let nodeIdCounter = 0;
  const getNodeId = (node) => {
    if (!node) return 'null';
    if (!nodeIdMap.has(node)) {
      nodeIdMap.set(node, `node_${++nodeIdCounter}`);
    }
    return nodeIdMap.get(node);
  };

  // Hook AudioNode.prototype.connect
  if (typeof AudioNode !== 'undefined' && AudioNode.prototype.connect) {
    const originalConnect = AudioNode.prototype.connect;

    AudioNode.prototype.connect = function(destination, outputIndex, inputIndex) {
      // Call original connect first
      const result = originalConnect.apply(this, arguments);

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

      // Log important connections (destination node or MediaStreamDestination)
      if (destType === 'AudioDestination' || destType === 'MediaStreamDestination') {
        console.log(`[AudioInspector] Early: ${sourceType} → ${destType}`);
      }

      return result;
    };

    console.log('[AudioInspector] Early: Hooked AudioNode.prototype.connect');
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

        const context = args[0];      // AudioContext
        const processorName = args[1]; // 'peak-worklet-processor', 'opus-encoder', etc.
        const options = args[2];       // Optional parameters

        const contextId = context ? getOrAssignContextId(context) : null;

        const capture = {
          instance,
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
    active: false,
    sessionCount: 0  // Track recording sessions for auto-stop logic
  };
  const BITRATE_UPDATE_INTERVAL_MS = 2000;

  if (OriginalMediaRecorder) {
    window.MediaRecorder = new Proxy(OriginalMediaRecorder, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);

        // Capture stream and options for late processing by MediaRecorderCollector
        const capture = {
          instance,
          stream: args[0],    // MediaStream
          options: args[1],   // MediaRecorderOptions (mimeType, audioBitsPerSecond, etc.)
          timestamp: Date.now()
        };
        window.__earlyCaptures.mediaRecorders.push(capture);

        // Track recording duration for bitrate calculation
        instance.addEventListener('start', () => {
          // Increment session count FIRST
          window.__recordingState.sessionCount++;
          const sessionNum = window.__recordingState.sessionCount;

          window.__recordingState.startTime = Date.now();
          window.__recordingState.duration = null;
          window.__recordingState.totalBytes = 0;
          window.__recordingState.lastBlobSize = 0;
          window.__recordingState.mode = 'unknown';
          window.__recordingState.lastBitrateUpdateAt = 0;
          window.__recordingState.active = true;

          // ═══════════════════════════════════════════════════════════════
          // STALE DATA FIX: Reset encoder detection for new recording session
          // Without this, second recording on same page keeps first recording's encoder info
          // Signal to AudioContextCollector to reset currentEncoderData
          // ═══════════════════════════════════════════════════════════════
          window.__wasmEncoderDetected = null;
          if (window.__newRecordingSessionHandler) {
            window.__newRecordingSessionHandler();
          }

          // ═══════════════════════════════════════════════════════════════
          // AUTO-STOP: Only trigger on 2nd+ recording session
          // First recording: inspector keeps running (normal operation)
          // Second+ recording: auto-stop to prevent stale data accumulation
          // ═══════════════════════════════════════════════════════════════
          if (sessionNum >= 2) {
            window.postMessage({
              __audioPipelineInspector: true,
              type: 'AUTO_STOP_NEW_RECORDING'
            }, '*');
            debugLog('MediaRecorder started', `Session #${sessionNum} - inspector auto-stop triggered`);
          } else {
            debugLog('MediaRecorder started', `Session #${sessionNum} - first recording, inspector continues`);
          }
        });

        instance.addEventListener('stop', () => {
          if (window.__recordingState.startTime) {
            window.__recordingState.duration = (Date.now() - window.__recordingState.startTime) / 1000;
            window.__recordingState.active = false;
            debugLog('MediaRecorder stopped', `Duration: ${window.__recordingState.duration.toFixed(1)}s`);
          }
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
  // Worker Hook - Capture WASM encoder worker URLs
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
            console.log('[AudioInspector] Early: Encoder Worker created (' + analysis.filename + ')');
          }
        }

        return instance;
      }
    });

    console.log('[AudioInspector] Early: Hooked Worker constructor');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Worker.postMessage Hook - Detect WASM encoder init (lamejs, opus-recorder, etc.)
  // Captures encoder configuration BEFORE recording starts (real-time detection)
  // ═══════════════════════════════════════════════════════════════════
  const originalWorkerPostMessage = Worker.prototype.postMessage;
  let workerMessageCount = 0;  // Debug counter
  Worker.prototype.postMessage = function(message, ...args) {
    workerMessageCount++;

    // ─────────────────────────────────────────────────────────────────
    // DEBUG: Log ALL Worker.postMessage calls to understand the pattern
    // Logs go to both DevTools console AND extension console panel
    // ─────────────────────────────────────────────────────────────────
    const msgType = message === null ? 'null' :
                    message === undefined ? 'undefined' :
                    ArrayBuffer.isView(message) ? `TypedArray(${message.constructor.name}, ${message.length})` :
                    message instanceof ArrayBuffer ? `ArrayBuffer(${message.byteLength})` :
                    Array.isArray(message) ? `Array(${message.length})` :
                    typeof message;

    // Log first 10 messages or any that look like config (to extension console)
    // Also log to browser console for DevTools debugging
    if (workerMessageCount <= 10) {
      const logData = typeof message === 'object' && message !== null && !ArrayBuffer.isView(message)
        ? JSON.stringify(message, null, 2).substring(0, 500)
        : '(binary/array data)';
      debugLog(`Worker.postMessage #${workerMessageCount} type=${msgType}`, logData);

      // Also log full message to browser console for detailed inspection
      if (typeof message === 'object' && message !== null && !ArrayBuffer.isView(message)) {
        console.log(`[Early] Worker.postMessage #${workerMessageCount} type=${msgType}:`, JSON.stringify(message, null, 2).substring(0, 500));

        // Check if this looks like audio-related message
        const keys = Object.keys(message);
        const audioKeywords = ['sample', 'rate', 'buffer', 'channel', 'bit', 'encode', 'init', 'start', 'record', 'audio', 'codec', 'mp3', 'opus', 'aac'];
        const hasAudioKey = keys.some(k => audioKeywords.some(kw => k.toLowerCase().includes(kw)));
        if (hasAudioKey) {
          console.log(`[Early] Worker.postMessage AUDIO:`, JSON.stringify(message, null, 2));
        }
      }
    }

    if (message && typeof message === 'object' && !ArrayBuffer.isView(message) && !(message instanceof ArrayBuffer)) {
      let encoderInfo = null;

      // ─────────────────────────────────────────────────────────────────
      // DEBUG: Log audio-related Worker.postMessage calls
      // ─────────────────────────────────────────────────────────────────
      const msgKeys = Object.keys(message);
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
          if (filename.includes('wav') || url.includes('wav')) return 'wav';
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

        encoderInfo = {
          type: codec,
          codec: codec,
          library: library,  // LAME, libopus, FDK AAC, libvorbis, libFLAC
          container: codec === 'unknown' ? null : codec,  // Only set container if codec is known
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
        console.log(`[Early] Encoder init detected (${encoderInfo.pattern}): ${codec.toUpperCase()}${libraryInfo}, ${encoderInfo.sampleRate}Hz, buffer=${encoderInfo.bufferSize}, worker=${workerMeta?.filename || 'unknown'}`);
        console.log(`[Early] Full encoderInfo:`, JSON.stringify(encoderInfo, null, 2));
      }

      // Notify handler if encoder detected
      if (encoderInfo) {
        console.log(`[Early] Notifying handler, registered: ${!!window.__wasmEncoderHandler}`);
        if (window.__wasmEncoderHandler) {
          window.__wasmEncoderHandler(encoderInfo);
        } else {
          console.log(`[Early] WARNING: Handler not registered, encoderInfo will be lost!`);
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
    // Audio MIME types that indicate encoding (with encoder info)
    const AUDIO_MIME_TYPES = {
      'audio/mp3': { codec: 'mp3', container: 'mp3', encoder: 'lamejs' },
      'audio/mpeg': { codec: 'mp3', container: 'mp3', encoder: 'lamejs' },
      'audio/wav': { codec: 'pcm', container: 'wav', encoder: null },
      'audio/wave': { codec: 'pcm', container: 'wav', encoder: null },
      'audio/ogg': { codec: 'vorbis', container: 'ogg', encoder: 'vorbis.js' },
      'audio/opus': { codec: 'opus', container: 'ogg', encoder: 'opus-recorder' },
      'audio/webm': { codec: 'opus', container: 'webm', encoder: 'opus-recorder' },
      'audio/aac': { codec: 'aac', container: 'aac', encoder: 'fdk-aac.js' },
      'audio/flac': { codec: 'flac', container: 'flac', encoder: 'libflac.js' }
    };

    window.Blob = new Proxy(OriginalBlob, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
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

              // Fallback: If no MediaRecorder tracking, start tracking on first audio blob
              // This handles cases where sites create audio blobs without MediaRecorder events
              if (!recordingState.startTime && !recordingState.duration) {
                recordingState.startTime = now;
                recordingState.active = true;
                recordingState.totalBytes = 0;
                recordingState.lastBlobSize = 0;
                recordingState.mode = 'unknown';
                recordingState.lastBitrateUpdateAt = 0;
                window.__recordingState = recordingState;
                debugLog('Blob tracking started', 'No MediaRecorder events detected, using blob-based tracking');
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

              const encoderInfo = {
                type: audioInfo.codec,
                codec: audioInfo.codec,
                encoder: audioInfo.encoder,  // lamejs, opus-recorder, fdk-aac.js, vorbis.js, libflac.js
                container: audioInfo.container,
                mimeType: mimeType,
                blobSize: blobSize,
                recordingDuration: recordingDuration,  // Duration in seconds
                calculatedBitRate: calculatedBitRate,  // Calculated from blob size / duration
                isLiveEstimate: recordingState.active === true,
                timestamp: Date.now(),
                source: 'blob-creation',
                pattern: 'audio-blob'
              };

              const encoderNameInfo = audioInfo.encoder ? ` [${audioInfo.encoder}]` : '';
              const durationInfo = recordingDuration ? `, ${recordingDuration.toFixed(1)}s` : '';
              const bitrateInfo = calculatedBitRate ? `, ~${Math.round(calculatedBitRate / 1000)}kbps` : '';
              debugLog(`Audio Blob created`, `${mimeType}${encoderNameInfo}, ${(blobSize / 1024).toFixed(1)}KB${durationInfo}${bitrateInfo}`);

              // Notify WASM encoder handler (unified detection)
              // Note: All blob data goes through wasmEncoderHandler for pattern priority
              if (shouldUpdateBitrate && window.__wasmEncoderHandler) {
                window.__wasmEncoderHandler(encoderInfo);
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
