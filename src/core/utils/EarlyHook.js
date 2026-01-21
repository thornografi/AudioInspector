// @ts-check

/**
 * Early Hook Installation
 *
 * Installs API hooks BEFORE PageInspector initialization to capture
 * APIs created at page load time.
 *
 * This solves the timing issue where hooks were installed AFTER
 * AudioContext/RTCPeerConnection were already created by the page.
 */

import { logger } from '../Logger.js';
import { LOG_PREFIX, ENCODER_KEYWORDS } from '../constants.js';

/** @type {boolean} */
let hooksInstalled = false;

/** @type {{audioContexts: Array<{instance: AudioContext, timestamp: number, sampleRate: number, state: string, methodCalls?: Array<{type: string, timestamp: number, [key: string]: any}>}>, rtcPeerConnections: Array<{instance: RTCPeerConnection, timestamp: number}>, mediaRecorders: Array<{instance: MediaRecorder, timestamp: number}>, audioWorkletNodes: Array<{instance: AudioWorkletNode, context: AudioContext, processorName: string, timestamp: number}>}} */
const instanceRegistry = {
  audioContexts: [],
  rtcPeerConnections: [],
  mediaRecorders: [],
  audioWorkletNodes: []
};

// Shared AudioNode ID map - single source of truth across early-inject.js + collectors
function getNodeIdMap() {
  // @ts-ignore
  const existing = window.__audioInspectorNodeIdMap;
  if (existing && typeof existing.get === 'function' && typeof existing.set === 'function') {
    return existing;
  }
  const map = new WeakMap();
  // @ts-ignore
  window.__audioInspectorNodeIdMap = map;
  return map;
}

function getNextNodeId() {
  // @ts-ignore
  const current = Number.isInteger(window.__audioInspectorNodeIdCounter)
    // @ts-ignore
    ? window.__audioInspectorNodeIdCounter
    : 0;
  const next = current + 1;
  // @ts-ignore
  window.__audioInspectorNodeIdCounter = next;
  return `node_${next}`;
}

/**
 * @param {any} node
 * @returns {string|null}
 */
function getOrAssignNodeId(node) {
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) return null;
  const map = getNodeIdMap();
  let id = map.get(node);
  if (!id) {
    id = getNextNodeId();
    map.set(node, id);
  }
  return id;
}

/**
 * Factory function to create constructor hooks with common pattern
 * @param {Object} config - Hook configuration
 * @param {string} config.globalName - Global object name (e.g., 'AudioContext')
 * @param {string} config.registryKey - Key in instanceRegistry (e.g., 'audioContexts')
 * @param {string} config.handlerName - Collector handler name (e.g., '__audioContextCollectorHandler')
 * @param {Function} [config.extractMetadata] - Optional function to extract custom metadata from instance
 * @param {Function} [config.getLogMessage] - Optional function to generate custom log message
 * @param {Function} [config.getOriginal] - Optional function to get original constructor (for aliases like webkitAudioContext)
 */
function createConstructorHook(config) {
  const {
    globalName,
    registryKey,
    handlerName,
    extractMetadata = (instance) => ({ instance, timestamp: Date.now() }),
    getLogMessage = () => `📡 Early hook: ${globalName} created`,
    getOriginal = () => window[globalName]
  } = config;

  const OriginalConstructor = getOriginal();
  if (!OriginalConstructor) {
    logger.warn(LOG_PREFIX.INSPECTOR, `${globalName} not available, skipping hook`);
    return;
  }

  window[globalName] = new Proxy(OriginalConstructor, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);

      // Store instance in registry with custom metadata
      const metadata = extractMetadata(instance, args);
      instanceRegistry[registryKey].push(metadata);

      // Log creation with custom message
      const logMessage = getLogMessage(instance, instanceRegistry[registryKey].length);
      logger.info(LOG_PREFIX.INSPECTOR, logMessage);

      // Notify collector handler if registered
      // @ts-ignore
      if (window[handlerName]) {
        // @ts-ignore
        window[handlerName](instance, args);
      }

      return instance;
    }
  });

  logger.info(LOG_PREFIX.INSPECTOR, `✅ Hooked ${globalName} constructor`);
}

/** @type {boolean} */
let getUserMediaHooked = false;

/**
 * Hook getUserMedia with lazy mediaDevices support
 * Some sites create mediaDevices lazily, so we need to watch for it
 */
