// @ts-check

import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES, DESTINATION_TYPES, streamRegistry } from '../core/constants.js';
import { logger } from '../core/Logger.js';
import { hookAsyncMethod, hookMethod } from '../core/utils/ApiHook.js';
import { getInstanceRegistry, cleanupClosedAudioContexts } from '../core/utils/EarlyHook.js';

/**
 * Sync handlers for methodCalls - OCP: Add new handlers without modifying sync loop
 * Maps registry keys to pipeline sync functions
 * @type {Object<string, Function>}
 */
const METHOD_CALL_SYNC_HANDLERS = {
  scriptProcessor: (data, pipeline) => {
    pipeline.processors.push({
      type: 'scriptProcessor',
      bufferSize: data.bufferSize,
      inputChannels: data.inputChannels,
      outputChannels: data.outputChannels,
      timestamp: data.timestamp
    });
  },
  analyser: (data, pipeline) => {
    pipeline.processors.push({
      type: 'analyser',
      timestamp: data.timestamp
    });
  },
  mediaStreamSource: (data, pipeline) => {
    // TODO: Determine from streamId using streamRegistry
    pipeline.inputSource = 'microphone';
  },
  mediaStreamDestination: (data, pipeline) => {
    pipeline.destinationType = DESTINATION_TYPES.MEDIA_STREAM;
  }
};

/**
 * Collects AudioContext stats (sample rate, latency).
 * Hooks into window.AudioContext and window.webkitAudioContext.
 */
class AudioContextCollector extends BaseCollector {
  constructor(options = {}) {
    super('audio-context', options);

    /** @type {Map<any, Object>} */
    this.activeContexts = new Map();

    /** @type {number} */
    this.contextIdCounter = 0;

    /** @type {Function|null} */
    this.originalCreateScriptProcessor = null;

    /** @type {Function|null} */
    this.originalAudioWorkletAddModule = null;

    /** @type {Function|null} */
    this.originalCreateMediaStreamDestination = null;

    /** @type {Function|null} */
    this.originalCreateAnalyser = null;

    /** @type {Function|null} */
    this.originalCreateMediaStreamSource = null;
  }

  /**
   * Initialize collector - hook AudioContext
   * NOTE: Early hooks (EarlyHook.js) already installed AudioContext Proxy.
   * We only hook method-level APIs here (createScriptProcessor, AudioWorklet).
   * @returns {Promise<void>}
   */
  async initialize() {
    logger.info(this.logPrefix, 'Initializing AudioContextCollector hooks...');

    // Register global handler IMMEDIATELY (even before start)
    // This ensures we catch instances even if inspector is stopped
    // @ts-ignore
    window.__audioContextCollectorHandler = (ctx) => {
      // Only emit if active, but always track the instance
      this._handleNewContext(ctx);
    };

    // Early hooks already installed constructor hooks, so we skip hookConstructor here
    // to avoid overwriting the early Proxy
    logger.info(this.logPrefix, 'Skipping constructor hook (early hook already installed)');

    // 3. Hook createScriptProcessor (Sync method)
    // We can hook it on the prototype so all instances get it
    // Note: shouldHook is always true - emit() checks this.active internally
    if (window.AudioContext && window.AudioContext.prototype) {
        this.originalCreateScriptProcessor = hookMethod(
            window.AudioContext.prototype,
            'createScriptProcessor',
            // @ts-ignore
            (node, args) => this._handleScriptProcessor(node, args),
            () => true  // Always hook, emit() controls data flow
        );
        logger.info(this.logPrefix, 'Hooked AudioContext.prototype.createScriptProcessor');
    }
    // Also try webkit prototype if different
    // @ts-ignore
    if (window.webkitAudioContext && window.webkitAudioContext.prototype && window.webkitAudioContext.prototype !== window.AudioContext.prototype) {
        hookMethod(
            // @ts-ignore
            window.webkitAudioContext.prototype,
            'createScriptProcessor',
            // @ts-ignore
            (node, args) => this._handleScriptProcessor(node, args),
            () => true
        );
    }

    // 4. Hook AudioWorklet.addModule (Async method)
    // @ts-ignore
    if (window.AudioWorklet && window.AudioWorklet.prototype) {
        this.originalAudioWorkletAddModule = hookAsyncMethod(
            // @ts-ignore
            window.AudioWorklet.prototype,
            'addModule',
            // @ts-ignore - thisArg is the AudioWorklet instance, used to find parent AudioContext
            (result, args, thisArg) => this._handleAudioWorkletAddModule(result, args, thisArg),
            () => true  // Always hook, emit() controls data flow
        );
        logger.info(this.logPrefix, 'Hooked AudioWorklet.addModule');
    }

    // 5. Hook createMediaStreamDestination (Sync method)
    // Bu metod MediaRecorder'a giden output için kullanılır
    if (window.AudioContext && window.AudioContext.prototype) {
        this.originalCreateMediaStreamDestination = hookMethod(
            window.AudioContext.prototype,
            'createMediaStreamDestination',
            // @ts-ignore
            (node, args) => this._handleMediaStreamDestination(node, args),
            () => true  // Always hook, emit() controls data flow
        );
        logger.info(this.logPrefix, 'Hooked AudioContext.prototype.createMediaStreamDestination');
    }

    // 6. Hook createAnalyser (Sync method) - VU meter / visualizer detection
    if (window.AudioContext && window.AudioContext.prototype) {
        this.originalCreateAnalyser = hookMethod(
            window.AudioContext.prototype,
            'createAnalyser',
            // @ts-ignore
            (node, args) => this._handleAnalyserNode(node),
            () => true
        );
        logger.info(this.logPrefix, 'Hooked AudioContext.prototype.createAnalyser');
    }

    // 7. Hook createMediaStreamSource (Sync method) - Microphone input detection
    if (window.AudioContext && window.AudioContext.prototype) {
        this.originalCreateMediaStreamSource = hookMethod(
            window.AudioContext.prototype,
            'createMediaStreamSource',
            // @ts-ignore
            (node, args) => this._handleMediaStreamSource(node, args),
            () => true
        );
        logger.info(this.logPrefix, 'Hooked AudioContext.prototype.createMediaStreamSource');
    }

    // 8. Register WASM encoder handler (Worker.postMessage hook in EarlyHook.js)
    // @ts-ignore
    window.__wasmEncoderHandler = (encoderInfo) => {
      this._handleWasmEncoder(encoderInfo);
    };

  }

