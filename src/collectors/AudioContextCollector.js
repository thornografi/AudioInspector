// @ts-check

import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES, DESTINATION_TYPES } from '../core/constants.js';
import { logger } from '../core/Logger.js';
import { hookAsyncMethod, hookMethod } from '../core/utils/ApiHook.js';
import { getInstanceRegistry } from '../core/utils/EarlyHook.js';

/**
 * Collects AudioContext stats (sample rate, latency).
 * Hooks into window.AudioContext and window.webkitAudioContext.
 */
class AudioContextCollector extends BaseCollector {
  constructor(options = {}) {
    super('audio-context', options);

    /** @type {Function|null} */
    this.originalAudioContext = null;

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

      const metadata = {
        type: DATA_TYPES.AUDIO_CONTEXT,
        contextId,
        timestamp: Date.now(),
        sampleRate: ctx.sampleRate,
        channelCount: ctx.destination.maxChannelCount,
        baseLatency: ctx.baseLatency,
        outputLatency: ctx.outputLatency,
        state: ctx.state,
        scriptProcessors: [],
        audioWorklets: [],
        hasAnalyser: false,
        destinationType: DESTINATION_TYPES.SPEAKERS  // Default - ctx.destination
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
            // (eski processor disconnect olduğunda collector'dan silinmiyor, bu yüzden sadece son processor'ı tutuyoruz)
            ctxData.scriptProcessors = [spData];
            // Re-emit updated context data
            this.emit(EVENTS.DATA, ctxData);
            logger.info(this.logPrefix, `ScriptProcessor created: buffer=${bufferSize}, in=${inputChannels}ch, out=${outputChannels}ch`);
          }
      } else {
           // Context gerçekten null veya undefined (iframe/cross-origin)
           logger.warn(this.logPrefix, `ScriptProcessor created but context is ${ctx === null ? 'null' : 'undefined'}`);

           // Emit as orphan data
           this.emit(EVENTS.DATA, {
               type: DATA_TYPES.AUDIO_CONTEXT,
               timestamp: Date.now(),
               state: 'unknown',
               sampleRate: 0,
               scriptProcessors: [spData],
               audioWorklets: [],
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
          // Add worklet to matched context's audioWorklets array
          if (!matchedContextData.audioWorklets) {
              matchedContextData.audioWorklets = [];
          }
          matchedContextData.audioWorklets.push(workletData);

          // If encoder pattern detected, mark as WASM encoder
          if (isEncoder) {
              matchedContextData.wasmEncoder = {
                  type: 'opus',
                  source: 'audioworklet',
                  moduleUrl: moduleUrl,
                  timestamp: Date.now()
              };
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
              // @ts-ignore - sadece gerçeği söyle, varsayım yapma
              ctxData.destinationType = DESTINATION_TYPES.MEDIA_STREAM;
              // Re-emit updated context data
              this.emit(EVENTS.DATA, ctxData);
              logger.info(this.logPrefix, 'MediaStreamDestination created - audio routed to stream');
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
              ctxData.hasAnalyser = true;
              // Re-emit updated context data
              this.emit(EVENTS.DATA, ctxData);
              logger.info(this.logPrefix, `AnalyserNode created - VU meter/visualizer detected (context: ${ctxData.contextId})`);
          }
      } else {
          logger.warn(this.logPrefix, `AnalyserNode created but context is ${ctx === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Handle createMediaStreamSource calls - indicates microphone input connected to AudioContext
   * @private
   * @param {MediaStreamAudioSourceNode} node
   * @param {any[]} args - First argument is the MediaStream
   */
  _handleMediaStreamSource(node, args) {
      const ctx = node.context;

      // Late-discovery: register context if not already known
      this._ensureContextRegistered(ctx);

      if (this.activeContexts.has(ctx)) {
          const ctxData = this.activeContexts.get(ctx);
          if (ctxData) {
              ctxData.hasMediaStreamSource = true;
              ctxData.inputSource = 'microphone';
              // Re-emit updated context data
              this.emit(EVENTS.DATA, ctxData);
              logger.info(this.logPrefix, `MediaStreamSource created - microphone connected to AudioContext (context: ${ctxData.contextId})`);
          }
      } else {
          logger.warn(this.logPrefix, `MediaStreamSource created but context is ${ctx === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Handle WASM encoder detection (from Worker.postMessage hook)
   * Emits encoder as INDEPENDENT signal - no AudioContext matching attempted
   * Reason: Worker.postMessage has no reliable way to know which AudioContext owns the data
   * @private
   * @param {Object} encoderInfo - { type, sampleRate, bitRate, channels, application, timestamp, pattern, status, originalSampleRate?, frameSize?, bufferLength? }
   */
  _handleWasmEncoder(encoderInfo) {
      logger.info(this.logPrefix, 'WASM encoder detected:', encoderInfo);

      // Emit as independent signal - DO NOT attach to AudioContext
      // Context matching is unreliable (sampleRate 48000Hz is common to all)
      this.emit(EVENTS.DATA, {
          type: DATA_TYPES.WASM_ENCODER,
          timestamp: Date.now(),
          encoderType: encoderInfo.type || 'opus',
          sampleRate: encoderInfo.sampleRate,
          originalSampleRate: encoderInfo.originalSampleRate,
          bitRate: encoderInfo.bitRate,
          channels: encoderInfo.channels || 1,
          application: encoderInfo.application, // 2048=Voice, 2049=FullBand, 2051=LowDelay
          pattern: encoderInfo.pattern, // 'direct' or 'nested'
          status: encoderInfo.status || 'initialized', // NEW: 'initialized' or 'encoding'
          frameSize: encoderInfo.frameSize,
          bufferLength: encoderInfo.bufferLength
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
   * Reset node detection flags on a context (for fresh start)
   * @private
   * @param {Object} metadata - Context metadata object
   */
  _resetNodeFlags(metadata) {
    // Reset all "was created" flags to prevent stale data
    // These will be set again if nodes are created during this session
    metadata.scriptProcessors = [];
    metadata.audioWorklets = [];
    metadata.hasAnalyser = false;
    metadata.hasMediaStreamSource = false;
    metadata.inputSource = null;
    // Keep destinationType - this is more persistent (attached to destination)
  }

  /**
   * Start collector
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // Reset node flags on existing contexts to prevent stale "was created" data
    // This ensures we only show nodes created during THIS monitoring session
    for (const [ctx, metadata] of this.activeContexts.entries()) {
      if (ctx.state !== 'closed') {
        this._resetNodeFlags(metadata);
        logger.info(this.logPrefix, `Reset node flags for context ${metadata.contextId}`);
      }
    }

    // Sync pre-existing instances from early hook registry
    const registry = getInstanceRegistry();
    if (registry.audioContexts.length > 0) {
      logger.info(
        this.logPrefix,
        `Found ${registry.audioContexts.length} pre-existing AudioContext(s) from early hook`
      );

      for (const { instance } of registry.audioContexts) {
        // Ensure instance is registered (handler may have already added it)
        if (!this.activeContexts.has(instance)) {
          this._handleNewContext(instance, false); // Silent add to Map
          logger.info(this.logPrefix, 'Registered pre-existing AudioContext (was missed by handler)');
        }
      }
    }

    // Now that we're active, emit all contexts in activeContexts
    // This handles both:
    // - Contexts added by handler (before start, blocked by active=false)
    // - Contexts just synced from registry
    if (this.activeContexts.size > 0) {
      logger.info(
        this.logPrefix,
        `Emitting ${this.activeContexts.size} existing AudioContext(s) on start`
      );

      for (const [ctx, metadata] of this.activeContexts.entries()) {
        // Skip and clean up closed contexts
        if (ctx.state === 'closed') {
          this.activeContexts.delete(ctx);
          continue;
        }
        // Update state in case it changed while stopped
        metadata.state = ctx.state;
        this.emit(EVENTS.DATA, metadata);
        logger.info(this.logPrefix, 'Emitted existing AudioContext:', {
          sampleRate: metadata.sampleRate,
          state: metadata.state,
          hasScriptProcessors: metadata.scriptProcessors.length > 0,
          hasWasmEncoder: !!metadata.wasmEncoder
        });
      }
    }

    // Check for WASM encoder detected BEFORE start (late-discovery)
    // Process AFTER registry sync and emit so activeContexts is populated
    // @ts-ignore
    if (window.__wasmEncoderDetected) {
      logger.info(this.logPrefix, 'Found pre-existing WASM encoder detection (deferred processing)');
      this._handleWasmEncoder(window.__wasmEncoderDetected);
      // @ts-ignore
      window.__wasmEncoderDetected = null; // Clear flag to avoid reprocessing
    }

    logger.info(this.logPrefix, 'Started - ready to capture new audio activity');
  }

  /**
   * Stop collector
   * @returns {Promise<void>}
   */
  async stop() {
    this.active = false;

    // Handler remains registered (initialized in initialize())
    // Just stop emitting by setting active=false
    // Note: Reverting global objects in a running page is risky/complex.

    // Only clean up closed contexts to prevent memory leak
    // Keep metadata for running contexts (preserves hasAnalyser, destinationType, etc.)
    for (const [ctx] of this.activeContexts.entries()) {
      if (ctx.state === 'closed') {
        this.activeContexts.delete(ctx);
      }
    }

    logger.info(this.logPrefix, 'Stopped');
  }
}

export default AudioContextCollector;