function hookGetUserMedia() {
  // Already hooked
  if (getUserMediaHooked) return;

  // Try immediate hook if mediaDevices exists
  if (navigator.mediaDevices?.getUserMedia) {
    const originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const stream = await originalGUM(constraints);

      if (constraints?.audio) {
        logger.info(LOG_PREFIX.INSPECTOR, `📡 Early hook: getUserMedia captured (stream ${stream.id})`);

        // Notify collector handler if registered
        // @ts-ignore
        if (window.__getUserMediaCollectorHandler) {
          // @ts-ignore
          window.__getUserMediaCollectorHandler(stream, [constraints]);
        }
      }

      return stream;
    };

    getUserMediaHooked = true;
    logger.info(LOG_PREFIX.INSPECTOR, '✅ Hooked navigator.mediaDevices.getUserMedia');
    return;
  }

  // Lazy hook: Watch for mediaDevices to be created via property setter
  // Some sites/frameworks create mediaDevices after page load
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  let _mediaDevices = navigator.mediaDevices; // Current value (likely undefined)

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    enumerable: true,
    get() {
      return _mediaDevices;
    },
    set(value) {
      _mediaDevices = value;

      // When mediaDevices is set, try to hook getUserMedia
      if (!getUserMediaHooked && value?.getUserMedia) {
        const originalGUM = value.getUserMedia.bind(value);

        value.getUserMedia = async function(constraints) {
          const stream = await originalGUM(constraints);

          if (constraints?.audio) {
            logger.info(LOG_PREFIX.INSPECTOR, `📡 Early hook: getUserMedia captured (stream ${stream.id})`);

            // @ts-ignore
            if (window.__getUserMediaCollectorHandler) {
              // @ts-ignore
              window.__getUserMediaCollectorHandler(stream, [constraints]);
            }
          }

          return stream;
        };

        getUserMediaHooked = true;
        logger.info(LOG_PREFIX.INSPECTOR, '✅ Hooked navigator.mediaDevices.getUserMedia (lazy)');
      }
    }
  });

  logger.info(LOG_PREFIX.INSPECTOR, '⏳ Waiting for navigator.mediaDevices (lazy hook installed)');
}

/**
 * Hook AudioWorkletNode.port.postMessage for encoder detection
 * AudioWorklet processors (like web-based opus encoders) communicate via MessagePort
 * This is different from Worker.postMessage - AudioWorklet uses node.port
 *
 * @param {AudioWorkletNode} node - The AudioWorkletNode instance
 * @param {string} processorName - The processor name (e.g., 'encoder-worklet', 'opus-encoder')
 */
function hookAudioWorkletNodePort(node, processorName) {
  if (!node?.port?.postMessage) return;

  const originalPortPostMessage = node.port.postMessage.bind(node.port);

  node.port.postMessage = function(message, ...args) {
    if (message && typeof message === 'object') {
      let encoderInfo = null;

      // ═══════════════════════════════════════════════════════════════════
      // AudioWorklet Encoder Patterns
      // These patterns are specific to AudioWorklet-based encoders
      // ═══════════════════════════════════════════════════════════════════

      // Pattern A: Simple init with sampleRate
      // { type: 'init', sampleRate: 48000, ... } or { init: true, ... }
      // GUARD: Only trigger if processor name suggests audio encoding
      // Uses ENCODER_KEYWORDS from constants.js (single source of truth)
      const procNameLC = (processorName || '').toLowerCase();
      const looksLikeEncoder = ENCODER_KEYWORDS.some(kw => procNameLC.includes(kw));

      // Detect codec from processor name
      const detectCodecFromName = (name) => {
        const n = (name || '').toLowerCase();
        if (n.includes('opus')) return 'opus';
        if (n.includes('mp3') || n.includes('lame')) return 'mp3';
        if (n.includes('aac')) return 'aac';
        if (n.includes('vorbis') || n.includes('ogg')) return 'vorbis';
        if (n.includes('flac')) return 'flac';
        return 'unknown'; // don't guess - blob can confirm post-hoc
      };

      // Detect encoder from processor name
      const detectEncoderFromName = (name, codec) => {
        const n = (name || '').toLowerCase();
        if (n.includes('lame')) return 'lamejs';
        if (n.includes('fdk')) return 'fdk-aac.js';
        if (n.includes('libopus') || n.includes('opus')) return 'opus-recorder';
        if (n.includes('libvorbis') || n.includes('vorbis')) return 'vorbis.js';
        if (n.includes('libflac') || n.includes('flac')) return 'libflac.js';
        // Default by codec
        const defaults = { opus: 'opus-recorder', mp3: 'lamejs', aac: 'fdk-aac.js', vorbis: 'vorbis.js', flac: 'libflac.js' };
        return defaults[codec] || null;
      };

      if (looksLikeEncoder && (message.type === 'init' || message.init === true) && (message.sampleRate || message.rate)) {
        const codec = detectCodecFromName(processorName);
        const encoder = detectEncoderFromName(processorName, codec);

        encoderInfo = {
          type: codec,
          encoder: encoder,
          sampleRate: message.sampleRate || message.rate || 48000,
          bitRate: message.bitRate || message.bitrate || 0,
          channels: message.channels || message.channelCount || 1,
          timestamp: Date.now(),
          pattern: 'audioworklet-init',
          source: 'audioworklet-port',
          processorName: processorName,
          status: 'initialized'
        };
      }

      // Pattern B: Encoder config with encoder-related keys (opus-recorder style)
      // Format: { command: 'init', encoderSampleRate: 48000, numberOfChannels: 1, encoderApplication: 2049, ... }
      else if (message.encoderSampleRate || message.encoderBitRate ||
               (message.config && (message.config.sampleRate || message.config.bitRate))) {
        const config = message.config || message;

        // Opus application type mapping (official terminology)
        // OPUS_APPLICATION_VOIP, OPUS_APPLICATION_AUDIO, OPUS_APPLICATION_LOWDELAY
        const appNames = { 2048: 'VoIP', 2049: 'Audio', 2051: 'LowDelay' };
        const application = config.encoderApplication ?? config.application;

        // Detect codec: prefer explicit hints, otherwise keep as unknown (blob can confirm post-hoc)
        let codec = (application !== undefined && application !== null) ? 'opus' : 'unknown';
        if (config.mp3BitRate || config.lameConfig) codec = 'mp3';
        else if (config.aacProfile || config.aacObjectType) codec = 'aac';
        else if (config.vorbisQuality) codec = 'vorbis';
        else if (config.flacCompression) codec = 'flac';

        const encoder = detectEncoderFromName(processorName, codec);

        // Container format detection (audio-only: OGG, WebM - not MP4/M4A which don't support Opus)
        // streamPages/maxFramesPerPage indicates OGG container (page-based format)
        // encoderPath can hint at container type
        let container = null;
        if (config.streamPages !== undefined || config.maxFramesPerPage !== undefined) {
          container = 'ogg';
        } else if (config.encoderPath) {
          const pathLC = config.encoderPath.toLowerCase();
          if (pathLC.includes('ogg')) container = 'ogg';
          else if (pathLC.includes('webm')) container = 'webm';
          else if (pathLC.includes('mp3') || pathLC.includes('lame')) container = 'mp3';
          else if (pathLC.includes('aac') || pathLC.includes('m4a')) container = 'aac';
          else if (pathLC.includes('flac')) container = 'flac';
        }

        encoderInfo = {
          type: codec,
          encoder: encoder,
          sampleRate: config.encoderSampleRate || config.sampleRate || 48000,
          originalSampleRate: config.originalSampleRate || null,
          bitRate: config.encoderBitRate || config.bitRate || config.mp3BitRate || 0,
          channels: config.numberOfChannels || config.channels || 1,
          frameSize: config.encoderFrameSize || null,
          application: application,
          applicationName: appNames[application] || null,
          container: container,  // 'ogg', 'webm', 'mp3', 'aac', 'flac', or null
          encoderPath: config.encoderPath || null,  // WASM module path
          bitDepth: config.wavBitDepth || null,
          timestamp: Date.now(),
          pattern: 'audioworklet-config',
          source: 'audioworklet-port',
          processorName: processorName,
          status: 'initialized'
        };
      }

      // Pattern C: REMOVED (audioworklet-name-heuristic)
      // Bu pattern kaldırıldı çünkü:
      // 1. Pattern B (audioworklet-config) zaten daha zengin bilgi sağlıyor
      // 2. Heuristic pattern duplicate emit yapıyordu (race condition)
      // 3. Zengin bilgiyi (frameSize, container, applicationName) fakir bilgiyle eziyordu
      // Eğer sadece isimden tespit gerekirse, AudioContextCollector._handleAudioWorkletNode() kullanılır

      // Notify handler if encoder detected
      if (encoderInfo) {
        // @ts-ignore
        if (window.__wasmEncoderHandler) {
          // @ts-ignore
          window.__wasmEncoderDetected = encoderInfo;
          // @ts-ignore
          window.__wasmEncoderHandler(encoderInfo);

          logger.info(
            LOG_PREFIX.INSPECTOR,
            `🔧 AudioWorklet encoder detected (${encoderInfo.pattern}): ${processorName}, ${encoderInfo.sampleRate}Hz`
          );
        }
      }
    }

    return originalPortPostMessage(message, ...args);
  };

  logger.info(LOG_PREFIX.INSPECTOR, `✅ Hooked AudioWorkletNode.port.postMessage (processor: ${processorName})`);
}

