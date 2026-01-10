// @ts-check

import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES } from '../core/constants.js';
import { logger } from '../core/Logger.js';
import { hookAsyncMethod, hookMethod } from '../core/utils/ApiHook.js';
import { getInstanceRegistry, clearRegistryKey } from '../core/utils/EarlyHook.js';

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

    /** @type {Function|null} */
    this.originalCreateScriptProcessor = null;

    /** @type {Function|null} */
    this.originalAudioWorkletAddModule = null;

    /** @type {Function|null} */
    this.originalCreateMediaStreamDestination = null;
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
            // @ts-ignore
            (result, args) => this._handleAudioWorkletAddModule(result, args),
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

    // 6. Register WASM encoder handler (Worker.postMessage hook in EarlyHook.js)
    // @ts-ignore
    window.__wasmEncoderHandler = (encoderInfo) => {
      this._handleWasmEncoder(encoderInfo);
    };

    // 7. Check for WASM encoder detected BEFORE handler registration (late-discovery)
    // @ts-ignore
    if (window.__wasmEncoderDetected) {
      logger.info(this.logPrefix, 'Found pre-existing WASM encoder detection');
      this._handleWasmEncoder(window.__wasmEncoderDetected);
    }

  }

  /**
   * Handle new AudioContext instance
   * @private
   * @param {AudioContext} ctx
   */
  _handleNewContext(ctx) {
      const metadata = {
        type: DATA_TYPES.AUDIO_CONTEXT,
        timestamp: Date.now(),
        sampleRate: ctx.sampleRate,
        baseLatency: ctx.baseLatency,
        outputLatency: ctx.outputLatency,
        state: ctx.state,
        scriptProcessors: [],
        audioWorklets: [],
        destinationType: 'destination (speakers)'  // Default - ctx.destination
      };

      this.activeContexts.set(ctx, metadata);

      // Emit immediately (emit() checks this.active internally)
      this.emit(EVENTS.DATA, metadata);

      logger.info(this.logPrefix, 'AudioContext created:', metadata);
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
   */
  _handleAudioWorkletAddModule(result, args) {
      const moduleUrl = args[0];
      
      const workletData = {
          url: moduleUrl,
          timestamp: Date.now()
      };

      // finding the context is harder here because `this` in addModule is the AudioWorklet instance.
      // AudioWorklet doesn't strictly have a reference back to the context in the public API spec easily accessible 
      // without binding, but typically it is accessed as ctx.audioWorklet.
      // So 'this' is ctx.audioWorklet.
      
      // We can try to iterate our known contexts and see if any of their audioWorklet property matches 'this'
      // This is O(N) but N is small (number of active audio contexts).
      
      // However, since we are inside the hook, 'this' context of the execution *should* be the AudioWorklet instance.
      // But we need access to 'this' inside this handler. 
      // Our _hookGlobalAPI currently passes (result, args) to the handler.
      // It does NOT pass the 'this' context of the call.
      
      // For now, we will just log it globally or associate it with "unknown" if we can't find it.
      // Or we can assume it belongs to *some* context.
      
      // Limitation: We can't easily map back to the specific AudioContext without 'this' reference.
      // For now, we'll just emit it as a general event.
      
      logger.info(this.logPrefix, 'AudioWorklet module added:', workletData);

      // Emit as a separate audioWorklet data type
      this.emit(EVENTS.DATA, {
          type: 'audioWorklet',
          timestamp: Date.now(),
          moduleUrl: workletData.url
      });
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
              ctxData.destinationType = 'MediaStreamDestination';
              // Re-emit updated context data
              this.emit(EVENTS.DATA, ctxData);
              logger.info(this.logPrefix, 'MediaStreamDestination created - audio routed to stream');
          }
      } else {
          logger.warn(this.logPrefix, `MediaStreamDestination created but context is ${ctx === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Handle WASM encoder detection (from Worker.postMessage hook)
   * @private
   * @param {Object} encoderInfo - { type, sampleRate, bitRate, channels, application, timestamp }
   */
  _handleWasmEncoder(encoderInfo) {
      // Find the most recent AudioContext to associate this encoder with
      const lastCtxEntry = Array.from(this.activeContexts.entries()).pop();

      if (lastCtxEntry) {
          const [ctx, ctxData] = lastCtxEntry;
          // @ts-ignore
          ctxData.wasmEncoder = encoderInfo;
          // Re-emit updated context data
          this.emit(EVENTS.DATA, ctxData);
          logger.info(this.logPrefix, `WASM Encoder attached: ${encoderInfo.type} @ ${encoderInfo.bitRate/1000}kbps`);
      } else {
          // No AudioContext yet - store for late association
          logger.info(this.logPrefix, `WASM Encoder detected (no AudioContext yet): ${encoderInfo.type} @ ${encoderInfo.bitRate/1000}kbps`);
      }
  }

  /**
   * Start collector
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // Registry'deki eski instance'ları ignore et
    // Sadece yeni oluşturulan AudioContext'leri izle
    // Bu, profil değişikliğinde eski verilerin görünmesini önler
    logger.info(this.logPrefix, 'Started - listening for new AudioContext instances only');
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
    this.activeContexts.clear();

    // Clear registry to prevent stale data on next start
    clearRegistryKey('audioContexts');

    logger.info(this.logPrefix, 'Stopped');
  }
}

export default AudioContextCollector;