  /**
   * Handle new AudioContext instance
   * @private
   * @param {AudioContext} ctx
   * @param {boolean} shouldEmit - If true, emit data event; if false, silent registration
   */
  _handleNewContext(ctx, shouldEmit = true) {
      // Generate unique context ID
      this.contextIdCounter++;
      const contextId = `ctx_${this.contextIdCounter}`;

      const now = Date.now();
      const metadata = {
        type: DATA_TYPES.AUDIO_CONTEXT,
        contextId,
        // Statik özellikler - context oluşturulduğunda belirlenir
        static: {
          timestamp: now,
          sampleRate: ctx.sampleRate,
          channelCount: ctx.destination.maxChannelCount,
          baseLatency: ctx.baseLatency,
          outputLatency: ctx.outputLatency,
          state: ctx.state
        },
        // Audio pipeline - dinamik olarak güncellenir
        pipeline: {
          timestamp: now,
          inputSource: null,
          processors: [],
          destinationType: DESTINATION_TYPES.SPEAKERS  // Default - ctx.destination
        }
      };

      this.activeContexts.set(ctx, metadata);

      // Conditionally emit based on caller
      if (shouldEmit) {
        this.emit(EVENTS.DATA, metadata);
        logger.info(this.logPrefix, 'AudioContext created:', metadata);
      } else {
        logger.info(this.logPrefix, 'AudioContext registered (silent):', metadata);
      }
  }

  /**
   * Ensure AudioContext is registered (late-discovery pattern)
   * Called when we encounter a node whose context wasn't captured at creation time
   * @private
   * @param {AudioContext} ctx
   * @returns {boolean} true if context was newly registered, false if already known
   */
  _ensureContextRegistered(ctx) {
      if (ctx && !this.activeContexts.has(ctx)) {
          logger.info(this.logPrefix, `Late-discovered AudioContext (${ctx.sampleRate}Hz, ${ctx.state}) - adding to registry`);
          this._handleNewContext(ctx);
          return true;
      }
      return false;
  }