/**
 * Sync early captures from early-inject.js to instanceRegistry
 * Called when early-inject.js already installed hooks before page.js loaded
 */
function syncEarlyCaptures() {
  // @ts-ignore - early-inject.js creates this
  const earlyCaptures = window.__earlyCaptures;
  if (!earlyCaptures) return;

  // Sync AudioContexts (INCLUDING methodCalls for ScriptProcessor etc.)
  if (earlyCaptures.audioContexts?.length) {
    for (const capture of earlyCaptures.audioContexts) {
      instanceRegistry.audioContexts.push({
        instance: capture.instance,
        timestamp: capture.timestamp,
        sampleRate: capture.sampleRate,
        state: capture.state,
        methodCalls: capture.methodCalls || []  // ← CRITICAL: Sync methodCalls too!
      });
    }
    logger.info(LOG_PREFIX.INSPECTOR, `📥 Synced ${earlyCaptures.audioContexts.length} AudioContext(s) from early-inject`);
  }

  // Sync RTCPeerConnections
  if (earlyCaptures.rtcPeerConnections?.length) {
    for (const capture of earlyCaptures.rtcPeerConnections) {
      instanceRegistry.rtcPeerConnections.push({
        instance: capture.instance,
        timestamp: capture.timestamp
      });
    }
    logger.info(LOG_PREFIX.INSPECTOR, `📥 Synced ${earlyCaptures.rtcPeerConnections.length} RTCPeerConnection(s) from early-inject`);
  }

  // Sync MediaRecorders
  if (earlyCaptures.mediaRecorders?.length) {
    for (const capture of earlyCaptures.mediaRecorders) {
      instanceRegistry.mediaRecorders.push({
        instance: capture.instance,
        timestamp: capture.timestamp
      });
    }
    logger.info(LOG_PREFIX.INSPECTOR, `📥 Synced ${earlyCaptures.mediaRecorders.length} MediaRecorder(s) from early-inject`);
  }

  // Note: getUserMedia captures are handled differently - they go directly to collector via handler
}

