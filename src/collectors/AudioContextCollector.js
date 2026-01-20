// @ts-check

import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES, DESTINATION_TYPES, streamRegistry, ENCODER_KEYWORDS } from '../core/constants.js';
import { logger } from '../core/Logger.js';
import { hookAsyncMethod, hookMethod } from '../core/utils/ApiHook.js';
import { getInstanceRegistry, cleanupClosedAudioContexts } from '../core/utils/EarlyHook.js';

/**
 * Sync handlers for methodCalls - OCP: Add new handlers without modifying sync loop
 * Maps registry keys to pipeline sync functions
 *
 * ⚠️ SYNC REQUIRED: When adding a new processor type here, also add a corresponding
 * hook in EarlyHook.js → METHOD_HOOK_CONFIGS
 */

/**
 * Factory: Creates a processor handler with duplicate check
 * DRY: All DSP nodes use this pattern - add new nodes with single line
 * @param {string} type - Processor type name
 * @param {Object<string, string>} [fieldMap] - Maps data fields to entry fields with defaults: { fieldName: 'defaultValue' }
 */
const createProcessorHandler = (type, fieldMap = {}) => (data, pipeline) => {
  if (pipeline.processors.some(p => p.type === type && p.timestamp === data.timestamp)) return;
  const entry = { type, timestamp: data.timestamp };
  for (const [field, defaultVal] of Object.entries(fieldMap)) {
    entry[field] = data[field] ?? defaultVal;
  }
  pipeline.processors.push(entry);
};

