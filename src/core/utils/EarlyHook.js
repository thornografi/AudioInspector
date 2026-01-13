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
import { LOG_PREFIX } from '../constants.js';

/** @type {boolean} */
let hooksInstalled = false;

/** @type {{audioContexts: Array<{instance: AudioContext, timestamp: number, sampleRate: number, state: string}>, rtcPeerConnections: Array<{instance: RTCPeerConnection, timestamp: number}>, audioWorklets: Array<{moduleUrl: string, timestamp: number}>, mediaRecorders: Array<{instance: MediaRecorder, timestamp: number}>}} */
const instanceRegistry = {
  audioContexts: [],
  rtcPeerConnections: [],
  audioWorklets: [],
  mediaRecorders: []
};

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

  // Hook Worker.postMessage for WASM encoder detection
  const originalPostMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...args) {
    if (message && typeof message === 'object') {
      let encoderInfo = null;
      let isEncodeData = false;

      // Pattern 1: Direct format (opus-recorder)
      // { command: 'init', encoderSampleRate: 48000, encoderBitRate: 128000, ... }
      if (message.command === 'init' && message.encoderSampleRate) {
        encoderInfo = {
          type: 'opus',
          sampleRate: message.encoderSampleRate,
          bitRate: message.encoderBitRate || 0,
          channels: message.numberOfChannels || 1,
          application: message.encoderApplication, // 2048=Voice, 2049=FullBand, 2051=LowDelay
          timestamp: Date.now(),
          pattern: 'direct',
          status: 'initialized' // NEW: Track init vs active
        };
      }

      // Pattern 2: Nested config format
      // { type: "message", message: { command: "encode-init", config: { ... } } }
      else if (message.type === 'message' &&
               message.message?.command === 'encode-init' &&
               message.message?.config) {
        const config = message.message.config;
        encoderInfo = {
          type: 'opus',
          sampleRate: config.encoderSampleRate || config.sampleRate || 0,
          bitRate: config.bitRate || config.encoderBitRate || 0,
          channels: config.numberOfChannels || 1,
          application: config.encoderApplication || 2048, // Default to VOIP
          originalSampleRate: config.originalSampleRate,
          frameSize: config.encoderFrameSize,
          bufferLength: config.bufferLength,
          timestamp: Date.now(),
          pattern: 'nested',
          status: 'initialized' // NEW: Track init vs active
        };
      }

      // NEW: Detect actual encode commands (verify encoder is being used)
      // Pattern: { command: 'encode', ... } or { type: 'message', message: { command: 'encode', ... } }
      else if (message.command === 'encode' ||
               (message.type === 'message' && message.message?.command === 'encode')) {
        isEncodeData = true;
      }

      // If encoder detected (init), store and notify
      if (encoderInfo) {
        // Store globally for late-discovery
        // @ts-ignore
        window.__wasmEncoderDetected = encoderInfo;

        // Notify handler if registered
        // @ts-ignore
        if (window.__wasmEncoderHandler) {
          // @ts-ignore
          window.__wasmEncoderHandler(encoderInfo);
        }

        logger.info(
          LOG_PREFIX.INSPECTOR,
          `🔧 WASM Opus encoder INITIALIZED (${encoderInfo.pattern}): ${encoderInfo.bitRate/1000}kbps, ${encoderInfo.sampleRate}Hz, ${encoderInfo.channels}ch`
        );
      }

      // If encode data detected, update status to 'encoding'
      if (isEncodeData && window.__wasmEncoderDetected) {
        // @ts-ignore
        if (window.__wasmEncoderDetected.status !== 'encoding') {
          // @ts-ignore
          window.__wasmEncoderDetected.status = 'encoding';
          // @ts-ignore
          window.__wasmEncoderDetected.firstEncodeTimestamp = Date.now();

          // Notify handler of status change
          // @ts-ignore
          if (window.__wasmEncoderHandler) {
            // @ts-ignore
            window.__wasmEncoderHandler(window.__wasmEncoderDetected);
          }

          logger.info(LOG_PREFIX.INSPECTOR, '🔧 WASM Opus encoder ACTIVELY ENCODING');
        }
      }
    }
    return originalPostMessage.apply(this, [message, ...args]);
  };
  logger.info(LOG_PREFIX.INSPECTOR, '✅ Hooked Worker.postMessage for WASM encoder detection');

  logger.info(LOG_PREFIX.INSPECTOR, '✅ Early hooks installed successfully');
}

/**
 * Get the instance registry containing all captured instances
 * @returns {{audioContexts: Array<{instance: AudioContext, timestamp: number, sampleRate: number, state: string}>, rtcPeerConnections: Array<{instance: RTCPeerConnection, timestamp: number}>, audioWorklets: Array<{moduleUrl: string, timestamp: number}>}}
 */
export function getInstanceRegistry() {
  return instanceRegistry;
}

/**
 * Clear the instance registry (for testing/cleanup)
 */
export function clearInstanceRegistry() {
  instanceRegistry.audioContexts = [];
  instanceRegistry.rtcPeerConnections = [];
  instanceRegistry.audioWorklets = [];
  instanceRegistry.mediaRecorders = [];
  logger.info(LOG_PREFIX.INSPECTOR, 'Instance registry cleared');
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