/**
 * Install early hooks for AudioContext and RTCPeerConnection
 * Must be called BEFORE PageInspector.initialize()
 */
export function installEarlyHooks() {
  if (hooksInstalled) {
    logger.warn(LOG_PREFIX.INSPECTOR, 'Early hooks already installed');
    return;
  }

  hooksInstalled = true;

  // Check if early-inject.js already installed hooks
  // @ts-ignore
  const earlyHooksAlreadyInstalled = !!window.__audioInspectorEarlyHooksInstalled;

  if (earlyHooksAlreadyInstalled) {
    logger.info(LOG_PREFIX.INSPECTOR, '📥 early-inject.js already installed constructor hooks - syncing captures');
    syncEarlyCaptures();
  } else {
    // Fallback: Install hooks here if early-inject.js didn't run
    // (e.g., CSP blocked it, or running in different context)
    logger.info(LOG_PREFIX.INSPECTOR, '⚡ Installing constructor hooks (early-inject.js not found)');

    // Hook AudioContext with custom metadata extraction
    createConstructorHook({
      globalName: 'AudioContext',
      registryKey: 'audioContexts',
      handlerName: '__audioContextCollectorHandler',
      getOriginal: () => window.AudioContext || window.webkitAudioContext,
      extractMetadata: (ctx) => ({
        instance: ctx,
        timestamp: Date.now(),
        sampleRate: ctx.sampleRate,
        state: ctx.state
      }),
      getLogMessage: (ctx, count) =>
        `📡 Early hook: AudioContext created (${ctx.sampleRate}Hz, ${ctx.state})\n` +
        `📡 Registry now has ${count} AudioContext(s)`
    });

    // Hook RTCPeerConnection
    createConstructorHook({
      globalName: 'RTCPeerConnection',
      registryKey: 'rtcPeerConnections',
      handlerName: '__rtcPeerConnectionCollectorHandler'
    });

    // Hook MediaRecorder
    createConstructorHook({
      globalName: 'MediaRecorder',
      registryKey: 'mediaRecorders',
      handlerName: '__mediaRecorderCollectorHandler'
    });

    // Hook getUserMedia with lazy mediaDevices support
    hookGetUserMedia();
  }

  // Hook AudioWorkletNode - captures custom DSP processor instances
  // Also hooks node.port.postMessage for AudioWorklet-based encoder detection
  createConstructorHook({
    globalName: 'AudioWorkletNode',
    registryKey: 'audioWorkletNodes',
    handlerName: '__audioWorkletNodeHandler',
    extractMetadata: (node, args) => {
      // Hook node.port.postMessage for encoder detection
      hookAudioWorkletNodePort(node, args[1]);

      return {
        instance: node,
        context: args[0],           // AudioContext referansı
        processorName: args[1],     // processor adı (örn: 'opus-encoder', 'noise-suppressor')
        options: args[2],           // opsiyonel parametreler
        timestamp: Date.now()
      };
    },
    getLogMessage: (node, count) =>
      `📡 Early hook: AudioWorkletNode created (processor: ${node?.parameters ? 'with params' : 'basic'})\n` +
      `📡 Registry now has ${count} AudioWorkletNode(s)`
  });

  // Hook Worker.postMessage for WASM encoder detection (Opus, MP3, AAC, etc.)
  const originalPostMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...args) {
    if (message && typeof message === 'object') {
      let encoderInfo = null;
      let isEncodeData = false;

      // Helper: Detect codec type from message keys or explicit type field
      // ⚠️ SYNC: Similar logic in early-inject.js:detectCodec() - keep patterns consistent
      const detectCodecType = (msg) => {
        // Explicit codec field
        if (msg.codec) return msg.codec.toLowerCase();
        if (msg.type && ['opus', 'mp3', 'aac', 'vorbis', 'flac'].includes(msg.type.toLowerCase())) {
          return msg.type.toLowerCase();
        }

        // ═══════════════════════════════════════════════════════════════════
        // CODEC-SPECIFIC HEURISTICS
        // Her encoder kütüphanesinin kendine özgü pattern'leri var
        // ═══════════════════════════════════════════════════════════════════

        // OPUS: encoderApplication (2048=VoIP, 2049=Audio, 2051=LowDelay)
        if (msg.encoderApplication !== undefined) return 'opus';

        // MP3/LAME: lamejs ve benzeri kütüphaneler
        // - mp3BitRate: explicit bitrate
        // - mp3Mode: stereo mode (0=stereo, 1=joint stereo, 2=dual channel, 3=mono)
        // - lameConfig: lamejs configuration object
        // - vbrQuality: VBR quality (0-9, lower is better)
        // - kbps: shorthand bitrate (lamejs pattern)
        if (msg.mp3BitRate !== undefined ||
            msg.mp3Mode !== undefined ||
            msg.lameConfig !== undefined ||
            msg.vbrQuality !== undefined ||
            (msg.kbps !== undefined && !msg.encoderApplication)) {
          return 'mp3';
        }

        // AAC/FDK: fdk-aac ve benzeri kütüphaneler
        // - aacProfile: AAC profile (AAC-LC, HE-AAC, HE-AACv2)
        // - aacObjectType: MPEG-4 audio object type (2=AAC-LC, 5=HE-AAC, 29=HE-AACv2)
        // - afterburner: FDK-AAC specific quality enhancement
        // - signallingMode: SBR signalling mode
        if (msg.aacProfile !== undefined ||
            msg.aacObjectType !== undefined ||
            msg.afterburner !== undefined ||
            msg.signallingMode !== undefined) {
          return 'aac';
        }

        // VORBIS/libvorbis: Ogg Vorbis encoder
        // - vorbisQuality: quality setting (-0.1 to 1.0)
        // - vorbisMode: encoding mode
        // - bitrateManagement: VBR/ABR/CBR mode
        if (msg.vorbisQuality !== undefined ||
            msg.vorbisMode !== undefined ||
            (msg.bitrateManagement !== undefined && !msg.aacProfile)) {
          return 'vorbis';
        }

        // FLAC/libFLAC: lossless compression
        // - flacCompression: compression level (0-8)
        // - flacBlockSize: block size
        // - verifyEncoding: FLAC verification mode
        if (msg.flacCompression !== undefined ||
            msg.flacBlockSize !== undefined ||
            msg.verifyEncoding !== undefined) {
          return 'flac';
        }

        // Unknown: avoid false "opus" positives; blob detection can confirm post-hoc
        return 'unknown';
      };

      // Helper: Detect encoder name from worker URL or message
      const detectEncoderName = (msg, codecType) => {
        // Worker URL'den tespit (daha güvenilir)
        const workerUrl = msg.encoderPath || msg.wasmPath || '';
        const workerUrlLower = workerUrl.toLowerCase();

        // lamejs patterns
        if (workerUrlLower.includes('lame') || workerUrlLower.includes('mp3')) {
          return 'lamejs';
        }
        // opus-recorder patterns
        if (workerUrlLower.includes('opus')) {
          return 'opus-recorder';
        }
        // fdk-aac.js patterns
        if (workerUrlLower.includes('fdk') || workerUrlLower.includes('aac')) {
          return 'fdk-aac.js';
        }
        // vorbis.js patterns
        if (workerUrlLower.includes('vorbis') || workerUrlLower.includes('ogg')) {
          return 'vorbis.js';
        }
        // libflac.js patterns
        if (workerUrlLower.includes('flac')) {
          return 'libflac.js';
        }

        // Codec'den varsayılan encoder
        const defaultEncoders = {
          opus: 'opus-recorder',
          mp3: 'lamejs',
          aac: 'fdk-aac.js',
          vorbis: 'vorbis.js',
          flac: 'libflac.js'
        };
        return defaultEncoders[codecType] || null;
      };

      // Helper: Detect container format from message properties
      // OGG detection relies on OGG-specific muxing parameters
      const detectContainer = (msg, codec = null) => {
        // OGG-specific parameters (OGG page/stream configuration)
        // streamPages: enables OGG page streaming
        // maxFramesPerPage: frames per OGG page
        // maxBuffersPerPage: buffers per OGG page (WhatsApp pattern)
        // resampleQuality: OGG resampler quality setting
        if (msg.streamPages !== undefined ||
            msg.maxFramesPerPage !== undefined ||
            msg.maxBuffersPerPage !== undefined ||
            msg.resampleQuality !== undefined) {
          return 'ogg';
        }

        // Explicit mimeType field
        if (msg.mimeType) {
          const mime = msg.mimeType.toLowerCase();
          if (mime.includes('ogg')) return 'ogg';
          if (mime.includes('webm')) return 'webm';
          if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
          if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3';
          if (mime.includes('aac')) return 'aac'; // Raw AAC (ADTS)
          if (mime.includes('wav') || mime.includes('wave')) return 'wav';
          if (mime.includes('flac')) return 'flac';
        }

        // Path-based detection (encoderPath contains container hint)
        if (msg.encoderPath) {
          const pathLC = msg.encoderPath.toLowerCase();
          if (pathLC.includes('ogg')) return 'ogg';
          if (pathLC.includes('webm')) return 'webm';
          if (pathLC.includes('mp4') || pathLC.includes('m4a')) return 'mp4';
          if (pathLC.includes('mp3') || pathLC.includes('lame')) return 'mp3';
          if (pathLC.includes('aac')) return 'aac';
          if (pathLC.includes('flac')) return 'flac';
        }

        // WebM-specific parameters
        if (msg.webmDuration !== undefined || msg.clusterTimecode !== undefined) {
          return 'webm';
        }

        // MP3-specific parameters (lamejs pattern) - MP3 is self-contained (no separate container)
        if (msg.mp3BitRate !== undefined || msg.mp3Mode !== undefined || msg.lameConfig !== undefined) {
          return 'mp3';
        }

        // AAC-specific parameters - typically in ADTS or MP4 container
        if (msg.aacProfile !== undefined || msg.aacObjectType !== undefined) {
          return 'aac'; // Raw AAC (ADTS format)
        }

        // FLAC-specific parameters
        if (msg.flacCompression !== undefined || msg.flacBlockSize !== undefined) {
          return 'flac';
        }

        // WAV-specific parameters (require explicit wavFormat, not just bitsPerSample)
        // bitsPerSample alone is too generic - used by many audio processors
        if (msg.wavFormat !== undefined) {
          return 'wav';
        }

        return null;
      };

      // Pattern 1: Direct format (opus-recorder, lamejs, etc.)
      // { command: 'init', encoderSampleRate: 48000, encoderBitRate: 128000, ... }
      if (message.command === 'init' && (message.encoderSampleRate || message.sampleRate)) {
        const codec = detectCodecType(message);
        const container = detectContainer(message);
        const encoder = detectEncoderName(message, codec);

        encoderInfo = {
          type: codec,
          encoder: encoder,  // lamejs, opus-recorder, fdk-aac.js, vorbis.js, libflac.js
          sampleRate: message.encoderSampleRate || message.sampleRate,
          bitRate: message.encoderBitRate || message.bitRate || message.mp3BitRate || 0,
          channels: message.numberOfChannels || message.channels || 1,
          application: message.encoderApplication, // Opus-specific: 2048=Voice, 2049=FullBand, 2051=LowDelay
          container: container,
          encoderPath: message.encoderPath || null,
          timestamp: Date.now(),
          pattern: 'direct',
          source: 'worker-postmessage',
          status: 'initialized'
        };
      }

      // Pattern 2: Nested config format
      // { type: "message", message: { command: "encode-init", config: { ... } } }
      else if (message.type === 'message' &&
               message.message?.command === 'encode-init' &&
               message.message?.config) {
        const config = message.message.config;
        const codec = detectCodecType(config);
        const container = detectContainer(config);
        const encoder = detectEncoderName(config, codec);

        encoderInfo = {
          type: codec,
          encoder: encoder,  // lamejs, opus-recorder, fdk-aac.js, vorbis.js, libflac.js
          sampleRate: config.encoderSampleRate || config.sampleRate || 0,
          bitRate: config.bitRate || config.encoderBitRate || config.mp3BitRate || 0,
          channels: config.numberOfChannels || config.channels || 1,
          application: config.encoderApplication, // Opus-specific
          container: container,
          encoderPath: config.encoderPath || null,
          originalSampleRate: config.originalSampleRate,
          frameSize: config.encoderFrameSize,
          bufferLength: config.bufferLength,
          timestamp: Date.now(),
          pattern: 'nested',
          source: 'worker-postmessage',
          status: 'initialized'
        };
      }

      // Pattern 3: lamejs MP3 encoder init
      // { cmd: 'init', config: { sampleRate, bitRate, channels } }
      else if ((message.cmd === 'init' || message.command === 'initialize') &&
               (message.config?.sampleRate || message.sampleRate)) {
        const config = message.config || message;
        const codec = detectCodecType(config);
        const container = detectContainer(config);
        const encoder = detectEncoderName(config, codec);

        encoderInfo = {
          type: codec,
          encoder: encoder,  // lamejs, opus-recorder, fdk-aac.js, vorbis.js, libflac.js
          sampleRate: config.sampleRate || 44100,
          bitRate: config.bitRate || config.kbps || 128000,
          channels: config.channels || config.numChannels || 2,
          container: container,
          encoderPath: config.encoderPath || null,
          timestamp: Date.now(),
          pattern: 'worker-init',
          source: 'worker-postmessage',
          status: 'initialized'
        };
      }

      // Detect actual encode commands (verify encoder is being used)
      // Pattern: { command: 'encode', ... } or { type: 'message', message: { command: 'encode', ... } }
      else if (message.command === 'encode' || message.cmd === 'encode' ||
               (message.type === 'message' && message.message?.command === 'encode')) {
        isEncodeData = true;
      }

      // If encoder detected (init), notify handler if active
      // IMPORTANT: Only store globally if handler is registered (collector is active)
      // This prevents stale encoder data from appearing after inspector restart
      if (encoderInfo) {
        // ═══════════════════════════════════════════════════════════════════
        // WORKER URL ENRICHMENT: Try to find matching worker from early captures
        // This adds workerUrl and workerFilename to encoder info
        // ═══════════════════════════════════════════════════════════════════
        // @ts-ignore
        const workers = window.__earlyCaptures?.workers;
        if (workers?.length > 0) {
          // Find the most recent encoder worker (likely the one sending this message)
          const encoderWorker = workers
            .filter(w => w.isEncoder)
            .sort((a, b) => b.timestamp - a.timestamp)[0];

          if (encoderWorker) {
            encoderInfo.workerUrl = encoderWorker.url;
            encoderInfo.workerFilename = encoderWorker.filename;
            encoderInfo.workerDomain = encoderWorker.domain;
          }
        }

        // @ts-ignore - Only notify if handler is registered (collector active)
        if (window.__wasmEncoderHandler) {
          // Store globally for late-discovery ONLY when collector is active
          // @ts-ignore
          window.__wasmEncoderDetected = encoderInfo;
          // @ts-ignore
          window.__wasmEncoderHandler(encoderInfo);

          const workerInfo = encoderInfo.workerFilename ? ` [${encoderInfo.workerFilename}]` : '';
          const encoderNameInfo = encoderInfo.encoder ? ` (${encoderInfo.encoder})` : '';
          logger.info(
            LOG_PREFIX.INSPECTOR,
            `🔧 WASM ${encoderInfo.type.toUpperCase()}${encoderNameInfo} encoder INITIALIZED (${encoderInfo.pattern}): ${(encoderInfo.bitRate || 0)/1000}kbps, ${encoderInfo.sampleRate}Hz, ${encoderInfo.channels}ch${workerInfo}`
          );
        }
        // If handler not registered, don't store - this is likely during inspector stopped state
      }

      // If encode data detected, update status to 'encoding'
      // @ts-ignore - Only process if handler is active and encoder was detected
      if (isEncodeData && window.__wasmEncoderDetected && window.__wasmEncoderHandler) {
        // @ts-ignore
        if (window.__wasmEncoderDetected.status !== 'encoding') {
          // @ts-ignore
          window.__wasmEncoderDetected.status = 'encoding';
          // @ts-ignore
          window.__wasmEncoderDetected.firstEncodeTimestamp = Date.now();

          // Notify handler of status change
          // @ts-ignore
          window.__wasmEncoderHandler(window.__wasmEncoderDetected);

          // @ts-ignore
          logger.info(LOG_PREFIX.INSPECTOR, `🔧 WASM ${window.__wasmEncoderDetected.type?.toUpperCase() || 'AUDIO'} encoder ACTIVELY ENCODING`);
        }
      }
    }
    return originalPostMessage.apply(this, [message, ...args]);
  };
  logger.info(LOG_PREFIX.INSPECTOR, '✅ Hooked Worker.postMessage for WASM encoder detection');

  // Install method hooks for AudioContext pipeline capture
  installMethodHooks();

  logger.info(LOG_PREFIX.INSPECTOR, '✅ Early hooks installed successfully');
}