const METHOD_CALL_SYNC_HANDLERS = {
  // Special handlers (non-processor)
  mediaStreamSource: (data, pipeline) => { pipeline.inputSource = 'microphone'; },
  mediaStreamDestination: (data, pipeline) => { pipeline.destinationType = DESTINATION_TYPES.MEDIA_STREAM; },

  // Processor handlers - OCP: Add new DSP node with single line
  scriptProcessor: createProcessorHandler('scriptProcessor', { bufferSize: 4096, inputChannels: 2, outputChannels: 2 }),
  analyser: createProcessorHandler('analyser'),
  gain: createProcessorHandler('gain'),
  biquadFilter: createProcessorHandler('biquadFilter', { filterType: 'lowpass' }),
  dynamicsCompressor: createProcessorHandler('dynamicsCompressor'),
  oscillator: createProcessorHandler('oscillator', { oscillatorType: 'sine' }),
  delay: createProcessorHandler('delay', { maxDelayTime: 1 }),
  convolver: createProcessorHandler('convolver'),
  waveShaper: createProcessorHandler('waveShaper', { oversample: 'none' }),
  panner: createProcessorHandler('panner', { panningModel: 'equalpower' })
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

    /**
     * Pending worklets queue for deferred matching
     * When AudioWorklet.addModule is called before context is registered,
     * we queue it here and match when context is registered later.
     * @type {Array<{audioWorkletInstance: AudioWorklet, moduleUrl: string, isEncoder: boolean, timestamp: number}>}
     */
    this.pendingWorklets = [];

    /**
     * Pending WASM encoder data
     * When WASM encoder is detected before collector is active (started),
     * we store it here and emit when start() is called.
     * @type {Object|null}
     */
    this.pendingWasmEncoder = null;

    // NOTE: Original method references are not stored because:
    // 1. We hook on prototype level, not instance level
    // 2. Restoring would break other extensions that also hook these methods
    // 3. The hooks are designed to be "forever running" in page context
  }

  _getContextIdMap() {
    const win = /** @type {any} */ (window);
    const existing = win.__audioInspectorContextIdMap;
    if (existing && typeof existing.get === 'function' && typeof existing.set === 'function') {
      return existing;
    }
    const map = new WeakMap();
    win.__audioInspectorContextIdMap = map;
    return map;
  }

  _syncContextIdCounterFromId(contextId) {
    if (typeof contextId !== 'string') return;
    const match = /^ctx_(\d+)$/.exec(contextId);
    if (!match) return;
    const num = Number(match[1]);
    if (!Number.isNaN(num) && num > this.contextIdCounter) {
      this.contextIdCounter = num;
    }
  }

  _getOrAssignContextId(ctx) {
    if (!ctx) {
      this.contextIdCounter += 1;
      return `ctx_${this.contextIdCounter}`;
    }

    const map = this._getContextIdMap();
    let contextId = map.get(ctx);
    if (contextId) {
      this._syncContextIdCounterFromId(contextId);
      return contextId;
    }

    this.contextIdCounter += 1;
    contextId = `ctx_${this.contextIdCounter}`;
    map.set(ctx, contextId);

    const win = /** @type {any} */ (window);
    const winCounter = Number.isInteger(win.__audioInspectorContextIdCounter)
      ? win.__audioInspectorContextIdCounter
      : 0;
    if (this.contextIdCounter > winCounter) {
      win.__audioInspectorContextIdCounter = this.contextIdCounter;
    }

    return contextId;
  }

  /**
   * Initialize collector - hook AudioContext
   * NOTE: Early hooks (EarlyHook.js) already installed AudioContext Proxy.
   * We only hook method-level APIs here (createScriptProcessor, AudioWorklet).
   * @returns {Promise<void>}
   */
  async initialize() {
    logger.info(this.logPrefix, 'Initializing AudioContextCollector hooks...');

    // Register global handler for early hook communication
    this.registerGlobalHandler('__audioContextCollectorHandler', (ctx) => {
      this._handleNewContext(ctx);
    });

    // ScriptProcessor detection is handled via:
    // 1. early-inject.js instance-level hooks (for earliest captures)
    // 2. EarlyHook.js METHOD_HOOK_CONFIGS (for prototype-level fallback)
    // 3. METHOD_CALL_SYNC_HANDLERS syncs to pipeline on start()
    // 4. popup.js ENCODER_DETECTORS (for UI display as encoding heuristic)
    // Chrome deprecation warnings are accepted for this critical detection feature

    // 3. Hook AudioWorklet.addModule (Async method)
    // @ts-ignore
    if (window.AudioWorklet && window.AudioWorklet.prototype) {
        hookAsyncMethod(
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
        hookMethod(
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
        hookMethod(
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
        hookMethod(
            window.AudioContext.prototype,
            'createMediaStreamSource',
            // @ts-ignore
            (node, args) => this._handleMediaStreamSource(node, args),
            () => true
        );
        logger.info(this.logPrefix, 'Hooked AudioContext.prototype.createMediaStreamSource');
    }

    // 8. Register WASM encoder handler (Worker.postMessage hook in EarlyHook.js)
    this.registerGlobalHandler('__wasmEncoderHandler', (encoderInfo) => {
      this._handleWasmEncoder(encoderInfo);
    });

    // 9. Register AudioWorkletNode handler (constructor hook in EarlyHook.js)
    this.registerGlobalHandler('__audioWorkletNodeHandler', (node, args) => {
      this._handleAudioWorkletNode(node, args);
    });

    // 10. Register method call handler for real-time pipeline updates
    // This is called by EarlyHook.js prototype hooks (createScriptProcessor, etc.)
    this.registerGlobalHandler('__audioContextMethodCallHandler', (ctx, methodCallData) => {
      this._handleMethodCall(ctx, methodCallData);
    });

    // 11. Register audio connection handler (AudioNode.connect() calls)
    // This captures the audio graph topology: who connects to whom
    this.registerGlobalHandler('__audioConnectionHandler', (connection) => {
      this._handleAudioConnection(connection);
    });

  }

  /**
   * Handle new AudioContext instance
   * @private
   * @param {AudioContext} ctx
   * @param {boolean} shouldEmit - If true, emit data event; if false, silent registration
   */
  _handleNewContext(ctx, shouldEmit = true) {
      const contextId = this._getOrAssignContextId(ctx);

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

      // ═══════════════════════════════════════════════════════════════════
      // LATENCY UPDATE: outputLatency may not be accurate until context is running
      // Listen for state change to update latency values when context becomes running
      // ═══════════════════════════════════════════════════════════════════
      if (ctx.state !== 'running') {
        const updateLatencyOnRunning = () => {
          if (ctx.state === 'running' && this.activeContexts.has(ctx)) {
            const ctxData = this.activeContexts.get(ctx);
            const newBaseLatency = ctx.baseLatency;
            const newOutputLatency = ctx.outputLatency;

            // Only update and emit if latency actually changed
            if (ctxData.static.baseLatency !== newBaseLatency ||
                ctxData.static.outputLatency !== newOutputLatency) {
              ctxData.static.baseLatency = newBaseLatency;
              ctxData.static.outputLatency = newOutputLatency;
              ctxData.static.state = ctx.state;

              if (this.active) {
                this.emit(EVENTS.DATA, ctxData);
                logger.info(this.logPrefix, `Latency updated for ${contextId}: base=${(newBaseLatency * 1000).toFixed(1)}ms, output=${(newOutputLatency * 1000).toFixed(1)}ms`);
              }
            }
          }
          // Remove listener after first running state
          ctx.removeEventListener('statechange', updateLatencyOnRunning);
        };

        ctx.addEventListener('statechange', updateLatencyOnRunning);
      }

      // ═══════════════════════════════════════════════════════════════════
      // SYNC REGISTRY methodCalls: Check if prototype hooks already captured
      // method calls for this context (e.g., createScriptProcessor called
      // between AudioContext creation and this handler running)
      // ═══════════════════════════════════════════════════════════════════
      const registry = getInstanceRegistry();
      const registryEntry = registry.audioContexts.find(e => e.instance === ctx);
      if (registryEntry?.methodCalls?.length > 0) {
        this._syncMethodCallsToExistingContext(ctx, registryEntry.methodCalls);
        // Clear to prevent re-sync
        registryEntry.methodCalls = [];
      }

      // ═══════════════════════════════════════════════════════════════════
      // DEFERRED MATCHING: Check pending worklets queue
      // If addModule was called before this context was registered,
      // the worklet is waiting in pendingWorklets - match and emit now
      // ═══════════════════════════════════════════════════════════════════
      this._matchPendingWorklets(ctx, metadata);

      // Conditionally emit based on caller
      if (shouldEmit) {
        this.emit(EVENTS.DATA, metadata);
        logger.info(this.logPrefix, 'AudioContext created:', metadata);
      } else {
        logger.info(this.logPrefix, 'AudioContext registered (silent):', metadata);
      }
  }

  /**
   * Sync methodCalls to an existing context's pipeline (no duplicate context creation)
   * Used when registry contains same instance as earlyCaptures
   * @private
   * @param {AudioContext} instance - The AudioContext instance
   * @param {Array} methodCalls - Array of method call records from registry
   */
  _syncMethodCallsToExistingContext(instance, methodCalls) {
    const ctxData = this.activeContexts.get(instance);
    if (!ctxData) {
      logger.warn(this.logPrefix, 'Cannot sync methodCalls - context not in activeContexts');
      return;
    }

    // Apply all registered handlers for each method call in order
    methodCalls.forEach((call) => {
      const handler = METHOD_CALL_SYNC_HANDLERS[call.type];
      if (handler) {
        handler(call, ctxData.pipeline);
      }
    });

    ctxData.pipeline.timestamp = Date.now();

    // Emit updated context data
    this.emit(EVENTS.DATA, ctxData);

    const callTypes = methodCalls.map(c => c.type);
    logger.info(this.logPrefix, `Synced pipeline data for ${ctxData.contextId}:`, callTypes);
  }

  /**
   * Handle real-time method call from EarlyHook.js prototype hooks
   * Updates activeContexts pipeline immediately when methods like createScriptProcessor are called
   * @private
   * @param {AudioContext} ctx - The AudioContext instance
   * @param {Object} methodCallData - { type: 'scriptProcessor', bufferSize, inputChannels, outputChannels, timestamp }
   */
  _handleMethodCall(ctx, methodCallData) {
    if (!this.active) return;  // Only process when collector is active

    const ctxData = this.activeContexts.get(ctx);
    if (!ctxData) {
      // Context not in activeContexts yet - will be synced when context is registered
      logger.info(this.logPrefix, `Method call ${methodCallData.type} queued (context not yet registered)`);
      return;
    }

    // Apply the handler for this method type
    const handler = METHOD_CALL_SYNC_HANDLERS[methodCallData.type];
    if (handler) {
      handler(methodCallData, ctxData.pipeline);
      ctxData.pipeline.timestamp = Date.now();

      // Emit updated context data
      this.emit(EVENTS.DATA, ctxData);
      logger.info(this.logPrefix, `Real-time pipeline update: ${methodCallData.type} added to ${ctxData.contextId}`);
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
   * Get context data with late-discovery support
   * Ensures context is registered, then returns its metadata
   * DRY helper combining _ensureContextRegistered + activeContexts.get
   * @private
   * @param {AudioContext} ctx
   * @returns {Object|undefined} Context metadata or undefined if ctx is null
   */
  _getContextData(ctx) {
      if (!ctx) return undefined;
      this._ensureContextRegistered(ctx);
      return this.activeContexts.get(ctx);
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

      // Find which context this node belongs to and ensure it's registered
      const ctxData = this._getContextData(node.context);

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

            // ═══════════════════════════════════════════════════════════════
            // PCM PROCESSING HINT: ScriptProcessor processes raw audio data
            // This indicates raw PCM data is being processed (not yet encoded)
            // Actual encoding detection is handled in Encoding section (popup.js)
            // ═══════════════════════════════════════════════════════════════
            ctxData.encodingHint = {
              type: 'scriptProcessor',
              bufferSize: spData.bufferSize,
              channels: spData.inputChannels || spData.outputChannels || 1,
              hint: 'Raw PCM data'
            };

            // Re-emit updated context data
            this.emit(EVENTS.DATA, ctxData);
            logger.info(this.logPrefix, `ScriptProcessor created: buffer=${bufferSize}, in=${inputChannels}ch, out=${outputChannels}ch (context: ${ctxData.contextId})`);
      } else {
           // Context gerçekten null veya undefined (iframe/cross-origin)
           logger.warn(this.logPrefix, `ScriptProcessor created but context is ${node.context === null ? 'null' : 'undefined'}`);

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
      // Uses ENCODER_KEYWORDS from constants.js (single source of truth)
      const urlLower = (typeof moduleUrl === 'string' ? moduleUrl : '').toLowerCase();
      const isEncoder = ENCODER_KEYWORDS.some(kw => urlLower.includes(kw));

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
          // NOTE: addModule sadece modülü yükler, pipeline'a EKLEMEYİZ
          // AudioWorkletNode instance'ı oluşturulduğunda (_handleAudioWorkletNode) eklenir
          // Bu duplicate'ı önler: AudioWorklet → Worklet(name) yerine sadece Worklet(name) görünür

          // If encoder pattern detected, emit to canonical wasm_encoder storage
          if (isEncoder) {
              // Extract container from URL (ogg, webm)
              const container = urlLower.includes('ogg') ? 'ogg' :
                               urlLower.includes('webm') ? 'webm' : null;

              // Emit to canonical wasm_encoder storage (not attached to audioContext)
              this.emit(EVENTS.DATA, {
                  type: DATA_TYPES.WASM_ENCODER,
                  timestamp: Date.now(),
                  codec: 'opus',
                  container: container,  // Extracted from URL
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
          // ═══════════════════════════════════════════════════════════════════
          // DEFERRED MATCHING: Context not found yet - queue for later matching
          // This handles the race condition where addModule is called before
          // the AudioContext is registered in activeContexts
          // ═══════════════════════════════════════════════════════════════════
          logger.info(this.logPrefix, `AudioWorklet module queued for deferred matching: ${moduleUrl}`);

          this.pendingWorklets.push({
              audioWorkletInstance,
              moduleUrl,
              isEncoder,
              timestamp: Date.now()
          });

          // Also emit orphan event for backwards compatibility and debugging
          this.emit(EVENTS.DATA, {
              type: DATA_TYPES.AUDIO_WORKLET,
              timestamp: Date.now(),
              moduleUrl: workletData.url,
              contextId: null,
              pending: true  // Flag to indicate it's queued for matching
          });
      }
  }

  /**
   * Match pending worklets to a newly registered context
   * Called from _handleNewContext after context is added to activeContexts
   * @private
   * @param {AudioContext} ctx - The newly registered AudioContext
   * @param {Object} ctxData - The context metadata
   */
  _matchPendingWorklets(ctx, ctxData) {
      if (this.pendingWorklets.length === 0) return;

      // Find worklets belonging to this context
      const matched = [];
      const remaining = [];

      for (const pending of this.pendingWorklets) {
          try {
              if (ctx.audioWorklet === pending.audioWorkletInstance) {
                  matched.push(pending);
              } else {
                  remaining.push(pending);
              }
          } catch (e) {
              // Keep in remaining if comparison fails
              remaining.push(pending);
          }
      }

      if (matched.length === 0) return;

      // Update pending queue
      this.pendingWorklets = remaining;

      // Process matched worklets
      for (const worklet of matched) {
          logger.info(this.logPrefix, `✅ Deferred match: ${worklet.moduleUrl} → ${ctxData.contextId}`);

          // If this is an encoder, emit wasm_encoder data
          if (worklet.isEncoder) {
              // Extract container from URL (ogg, webm)
              const urlLower = (worklet.moduleUrl || '').toLowerCase();
              const container = urlLower.includes('ogg') ? 'ogg' :
                               urlLower.includes('webm') ? 'webm' : null;

              this.emit(EVENTS.DATA, {
                  type: DATA_TYPES.WASM_ENCODER,
                  timestamp: Date.now(),
                  codec: 'opus',
                  container: container,  // Extracted from URL
                  source: 'audioworklet-deferred',  // Indicates deferred matching
                  moduleUrl: worklet.moduleUrl,
                  linkedContextId: ctxData.contextId,
                  sampleRate: ctxData.static?.sampleRate || null,
                  bitRate: null,
                  channels: null
              });

              // Mark context as having encoder
              ctxData.wasmEncoder = { ref: true };

              logger.info(this.logPrefix, `🔧 WASM Encoder detected via deferred matching: ${worklet.moduleUrl}`);
          }
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
      // Get context data with late-discovery support
      const ctxData = this._getContextData(node.context);

      if (ctxData) {
          // @ts-ignore - pipeline.destinationType güncelle
          ctxData.pipeline.destinationType = DESTINATION_TYPES.MEDIA_STREAM;
          ctxData.pipeline.timestamp = Date.now();
          // Re-emit updated context data
          this.emit(EVENTS.DATA, ctxData);
          logger.info(this.logPrefix, `MediaStreamDestination created - audio routed to stream (context: ${ctxData.contextId})`);
      } else {
          logger.warn(this.logPrefix, `MediaStreamDestination created but context is ${node.context === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Handle createAnalyser calls - indicates VU meter / audio visualization
   * @private
   * @param {AnalyserNode} node
   */
  _handleAnalyserNode(node) {
      // Get context data with late-discovery support
      const ctxData = this._getContextData(node.context);

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
      } else {
          logger.warn(this.logPrefix, `AnalyserNode created but context is ${node.context === null ? 'null' : 'undefined'}`);
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

      // Get context data with late-discovery support
      const ctxData = this._getContextData(node.context);

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
      } else {
          logger.warn(this.logPrefix, `MediaStreamSource created but context is ${node.context === null ? 'null' : 'undefined'}`);
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
   * Handle WASM encoder detection (from Worker.postMessage or AudioWorkletNode.port.postMessage hook)
   * Emits encoder to canonical wasm_encoder storage with optional context linking
   *
   * PATTERN PRIORITY (higher = better, should not be overwritten by lower):
   * - audioworklet-config: 5 (highest - full AudioWorklet config)
   * - direct/nested: 4 (Worker hook with explicit encoder fields)
   * - worker-audio-init: 3 (Worker hook with audio init pattern)
   * - audio-blob: 2 (Blob creation - post-hoc, confirms format)
   * - unknown: 1 (lowest)
   *
   * @private
   * @param {Object} encoderInfo - { type, sampleRate, bitRate, channels, application, applicationName, timestamp, pattern, source, status, originalSampleRate?, frameSize?, bufferLength?, processorName?, blobSize?, workerFilename? }
   */
  _handleWasmEncoder(encoderInfo) {
      logger.info(this.logPrefix, 'WASM encoder detected:', encoderInfo);

      // ═══════════════════════════════════════════════════════════════════
      // PATTERN PRIORITY: Prevent lower-priority patterns from overwriting better ones
      // Example: Blob detection (post-hoc) should not overwrite Worker detection (real-time)
      // ═══════════════════════════════════════════════════════════════════
      const PATTERN_PRIORITY = {
        'audioworklet-config': 5,
        'audioworklet-init': 4,
        'audioworklet-deferred': 4,
        'direct': 4,
        'nested': 4,
        'worker-init': 3,
        'worker-audio-init': 3,
        'audio-blob': 2,
        'unknown': 1
      };

      const newPriority = PATTERN_PRIORITY[encoderInfo.pattern] || 1;
      const existingPriority = this.currentEncoderData
        ? (PATTERN_PRIORITY[this.currentEncoderData.pattern] || 1)
        : 0;

      // If we have a better pattern already, only merge supplementary data from Blob
      if (existingPriority >= newPriority && encoderInfo.pattern === 'audio-blob') {
        // Blob can supplement with: blobSize, codec (if unknown), container, bitRate
        if (this.currentEncoderData) {
          // Merge blobSize and calculated bitRate
          if (encoderInfo.blobSize) {
            this.currentEncoderData.blobSize = encoderInfo.blobSize;
            this.currentEncoderData.mimeType = encoderInfo.mimeType;
            this.currentEncoderData.recordingDuration = encoderInfo.recordingDuration;

            // Use calculated bitRate from Blob if we don't have one OR for live updates
            // Live updates: Allow Blob to update bitRate in real-time while recording is active
            // This fixes the issue where worker-audio-init pattern has bitRate=0 (init message has no bitrate)
            // Blob calculates bitRate from actual data size / duration - more accurate
            const currentBitRateUnknown = !this.currentEncoderData.bitRate || this.currentEncoderData.bitRate === 0;
            const isLiveUpdate = encoderInfo.isLiveEstimate === true;
            if (encoderInfo.calculatedBitRate && (currentBitRateUnknown || isLiveUpdate)) {
              this.currentEncoderData.bitRate = encoderInfo.calculatedBitRate;
              logger.info(this.logPrefix, `📊 BitRate ${isLiveUpdate ? 'updated' : 'calculated'} from Blob: ${Math.round(encoderInfo.calculatedBitRate / 1000)}kbps`);
            }
          }

          // Update codec if currently unknown (Blob provides definitive format)
          if (this.currentEncoderData.codec === 'unknown' && encoderInfo.type) {
            this.currentEncoderData.codec = encoderInfo.type;
            this.currentEncoderData.container = encoderInfo.container;
            logger.info(this.logPrefix, `🎵 Codec confirmed from Blob: ${encoderInfo.type}`);
          }

          // Update encoder if not set (Blob provides encoder info)
          if (!this.currentEncoderData.encoder && encoderInfo.encoder) {
            this.currentEncoderData.encoder = encoderInfo.encoder;
            logger.info(this.logPrefix, `📚 Encoder detected from Blob: ${encoderInfo.encoder}`);
          }

          // Log blob capture
          if (encoderInfo.blobSize) {
            const durationInfo = encoderInfo.recordingDuration ? ` (${encoderInfo.recordingDuration.toFixed(1)}s)` : '';
            logger.info(this.logPrefix, `📦 Blob captured: ${(encoderInfo.blobSize / 1024).toFixed(1)}KB${durationInfo} (pattern preserved: ${this.currentEncoderData.pattern})`);
          }

          // Re-emit with updated data
          if (this.active) {
            this.emit(EVENTS.DATA, this.currentEncoderData);
          }
        }
        return; // Don't overwrite with lower priority pattern
      }

      // Best-effort context matching (may return null if no match)
      const linkedContextId = this._findBestMatchingContextId(encoderInfo.sampleRate);

      // Human-readable application name (Opus terminology)
      // 2048 = OPUS_APPLICATION_VOIP, 2049 = OPUS_APPLICATION_AUDIO, 2051 = OPUS_APPLICATION_LOWDELAY
      const appNames = { 2048: 'VoIP', 2049: 'Audio', 2051: 'LowDelay' };
      const appName = encoderInfo.applicationName || appNames[encoderInfo.application] || null;

      // Build encoder data object
      const encoderData = {
          type: DATA_TYPES.WASM_ENCODER,
          timestamp: Date.now(),
          codec: encoderInfo.type || 'opus',
          encoder: encoderInfo.encoder,  // lamejs, opus-recorder, fdk-aac.js, vorbis.js, libflac.js
          source: encoderInfo.source || 'direct',  // audioworklet-port veya direct
          sampleRate: encoderInfo.sampleRate,
          originalSampleRate: encoderInfo.originalSampleRate,
          bitRate: encoderInfo.bitRate,
          channels: encoderInfo.channels || 1,
          application: encoderInfo.application, // 2048=Voice, 2049=FullBand, 2051=LowDelay
          applicationName: appName, // 'Voice', 'Audio', 'LowDelay'
          container: encoderInfo.container, // 'ogg', 'webm', 'mp4', or null
          encoderPath: encoderInfo.encoderPath, // WASM module path
          pattern: encoderInfo.pattern, // 'direct', 'nested', 'audioworklet-config', etc.
          status: encoderInfo.status || 'initialized',
          frameSize: encoderInfo.frameSize,
          bufferLength: encoderInfo.bufferLength,
          processorName: encoderInfo.processorName, // AudioWorklet processor name
          workerFilename: encoderInfo.workerFilename, // Worker JS filename
          blobSize: encoderInfo.blobSize, // Blob size in bytes (for bitrate calc)
          mimeType: encoderInfo.mimeType, // MIME type from Blob
          linkedContextId  // Context bağlantısı (null olabilir)
      };

      // Store current encoder data for priority comparison
      this.currentEncoderData = encoderData;

      // If collector is not active, store for later emission during start()
      // This handles the case where WASM encoder is detected before user clicks "Start"
      if (!this.active) {
          this.pendingWasmEncoder = encoderData;
          logger.info(this.logPrefix, '📦 WASM encoder queued (collector not active yet)');
      } else {
          // Emit immediately if active
          this.emit(EVENTS.DATA, encoderData);
      }

      const containerInfo = encoderInfo.container ? ` [${encoderInfo.container.toUpperCase()}]` : '';
      logger.info(
          this.logPrefix,
          `🔧 WASM Encoder: ${encoderInfo.type || 'opus'}${containerInfo} @ ${(encoderInfo.bitRate || 0)/1000}kbps, ${encoderInfo.sampleRate}Hz, ${encoderInfo.channels || 1}ch, app=${appName || encoderInfo.application}`
      );
  }

  /**
   * Handle AudioWorkletNode instance creation
   * Captures custom DSP processor instances (e.g., 'opus-encoder', 'noise-suppressor')
   * @private
   * @param {AudioWorkletNode} node
   * @param {any[]} args - [context, processorName, options?]
   */
  _handleAudioWorkletNode(node, args) {
      const context = args[0];      // AudioContext
      const processorName = args[1]; // 'opus-encoder', 'noise-suppressor', vb.
      const options = args[2];       // opsiyonel parametreler

      // Get context data with late-discovery support
      const ctxData = this._getContextData(context);

      if (ctxData) {
          // Add AudioWorkletNode to pipeline processors
          const processorEntry = {
            type: 'audioWorkletNode',
            processorName: processorName,
            options: options,
            timestamp: Date.now()
          };

          // Duplicate check - aynı processorName varsa güncelle
          const existingIdx = ctxData.pipeline.processors.findIndex(
            p => p.type === 'audioWorkletNode' && p.processorName === processorName
          );
          if (existingIdx >= 0) {
            ctxData.pipeline.processors[existingIdx] = processorEntry;
          } else {
            ctxData.pipeline.processors.push(processorEntry);
          }

          ctxData.pipeline.timestamp = Date.now();

          // Re-emit updated context data
          this.emit(EVENTS.DATA, ctxData);
          logger.info(this.logPrefix, `AudioWorkletNode created: ${processorName} (context: ${ctxData.contextId})`);
      } else {
          logger.warn(this.logPrefix, `AudioWorkletNode created but context is ${context === null ? 'null' : 'undefined'}`);
      }
  }

  /**
   * Check if a connection already exists in audioConnections
   * Compares by sourceId + destId + outputIndex + inputIndex (unique connection key)
   * @private
   * @param {Object} connection - Connection to check
   * @returns {boolean} true if duplicate exists
   */
  _isConnectionDuplicate(connection) {
    if (!this.audioConnections || this.audioConnections.length === 0) return false;

    return this.audioConnections.some(existing =>
      existing.sourceId === connection.sourceId &&
      existing.destId === connection.destId &&
      existing.outputIndex === connection.outputIndex &&
      existing.inputIndex === connection.inputIndex
    );
  }

  /**
   * Handle audio connection (AudioNode.connect() calls)
   * Captures the audio graph topology to show data flow between nodes
   * @private
   * @param {Object} connection - { sourceType, sourceId, destType, destId, outputIndex, inputIndex, timestamp }
   * @param {boolean} shouldEmit - If true, emit data event; if false, silent add (for early sync)
   */
  _handleAudioConnection(connection, shouldEmit = true) {
      if (!this.active) return;  // Only process when collector is active

      const { sourceType, sourceId, destType, destId, outputIndex, inputIndex, timestamp } = connection;
      const contextId = connection.contextId || null;

      // Initialize connections array if needed
      if (!this.audioConnections) {
        this.audioConnections = [];
      }

      // Normalize connection object
      const normalizedConnection = {
        sourceType,
        sourceId,
        destType,
        destId,
        outputIndex: outputIndex ?? 0,
        inputIndex: inputIndex ?? 0,
        timestamp,
        contextId
      };

      // ═══════════════════════════════════════════════════════════════════
      // DUPLICATE CHECK: Prevent same connection from being added twice
      // This can happen when:
      // 1. Early capture + real-time capture for same connect() call
      // 2. reEmit() after connections already synced
      // ═══════════════════════════════════════════════════════════════════
      if (this._isConnectionDuplicate(normalizedConnection)) {
        return; // Already exists, skip
      }

      // Add connection to list
      this.audioConnections.push(normalizedConnection);

      // Emit connection data as separate type (unless silent mode)
      if (shouldEmit) {
        this.emit(EVENTS.DATA, {
          type: DATA_TYPES.AUDIO_CONNECTION,
          timestamp,
          connection: normalizedConnection,
          // Also include full connection list for graph rendering
          allConnections: [...this.audioConnections]
        });

        logger.info(this.logPrefix, `Audio connection: ${sourceType} → ${destType}`);
      }
  }

  /**
   * Sync early-captured connections from early-inject.js
   * Called during start() to restore connections made before inspector started
   * @private
   */
  _syncEarlyConnections() {
    // @ts-ignore
    const earlyConnections = window.__earlyCaptures?.connections;
    if (!earlyConnections || earlyConnections.length === 0) {
      return;
    }

    // Get the set of contextIds we're tracking (for filtering)
    const trackedContextIds = new Set();
    for (const [, ctxData] of this.activeContexts.entries()) {
      if (ctxData.contextId) {
        trackedContextIds.add(ctxData.contextId);
      }
    }

    let syncedCount = 0;
    let skippedCount = 0;

    for (const connection of earlyConnections) {
      // Filter: Only sync connections belonging to tracked contexts
      // If contextId is null/undefined, include it (legacy or unknown context)
      if (connection.contextId && trackedContextIds.size > 0 && !trackedContextIds.has(connection.contextId)) {
        skippedCount++;
        continue;
      }

      // Add silently (don't emit per-connection, we'll emit batch at end)
      this._handleAudioConnection(connection, false);
      syncedCount++;
    }

    // Emit all connections at once if any were synced
    if (syncedCount > 0 && this.audioConnections.length > 0) {
      this.emit(EVENTS.DATA, {
        type: DATA_TYPES.AUDIO_CONNECTION,
        timestamp: Date.now(),
        allConnections: [...this.audioConnections]
      });

      logger.info(this.logPrefix, `📡 Synced ${syncedCount} early connection(s) from early-inject.js`);
    }

    if (skippedCount > 0) {
      logger.info(this.logPrefix, `Skipped ${skippedCount} connection(s) from other contexts`);
    }

    // Clear early connections after sync to prevent re-processing on next start()
    // But keep the array reference intact for new connections
    // @ts-ignore
    window.__earlyCaptures.connections = [];
  }

  /**
   * Sync early-captured AudioWorkletNodes from early-inject.js
   * Called during start() to restore AudioWorkletNodes (e.g., peak-worklet-processor)
   * created before inspector started - ensures UI consistency on refresh vs initial start
   * @private
   */
  _syncEarlyAudioWorkletNodes() {
    // @ts-ignore
    const earlyNodes = window.__earlyCaptures?.audioWorkletNodes;
    if (!earlyNodes || earlyNodes.length === 0) {
      return;
    }

    let syncedCount = 0;

    for (const capture of earlyNodes) {
      const { context, processorName, options, timestamp, contextId } = capture;

      // Find context in activeContexts
      const ctxData = context ? this.activeContexts.get(context) : null;

      if (ctxData) {
        // Add AudioWorkletNode to pipeline processors (duplicate check)
        const processorEntry = {
          type: 'audioWorkletNode',
          processorName: processorName,
          options: options,
          timestamp: timestamp
        };

        // Duplicate check - same processorName
        const existingIdx = ctxData.pipeline.processors.findIndex(
          p => p.type === 'audioWorkletNode' && p.processorName === processorName
        );

        if (existingIdx < 0) {
          ctxData.pipeline.processors.push(processorEntry);
          ctxData.pipeline.timestamp = Date.now();
          syncedCount++;
        }
      } else {
        logger.info(this.logPrefix, `Skipping early AudioWorkletNode (${processorName}) - context not in activeContexts`);
      }
    }

    // Batch emit updated contexts
    if (syncedCount > 0) {
      for (const [ctx, ctxData] of this.activeContexts.entries()) {
        if (ctx.state !== 'closed') {
          this.emit(EVENTS.DATA, ctxData);
        }
      }
      logger.info(this.logPrefix, `📡 Synced ${syncedCount} early AudioWorkletNode(s) from early-inject.js`);
    }

    // Clear after sync
    // @ts-ignore
    window.__earlyCaptures.audioWorkletNodes = [];
  }

  /**
   * Start collector
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // ═══════════════════════════════════════════════════════════════════
    // IMPORTANT: Do NOT clear early captures here!
    // Early captures contain AudioContexts created BEFORE inspector started.
    // We need to process them first, then clear only methodCalls (not instances).
    // Cross-origin protection is handled by content.js tab/origin validation.
    // ═══════════════════════════════════════════════════════════════════

    // 1. Clear activeContexts Map (our internal state)
    const previousSize = this.activeContexts.size;
    this.currentEncoderData = null; // Clear encoder pattern priority state
    this.activeContexts.clear();
    // Keep counter in sync with global context ID map to avoid duplicates
    const win = /** @type {any} */ (window);
    this.contextIdCounter = Number.isInteger(win.__audioInspectorContextIdCounter)
      ? win.__audioInspectorContextIdCounter
      : 0;
    this.pendingWorklets = []; // Clear pending worklet queue
    logger.info(this.logPrefix, `Cleared ${previousSize} previous context(s) from activeContexts`);

    // 2. Clean up closed contexts from EarlyHook registry
    cleanupClosedAudioContexts();

    // 3. Re-register WASM encoder handler
    // @ts-ignore
    window.__wasmEncoderHandler = (encoderInfo) => {
      this._handleWasmEncoder(encoderInfo);
    };

    // 4. Re-register AudioWorkletNode handler
    // @ts-ignore
    window.__audioWorkletNodeHandler = (node, args) => {
      this._handleAudioWorkletNode(node, args);
    };

    // 5. Re-register audio connection handler
    // @ts-ignore
    window.__audioConnectionHandler = (connection) => {
      this._handleAudioConnection(connection);
    };

    // 6. Clear any stale WASM encoder detection
    // @ts-ignore
    window.__wasmEncoderDetected = null;

    // 7. Register new recording session handler
    // When MediaRecorder starts a new recording, reset encoder detection state
    // Note: Data cleanup is no longer needed here - inspector will auto-stop
    // via AUTO_STOP_NEW_RECORDING message (early-inject.js → content.js)
    // @ts-ignore
    window.__newRecordingSessionHandler = () => {
      if (this.active) {
        // Reset encoder detection state (prevents stale encoder info on restart)
        this.currentEncoderData = null;
        logger.info(this.logPrefix, '🔄 New recording session - encoder detection reset');
      }
    };

    // ═══════════════════════════════════════════════════════════════════
    // SINGLE SOURCE OF TRUTH: Prevent double processing
    // earlyCaptures ve registry aynı instance'ı içerebilir (syncEarlyCaptures)
    // WeakSet ile işlenen instance'ları takip et
    // ═══════════════════════════════════════════════════════════════════

    /** @type {WeakSet<AudioContext>} */
    const processedInstances = new WeakSet();
    let earlyCount = 0;
    let registryCount = 0;
    let pipelineSyncedCount = 0;

    // ───────────────────────────────────────────────────────────────────
    // 1. PRIMARY SOURCE: early-inject.js captures (MAIN world content script)
    // These are AudioContexts created before page.js loaded
    // ───────────────────────────────────────────────────────────────────
    // @ts-ignore
    const earlyCaptures = window.__earlyCaptures?.audioContexts;
    if (earlyCaptures?.length) {
      logger.info(this.logPrefix, `📥 Processing ${earlyCaptures.length} early AudioContext capture(s)`);
      for (const capture of earlyCaptures) {
        if (capture.instance.state !== 'closed') {
          this._handleNewContext(capture.instance, true);
          processedInstances.add(capture.instance); // Mark as processed
          earlyCount++;

          // ═══════════════════════════════════════════════════════════════
          // SYNC EARLY METHOD CALLS: Pipeline data from early-inject.js
          // These were captured BEFORE page.js loaded - critical for sites
          // that set up audio pipeline immediately after AudioContext creation
          // ═══════════════════════════════════════════════════════════════
          if (capture.methodCalls?.length > 0) {
            this._syncMethodCallsToExistingContext(capture.instance, capture.methodCalls);
            pipelineSyncedCount++;
            logger.info(this.logPrefix, `📡 Synced ${capture.methodCalls.length} early method call(s) from early-inject.js`);
          }
        }
      }
      // NOT: earlyCaptures'ı silmiyoruz - inspector tekrar başlatıldığında
      // hala aktif context'leri tekrar işleyebilmek için tutuyoruz
      // Sadece methodCalls'ı temizliyoruz (sync edildi)
      for (const capture of earlyCaptures) {
        if (capture.methodCalls) capture.methodCalls = [];
      }
    }

    // ───────────────────────────────────────────────────────────────────
    // 2. FALLBACK SOURCE: EarlyHook.js registry
    // May contain same instances as earlyCaptures (via syncEarlyCaptures)
    // DUPLICATE CHECK: Skip if already processed, only sync methodCalls
    // ───────────────────────────────────────────────────────────────────
    const registry = getInstanceRegistry();

    for (const entry of registry.audioContexts) {
      const { instance, methodCalls } = entry;

      // Skip closed contexts - we only want active ones
      if (instance.state === 'closed') {
        logger.info(this.logPrefix, `Skipping closed context from registry (${instance.sampleRate}Hz)`);
        continue;
      }

      // ══════════════════════════════════════════════════════════════════
      // DUPLICATE CHECK: If already processed from earlyCaptures, only sync methodCalls
      // ══════════════════════════════════════════════════════════════════
      if (processedInstances.has(instance)) {
        // Context already added - only sync methodCalls if available
        if (methodCalls?.length > 0) {
          this._syncMethodCallsToExistingContext(instance, methodCalls);
          pipelineSyncedCount++;
        }
        entry.methodCalls = []; // Clean up
        continue;
      }

      // New context from registry - process it
      this._handleNewContext(instance, true);
      processedInstances.add(instance);
      registryCount++;

      // Sync methodCalls to pipeline (late capture) - data-driven via METHOD_CALL_SYNC_HANDLERS
      if (methodCalls?.length > 0) {
        this._syncMethodCallsToExistingContext(instance, methodCalls);
        pipelineSyncedCount++;
      }

      // Clean up methodCalls - stale data prevention for next start()
      entry.methodCalls = [];
    }

    // ───────────────────────────────────────────────────────────────────
    // SUMMARY LOG: Clear breakdown of what was processed
    // ───────────────────────────────────────────────────────────────────
    const totalProcessed = this.activeContexts.size;
    if (totalProcessed > 0) {
      logger.info(this.logPrefix, `✅ Processed ${totalProcessed} AudioContext(s) total (${earlyCount} from earlyCaptures, ${registryCount} from registry)`);
      if (pipelineSyncedCount > 0) {
        logger.info(this.logPrefix, `Synced pipeline data for ${pipelineSyncedCount} context(s) (late capture)`);
      }
    } else {
      logger.info(this.logPrefix, 'No running AudioContexts to sync (will capture new ones)');
    }

    // NOTE: __wasmEncoderDetected was cleared at start (clean slate approach)
    // WASM encoder will be detected fresh when encoding actually starts

    // ───────────────────────────────────────────────────────────────────
    // 3. EMIT PENDING WASM ENCODER (if detected before start())
    // Also restore currentEncoderData for pattern priority to work correctly
    // ───────────────────────────────────────────────────────────────────
    if (this.pendingWasmEncoder) {
      logger.info(this.logPrefix, '📤 Emitting pending WASM encoder data');
      this.emit(EVENTS.DATA, this.pendingWasmEncoder);
      // Restore currentEncoderData for pattern priority (e.g., Blob supplement)
      this.currentEncoderData = this.pendingWasmEncoder;
      this.pendingWasmEncoder = null;  // Clear pending after restore
    }

    // ───────────────────────────────────────────────────────────────────
    // 4. SYNC EARLY CONNECTIONS from early-inject.js
    // These are AudioNode.connect() calls made before inspector started
    // Critical for sites that set up audio graph immediately on page load
    // ───────────────────────────────────────────────────────────────────
    this.audioConnections = [];  // Start fresh
    this._syncEarlyConnections();  // Sync from __earlyCaptures.connections

    // ───────────────────────────────────────────────────────────────────
    // 5. SYNC EARLY AUDIOWORKLETNODES from early-inject.js
    // These are AudioWorkletNodes (e.g., VU meters) created before inspector started
    // Critical for UI consistency: same data on initial start vs page refresh
    // ───────────────────────────────────────────────────────────────────
    this._syncEarlyAudioWorkletNodes();  // Sync from __earlyCaptures.audioWorkletNodes

    logger.info(this.logPrefix, 'Started - ready to capture new audio activity');
  }

  /**
   * Re-emit current data from active contexts and connections
   * Called when UI needs to be refreshed (e.g., after data reset)
   */
  reEmit() {
    if (!this.active) return;

    // 1. Re-emit AudioContext metadata
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

    // 2. Re-emit audio connections (for Audio Graph UI)
    if (this.audioConnections && this.audioConnections.length > 0) {
      this.emit(EVENTS.DATA, {
        type: DATA_TYPES.AUDIO_CONNECTION,
        timestamp: Date.now(),
        allConnections: [...this.audioConnections]
      });
      logger.info(this.logPrefix, `Re-emitted ${this.audioConnections.length} audio connection(s)`);
    }
  }

  /**
   * Stop collector
   * @returns {Promise<void>}
   */
  async stop() {
    this.active = false;

    // Clear all global handlers to prevent stale data and memory leaks
    // This is critical - without this, EarlyHook continues to detect and store encoder info
    // even when inspector is stopped, causing stale data on restart
    // @ts-ignore
    window.__audioContextCollectorHandler = null;
    // @ts-ignore
    window.__wasmEncoderHandler = null;
    // @ts-ignore
    window.__audioWorkletNodeHandler = null;
    // @ts-ignore
    window.__newRecordingSessionHandler = null;
    // @ts-ignore - Connection handler: null so new connections go to earlyCaptures only
    window.__audioConnectionHandler = null;
    logger.info(this.logPrefix, 'Cleared all handlers on stop');

    // Clear stale WASM encoder detection
    // @ts-ignore
    if (window.__wasmEncoderDetected) {
      // @ts-ignore
      window.__wasmEncoderDetected = null;
      logger.info(this.logPrefix, 'Cleared __wasmEncoderDetected on stop');
    }

    // Clear AudioWorklet encoder heuristic detection cache
    // @ts-ignore
    if (window.__audioWorkletEncoderDetected) {
      // @ts-ignore
      window.__audioWorkletEncoderDetected = null;
    }

    // Clear pending WASM encoder to prevent stale data on restart
    this.pendingWasmEncoder = null;

    // Clear pending worklets to prevent memory leak in long sessions
    this.pendingWorklets = [];

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