  /**
   * Handle createScriptProcessor calls
   * @private
   * @param {ScriptProcessorNode} node
   * @param {any[]} args
   */
  _handleScriptProcessor(node, args) {
      // args: bufferSize, numberOfInputChannels, numberOfOutputChannels
      const bufferSize = args[0];
      const inputChannels = args[1];
      const outputChannels = args[2];

      const spData = {
          bufferSize,
          inputChannels,
          outputChannels,
          timestamp: Date.now()
      };

      // Find which context this node belongs to
      // node.context should point to the AudioContext
      const ctx = node.context;

      // Late-discovery: register context if not already known
      this._ensureContextRegistered(ctx);

      if (this.activeContexts.has(ctx)) {
          const ctxData = this.activeContexts.get(ctx);
          if (ctxData) {
            // Single active processor - replace instead of accumulate
            const processorEntry = {
              type: 'scriptProcessor',
              bufferSize: spData.bufferSize,
              inputChannels: spData.inputChannels,
              outputChannels: spData.outputChannels,
              timestamp: spData.timestamp
            };
            // Mevcut scriptProcessor varsa güncelle, yoksa ekle
            const existingIdx = ctxData.pipeline.processors.findIndex(p => p.type === 'scriptProcessor');
            if (existingIdx >= 0) {
              ctxData.pipeline.processors[existingIdx] = processorEntry;
            } else {
              ctxData.pipeline.processors.push(processorEntry);
            }
            ctxData.pipeline.timestamp = Date.now();
            // Re-emit updated context data
            this.emit(EVENTS.DATA, ctxData);
            logger.info(this.logPrefix, `ScriptProcessor created: buffer=${bufferSize}, in=${inputChannels}ch, out=${outputChannels}ch (context: ${ctxData.contextId})`);
          }
      } else {
           // Context gerçekten null veya undefined (iframe/cross-origin)
           logger.warn(this.logPrefix, `ScriptProcessor created but context is ${ctx === null ? 'null' : 'undefined'}`);

           // Emit as orphan data (yeni yapıda)
           const now = Date.now();
           this.emit(EVENTS.DATA, {
               type: DATA_TYPES.AUDIO_CONTEXT,
               contextId: 'orphan',
               static: {
                 timestamp: now,
                 sampleRate: 0,
                 channelCount: 0,
                 baseLatency: 0,
                 outputLatency: 0,
                 state: 'unknown'
               },
               pipeline: {
                 timestamp: now,
                 inputSource: null,
                 processors: [{
                   type: 'scriptProcessor',
                   bufferSize: spData.bufferSize,
                   inputChannels: spData.inputChannels,
                   outputChannels: spData.outputChannels,
                   timestamp: spData.timestamp
                 }],
                 destinationType: DESTINATION_TYPES.SPEAKERS
               },
               isOrphan: true
           });
      }
  }

  /**
   * Handle AudioWorklet.addModule calls
   * @private
   * @param {void} result
   * @param {any[]} args
   * @param {AudioWorklet} audioWorkletInstance - The AudioWorklet instance (this context from hook)
   */
  _handleAudioWorkletAddModule(result, args, audioWorkletInstance) {
      const moduleUrl = args[0];

      const workletData = {
          url: moduleUrl,
          timestamp: Date.now()
      };

      // Encoder pattern detection - check if AudioWorklet URL indicates an encoder
      const ENCODER_PATTERNS = ['encoder', 'opus', 'ogg', 'wasm-audio', 'audio-encoder', 'voice-processor', 'mediaworker'];
      const urlLower = (typeof moduleUrl === 'string' ? moduleUrl : '').toLowerCase();
      const isEncoder = ENCODER_PATTERNS.some(pattern => urlLower.includes(pattern));

      // Find the AudioContext that owns this AudioWorklet instance
      // by iterating through our known contexts and matching ctx.audioWorklet === audioWorkletInstance
      let matchedContextId = null;
      let matchedContextData = null;

      for (const [ctx, ctxData] of this.activeContexts.entries()) {
          try {
              if (ctx.audioWorklet === audioWorkletInstance) {
                  matchedContextId = ctxData.contextId;
                  matchedContextData = ctxData;
                  break;
              }
          } catch (e) {
              // Context may be closed or inaccessible
          }
      }

      if (matchedContextData) {
          // Add worklet to pipeline.processors array
          const processorEntry = {
            type: 'audioWorklet',
            moduleUrl: workletData.url,
            timestamp: workletData.timestamp
          };
          matchedContextData.pipeline.processors.push(processorEntry);
          matchedContextData.pipeline.timestamp = Date.now();

          // If encoder pattern detected, emit to canonical wasm_encoder storage
          if (isEncoder) {
              // Emit to canonical wasm_encoder storage (not attached to audioContext)
              this.emit(EVENTS.DATA, {
                  type: DATA_TYPES.WASM_ENCODER,
                  timestamp: Date.now(),
                  codec: 'opus',
                  source: 'audioworklet',  // URL pattern detection
                  moduleUrl: moduleUrl,
                  linkedContextId: matchedContextId,  // Context bağlantısı
                  // URL pattern'den bitRate/channels alınamaz
                  sampleRate: matchedContextData.static?.sampleRate || null,
                  bitRate: null,
                  channels: null
              });

              // Context'e sadece referans ekle (optional - UI enhancement için)
              matchedContextData.wasmEncoder = { ref: true };

              logger.info(this.logPrefix, `🔧 WASM Encoder detected via AudioWorklet: ${moduleUrl}`);
          }

          logger.info(this.logPrefix, `AudioWorklet module added to context ${matchedContextId}:`, workletData);

          // Re-emit updated context data
          this.emit(EVENTS.DATA, matchedContextData);
      } else {
          // Fallback: emit as orphan worklet event (context not found)
          logger.warn(this.logPrefix, 'AudioWorklet module added but context not found:', workletData);

          this.emit(EVENTS.DATA, {
              type: DATA_TYPES.AUDIO_WORKLET,
              timestamp: Date.now(),
              moduleUrl: workletData.url,
              contextId: null
          });
      }
  }