/**
 * Method hook configurations - OCP: Add new hooks here without modifying factory
 *
 * ⚠️ SYNC REQUIRED: When adding a new processor type here, also add a corresponding
 * handler in AudioContextCollector.js → METHOD_CALL_SYNC_HANDLERS
 *
 * @type {Array<{methodName: string, registryKey: string, extractMetadata: Function, getLogMessage: Function}>}
 */
const METHOD_HOOK_CONFIGS = [
  // ScriptProcessor - deprecated but still used by some platforms (WhatsApp Web)
  // Chrome extension warnings are acceptable for this critical detection feature
  {
    methodName: 'createScriptProcessor',
    registryKey: 'scriptProcessor',
    extractMetadata: (args) => ({
      bufferSize: args[0] || 4096,
      inputChannels: args[1] || 2,
      outputChannels: args[2] || 2,
      timestamp: Date.now()
    }),
    getLogMessage: (args) => `📡 Early hook: createScriptProcessor(${args[0] || 4096}) captured`
  },
  {
    methodName: 'createAnalyser',
    registryKey: 'analyser',
    extractMetadata: () => ({ timestamp: Date.now() }),
    getLogMessage: () => '📡 Early hook: createAnalyser() captured'
  },
  {
    methodName: 'createMediaStreamSource',
    registryKey: 'mediaStreamSource',
    extractMetadata: (args) => ({
      streamId: args[0]?.id,
      timestamp: Date.now()
    }),
    getLogMessage: (args) => `📡 Early hook: createMediaStreamSource(${args[0]?.id}) captured`
  },
  {
    methodName: 'createMediaStreamDestination',
    registryKey: 'mediaStreamDestination',
    extractMetadata: () => ({ timestamp: Date.now() }),
    getLogMessage: () => '📡 Early hook: createMediaStreamDestination() captured'
  },
  // ═══════════════════════════════════════════════════════════════════
  // DSP Node Hooks - Web Audio API processing nodes
  // ═══════════════════════════════════════════════════════════════════
  {
    methodName: 'createGain',
    registryKey: 'gain',
    extractMetadata: () => ({ timestamp: Date.now() }),
    getLogMessage: () => '📡 Early hook: createGain() captured'
  },
  {
    methodName: 'createBiquadFilter',
    registryKey: 'biquadFilter',
    extractMetadata: (args, result) => ({
      filterType: result?.type || 'lowpass', // lowpass, highpass, bandpass, etc.
      timestamp: Date.now()
    }),
    getLogMessage: () => '📡 Early hook: createBiquadFilter() captured'
  },
  {
    methodName: 'createDynamicsCompressor',
    registryKey: 'dynamicsCompressor',
    extractMetadata: () => ({ timestamp: Date.now() }),
    getLogMessage: () => '📡 Early hook: createDynamicsCompressor() captured'
  },
  {
    methodName: 'createOscillator',
    registryKey: 'oscillator',
    extractMetadata: (args, result) => ({
      oscillatorType: result?.type || 'sine', // sine, square, sawtooth, triangle
      timestamp: Date.now()
    }),
    getLogMessage: () => '📡 Early hook: createOscillator() captured'
  },
  {
    methodName: 'createDelay',
    registryKey: 'delay',
    extractMetadata: (args) => ({
      maxDelayTime: args[0] || 1, // saniye cinsinden
      timestamp: Date.now()
    }),
    getLogMessage: (args) => `📡 Early hook: createDelay(${args[0] || 1}s) captured`
  },
  {
    methodName: 'createConvolver',
    registryKey: 'convolver',
    extractMetadata: () => ({ timestamp: Date.now() }),
    getLogMessage: () => '📡 Early hook: createConvolver() captured (reverb)'
  },
  {
    methodName: 'createWaveShaper',
    registryKey: 'waveShaper',
    extractMetadata: (args, result) => ({
      oversample: result?.oversample || 'none', // none, 2x, 4x
      timestamp: Date.now()
    }),
    getLogMessage: () => '📡 Early hook: createWaveShaper() captured (distortion)'
  },
  {
    methodName: 'createPanner',
    registryKey: 'panner',
    extractMetadata: (args, result) => ({
      panningModel: result?.panningModel || 'equalpower', // equalpower, HRTF
      timestamp: Date.now()
    }),
    getLogMessage: () => '📡 Early hook: createPanner() captured (3D audio)'
  }
];

