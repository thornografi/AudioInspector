// @ts-check

import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES } from '../core/constants.js';
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

    /** @type {Function|null} */
    this.originalCreateScriptProcessor = null;

    /** @type {Function|null} */
    this.originalAudioWorkletAddModule = null;
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
    if (window.AudioContext && window.AudioContext.prototype) {
        this.originalCreateScriptProcessor = hookMethod(
            window.AudioContext.prototype,
            'createScriptProcessor',
            // @ts-ignore
            (node, args) => this._handleScriptProcessor(node, args),
            () => this.active
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
            () => this.active
        );
    }

    // 4. Hook AudioWorklet.addModule (Async method)
    // AudioWorklet is a property of AudioContext instances usually, or AudioWorkletNode
    // Actually, addModule is on the AudioWorklet interface. 
    // We can try to hook AudioWorklet.prototype.addModule if it exists in the window scope,
    // but AudioWorklet might not be globally exposed as a constructor in older browsers or some contexts.
    // It is available as window.AudioWorklet in modern browsers.
    // @ts-ignore
    if (window.AudioWorklet && window.AudioWorklet.prototype) {
        this.originalAudioWorkletAddModule = hookAsyncMethod(
            // @ts-ignore
            window.AudioWorklet.prototype,
            'addModule',
            // @ts-ignore
            (result, args) => this._handleAudioWorkletAddModule(result, args),
            () => this.active
        );
        logger.info(this.logPrefix, 'Hooked AudioWorklet.addModule');
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
        audioWorklets: []
      };

      this.activeContexts.set(ctx, metadata);

      // Emit immediately
      this.emit(EVENTS.DATA, metadata);

      logger.info(this.logPrefix, 'AudioContext created:', metadata);
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
      if (this.activeContexts.has(ctx)) {
          const ctxData = this.activeContexts.get(ctx);
          if (ctxData) {
            // @ts-ignore
            ctxData.scriptProcessors.push(spData);
            // Re-emit updated context data
            this.emit(EVENTS.DATA, ctxData);
            logger.info(this.logPrefix, 'ScriptProcessor created:', spData);
          }
      } else {
           // Context not found (maybe created before we hooked, or iframe issue)
           logger.warn(this.logPrefix, 'ScriptProcessor created for UNKNOWN context', spData);

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
   * Start collector
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // Handler already registered in initialize(), just emit pre-existing instances
    const registry = getInstanceRegistry();
    logger.info(this.logPrefix, `Checking registry... found ${registry.audioContexts.length} AudioContext(s)`);

    if (registry.audioContexts.length > 0) {
      logger.info(this.logPrefix, `Found ${registry.audioContexts.length} pre-existing AudioContext(s) from early hook`);

      for (const { instance, timestamp, sampleRate, state } of registry.audioContexts) {
        this._handleNewContext(instance);
      }
    }

    logger.info(this.logPrefix, 'Started');
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
    logger.info(this.logPrefix, 'Stopped');
  }
}

export default AudioContextCollector;