  /**
   * Handle createMediaStreamDestination calls
   * Bu node audio'yu MediaStream olarak çıkarır - MediaRecorder, WebRTC veya WASM encoder kullanabilir
   * @private
   * @param {MediaStreamAudioDestinationNode} node
   * @param {any[]} args
   */
  _handleMediaStreamDestination(node, args) {
      // node.context ile AudioContext'e erişebiliriz
      const ctx = node.context;

      // Late-discovery: register context if not already known
      this._ensureContextRegistered(ctx);

      if (this.activeContexts.has(ctx)) {
          const ctxData = this.activeContexts.get(ctx);
          if (ctxData) {
              // @ts-ignore - pipeline.destinationType güncelle
              ctxData.pipeline.destinationType = DESTINATION_TYPES.MEDIA_STREAM;
              ctxData.pipeline.timestamp = Date.now();
              // Re-emit updated context data
              this.emit(EVENTS.DATA, ctxData);
              logger.info(this.logPrefix, `MediaStreamDestination created - audio routed to stream (context: ${ctxData.contextId})`);
          }
      } else {
          logger.warn(this.logPrefix, `MediaStreamDestination created but context is ${ctx === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Handle createAnalyser calls - indicates VU meter / audio visualization
   * @private
   * @param {AnalyserNode} node
   */
  _handleAnalyserNode(node) {
      const ctx = node.context;

      // Late-discovery: register context if not already known
      this._ensureContextRegistered(ctx);

      if (this.activeContexts.has(ctx)) {
          const ctxData = this.activeContexts.get(ctx);
          if (ctxData) {
              // Analyser'ı processor olarak ekle (duplicate check)
              if (!ctxData.pipeline.processors.some(p => p.type === 'analyser')) {
                ctxData.pipeline.processors.push({
                  type: 'analyser',
                  timestamp: Date.now()
                });
                ctxData.pipeline.timestamp = Date.now();
              }
              // Re-emit updated context data
              this.emit(EVENTS.DATA, ctxData);
              logger.info(this.logPrefix, `AnalyserNode created - VU meter/visualizer detected (context: ${ctxData.contextId})`);
          }
      } else {
          logger.warn(this.logPrefix, `AnalyserNode created but context is ${ctx === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Handle createMediaStreamSource calls - indicates audio input connected to AudioContext
   * Uses streamRegistry to determine if source is microphone (outgoing) or remote (incoming)
   * @private
   * @param {MediaStreamAudioSourceNode} node
   * @param {any[]} args - First argument is the MediaStream
   */
  _handleMediaStreamSource(node, args) {
      const stream = args[0];
      const ctx = node.context;

      // Late-discovery: register context if not already known
      this._ensureContextRegistered(ctx);

      if (this.activeContexts.has(ctx)) {
          const ctxData = this.activeContexts.get(ctx);
          if (ctxData) {
              // Determine stream source using registry
              let inputSource = 'unknown';
              if (stream && stream.id) {
                  if (streamRegistry.microphone.has(stream.id)) {
                      inputSource = 'microphone';
                  } else if (streamRegistry.remote.has(stream.id)) {
                      inputSource = 'remote';
                  } else {
                      // Fallback: check deviceId (microphone streams have deviceId)
                      const track = stream.getAudioTracks()[0];
                      const deviceId = track?.getSettings?.()?.deviceId;
                      inputSource = deviceId ? 'microphone' : 'remote';
                      logger.info(this.logPrefix, `Stream ${stream.id} not in registry, using deviceId fallback: ${inputSource}`);
                  }
              }

              ctxData.pipeline.inputSource = inputSource;
              ctxData.pipeline.timestamp = Date.now();
              // Re-emit updated context data
              this.emit(EVENTS.DATA, ctxData);
              logger.info(this.logPrefix, `MediaStreamSource created - ${inputSource} connected to AudioContext (context: ${ctxData.contextId}, stream: ${stream?.id})`);
          }
      } else {
          logger.warn(this.logPrefix, `MediaStreamSource created but context is ${ctx === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Best-effort context matching for WASM encoder
   * Used by both URL pattern detection and opus hook detection
   * @private
   * @param {number} sampleRate - Encoder's sample rate
   * @returns {string|null} - Context ID or null if no match
   */
  _findBestMatchingContextId(sampleRate) {
      const candidates = [];

      for (const [ctx, ctxData] of this.activeContexts.entries()) {
          if (ctx.state !== 'closed' && ctx.sampleRate === sampleRate) {
              candidates.push(ctxData);
          }
      }

      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0].contextId;

      // Multiple matches - return most recent (by pipeline timestamp)
      candidates.sort((a, b) => b.pipeline.timestamp - a.pipeline.timestamp);
      return candidates[0].contextId;
  }

  /**
   * Handle WASM encoder detection (from Worker.postMessage hook)
   * Emits encoder to canonical wasm_encoder storage with optional context linking
   * @private
   * @param {Object} encoderInfo - { type, sampleRate, bitRate, channels, application, timestamp, pattern, status, originalSampleRate?, frameSize?, bufferLength? }
   */
  _handleWasmEncoder(encoderInfo) {
      logger.info(this.logPrefix, 'WASM encoder detected:', encoderInfo);

      // Best-effort context matching (may return null if no match)
      const linkedContextId = this._findBestMatchingContextId(encoderInfo.sampleRate);

      // Emit to canonical wasm_encoder storage with context linking
      this.emit(EVENTS.DATA, {
          type: DATA_TYPES.WASM_ENCODER,
          timestamp: Date.now(),
          codec: encoderInfo.type || 'opus',
          source: 'direct',  // opus_encoder_create hook
          sampleRate: encoderInfo.sampleRate,
          originalSampleRate: encoderInfo.originalSampleRate,
          bitRate: encoderInfo.bitRate,
          channels: encoderInfo.channels || 1,
          application: encoderInfo.application, // 2048=Voice, 2049=FullBand, 2051=LowDelay
          pattern: encoderInfo.pattern, // 'direct' or 'nested'
          status: encoderInfo.status || 'initialized',
          frameSize: encoderInfo.frameSize,
          bufferLength: encoderInfo.bufferLength,
          linkedContextId  // Context bağlantısı (null olabilir)
      });

      // Human-readable application name
      const appNames = { 2048: 'Voice', 2049: 'Audio', 2051: 'LowDelay' };
      const appName = appNames[encoderInfo.application] || encoderInfo.application;

      logger.info(
          this.logPrefix,
          `🔧 WASM Encoder: ${encoderInfo.type || 'opus'} @ ${encoderInfo.bitRate/1000}kbps, ${encoderInfo.sampleRate}Hz, ${encoderInfo.channels}ch, app=${appName}`
      );
  }

  /**
   * Start collector
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // ═══════════════════════════════════════════════════════════════════
    // CLEAN SLATE: Clear ALL previous state on start
    // This prevents stale data issues and simplifies state management
    // ═══════════════════════════════════════════════════════════════════

    // 1. Clear activeContexts Map (our internal state)
    const previousSize = this.activeContexts.size;
    this.activeContexts.clear();
    this.contextIdCounter = 0; // Reset ID counter for fresh start
    logger.info(this.logPrefix, `Cleared ${previousSize} previous context(s) from activeContexts`);

    // 2. Clean up closed contexts from EarlyHook registry
    cleanupClosedAudioContexts();

    // 3. Re-register WASM encoder handler
    // @ts-ignore
    window.__wasmEncoderHandler = (encoderInfo) => {
      this._handleWasmEncoder(encoderInfo);
    };

    // 4. Clear any stale WASM encoder detection
    // @ts-ignore
    window.__wasmEncoderDetected = null;

    // ═══════════════════════════════════════════════════════════════════
    // Now sync RUNNING contexts from registry (ignore closed ones)
    // ═══════════════════════════════════════════════════════════════════
    const registry = getInstanceRegistry();
    logger.info(this.logPrefix, `Registry has ${registry.audioContexts.length} AudioContext(s) (after cleanup)`);

    // Sync ONLY running contexts from registry and emit them
    // Also sync methodCalls for late capture support
    let syncedCount = 0;
    let pipelineSyncedCount = 0;
    for (const entry of registry.audioContexts) {
      const { instance, methodCalls } = entry;

      // Skip closed contexts - we only want active ones
      if (instance.state === 'closed') {
        logger.info(this.logPrefix, `Skipping closed context from registry (${instance.sampleRate}Hz)`);
        continue;
      }

      // Add running context to activeContexts and emit
      this._handleNewContext(instance, true); // true = emit immediately
      syncedCount++;

      // Sync methodCalls to pipeline (late capture) - data-driven via METHOD_CALL_SYNC_HANDLERS
      if (methodCalls && Object.keys(methodCalls).length > 0) {
        const ctxData = this.activeContexts.get(instance);
        if (ctxData) {
          // Apply all registered handlers for this methodCalls object
          Object.entries(methodCalls).forEach(([key, data]) => {
            const handler = METHOD_CALL_SYNC_HANDLERS[key];
            if (handler) {
              handler(data, ctxData.pipeline);
            }
          });
          ctxData.pipeline.timestamp = Date.now();
          this.emit(EVENTS.DATA, ctxData);
          pipelineSyncedCount++;
          logger.info(this.logPrefix, `Synced pipeline data for ${ctxData.contextId}:`, Object.keys(methodCalls));
        }
      }

      // SONRA temizle - stale data prevention for next start()
      // Inspector çalışırken yeni method çağrıları hem emit() hem registry'ye gider
      entry.methodCalls = {};
    }

    if (syncedCount > 0) {
      logger.info(this.logPrefix, `Synced ${syncedCount} running AudioContext(s) from registry`);
      if (pipelineSyncedCount > 0) {
        logger.info(this.logPrefix, `Synced pipeline data for ${pipelineSyncedCount} context(s) (late capture)`);
      }
    } else {
      logger.info(this.logPrefix, 'No running AudioContexts to sync (will capture new ones)');
    }
    logger.info(this.logPrefix, 'Cleared methodCalls from registry (fresh for next start)');

    // NOTE: __wasmEncoderDetected was cleared at start (clean slate approach)
    // WASM encoder will be detected fresh when encoding actually starts

    logger.info(this.logPrefix, 'Started - ready to capture new audio activity');
  }

  /**
   * Re-emit current data from active contexts
   * Called when UI needs to be refreshed (e.g., after data reset)
   */
  reEmit() {
    if (!this.active) return;

    let emittedCount = 0;
    for (const [ctx, metadata] of this.activeContexts.entries()) {
      // Skip and clean up closed contexts
      if (ctx.state === 'closed') {
        this.activeContexts.delete(ctx);
        continue;
      }
      // Update state in case it changed
      metadata.static.state = ctx.state;
      this.emit(EVENTS.DATA, metadata);
      emittedCount++;
    }

    if (emittedCount > 0) {
      logger.info(this.logPrefix, `Re-emitted ${emittedCount} AudioContext(s)`);
    }
  }

  /**
   * Stop collector
   * @returns {Promise<void>}
   */
  async stop() {
    this.active = false;

    // Clear WASM encoder handler to prevent EarlyHook from re-setting __wasmEncoderDetected
    // This is critical - without this, EarlyHook continues to detect and store encoder info
    // even when inspector is stopped, causing stale data on restart
    // @ts-ignore
    window.__wasmEncoderHandler = null;
    logger.info(this.logPrefix, 'Cleared __wasmEncoderHandler on stop');

    // Clear stale WASM encoder detection
    // @ts-ignore
    if (window.__wasmEncoderDetected) {
      // @ts-ignore
      window.__wasmEncoderDetected = null;
      logger.info(this.logPrefix, 'Cleared __wasmEncoderDetected on stop');
    }

    // Only clean up closed contexts to prevent memory leak
    // Keep metadata for running contexts (preserves pipeline info)
    for (const [ctx] of this.activeContexts.entries()) {
      if (ctx.state === 'closed') {
        this.activeContexts.delete(ctx);
      }
    }

    logger.info(this.logPrefix, 'Stopped');
  }
}

export default AudioContextCollector;