/**
 * Factory function to create method hooks - DRY pattern
 * @param {Object} proto - Prototype to hook (AudioContext.prototype or webkitAudioContext.prototype)
 * @param {Object} config - Hook configuration
 * @param {string} protoName - Name for logging (e.g., 'AudioContext', 'webkitAudioContext')
 */
function createMethodHook(proto, config, protoName) {
  const { methodName, registryKey, extractMetadata, getLogMessage } = config;

  if (!proto[methodName]) return;

  const original = proto[methodName];
  proto[methodName] = function(...args) {
    const node = original.apply(this, args);

    // Look for context in BOTH registries (instanceRegistry AND earlyCaptures)
    // This handles the case where early-inject.js captured the context but
    // syncEarlyCaptures hasn't run yet (or page.js hasn't loaded yet)
    let entry = instanceRegistry.audioContexts.find(e => e.instance === this);

    // Fallback to earlyCaptures if not in instanceRegistry
    // @ts-ignore
    if (!entry && window.__earlyCaptures?.audioContexts) {
      // @ts-ignore
      entry = window.__earlyCaptures.audioContexts.find(e => e.instance === this);
    }

    if (entry) {
      // Array-based: preserves call order and multiple nodes of same type
      entry.methodCalls = entry.methodCalls || [];
      const methodCallData = {
        type: registryKey,
        nodeId: getOrAssignNodeId(node),
        ...extractMetadata(args, node)
      };
      entry.methodCalls.push(methodCallData);
      logger.info(LOG_PREFIX.INSPECTOR, getLogMessage(args, node));

      // ═══════════════════════════════════════════════════════════════════
      // REAL-TIME SYNC: Notify collector if handler is registered
      // This ensures activeContexts is updated immediately, not just registry
      // ═══════════════════════════════════════════════════════════════════
      // @ts-ignore
      if (window.__audioContextMethodCallHandler) {
        // @ts-ignore
        window.__audioContextMethodCallHandler(this, methodCallData);
      }
    }
    return node;
  };
  logger.info(LOG_PREFIX.INSPECTOR, `✅ Hooked ${protoName}.prototype.${methodName}`);
}

/**
 * Install method hooks for AudioContext to capture pipeline info
 * These hooks save method calls to registry (not emit) so they can be synced on start()
 *
 * IMPORTANT: Always install prototype hooks even if early-inject.js ran.
 * Reason: early-inject.js captures method calls only on contexts created BEFORE page.js loads.
 * For contexts created AFTER (or on inspector restart), prototype hooks are the only source.
 *
 * Deduplication is handled by AudioContextCollector._syncMethodCallsToExistingContext()
 * which uses WeakSet to track already-processed instances.
 */
function installMethodHooks() {
  // @ts-ignore - webkit fallback
  const prototypes = [
    { proto: AudioContext.prototype, name: 'AudioContext' },
    { proto: window.webkitAudioContext?.prototype, name: 'webkitAudioContext' }
  ].filter(p => p.proto);

  // Apply all hooks to all prototypes (DRY + webkit support)
  for (const { proto, name } of prototypes) {
    METHOD_HOOK_CONFIGS.forEach(config => createMethodHook(proto, config, name));
  }

  logger.info(LOG_PREFIX.INSPECTOR, `✅ Method hooks installed on ${prototypes.length} prototype(s)`);
}

/**
 * Get the instance registry containing all captured instances
 * @returns {{audioContexts: Array<{instance: AudioContext, timestamp: number, sampleRate: number, state: string, methodCalls?: Array<{type: string, timestamp: number}>}>, rtcPeerConnections: Array<{instance: RTCPeerConnection, timestamp: number}>, mediaRecorders: Array<{instance: MediaRecorder, timestamp: number}>, audioWorkletNodes: Array<{instance: AudioWorkletNode, context: AudioContext, processorName: string, timestamp: number}>}}
 */
export function getInstanceRegistry() {
  return instanceRegistry;
}

/**
 * Clear a specific key in the instance registry
 * @param {string} key - Registry key to clear (e.g., 'audioContexts', 'mediaRecorders')
 */
export function clearRegistryKey(key) {
  if (instanceRegistry[key]) {
    instanceRegistry[key] = [];
    logger.info(LOG_PREFIX.INSPECTOR, `Registry key '${key}' cleared`);
  }
}

/**
 * Remove closed AudioContexts from the registry
 * Prevents memory leaks and stale data accumulation
 * @returns {number} Number of closed contexts removed
 */
export function cleanupClosedAudioContexts() {
  const before = instanceRegistry.audioContexts.length;
  instanceRegistry.audioContexts = instanceRegistry.audioContexts.filter(
    entry => entry.instance.state !== 'closed'
  );
  const removed = before - instanceRegistry.audioContexts.length;
  if (removed > 0) {
    logger.info(LOG_PREFIX.INSPECTOR, `Cleaned up ${removed} closed AudioContext(s) from registry`);
  }
  return removed;
}
