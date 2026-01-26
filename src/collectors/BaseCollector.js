// @ts-check

import { logger } from '../core/Logger.js';

/**
 * @abstract
 * Base class for all audio data collectors.
 * Implements Observer pattern - collectors emit events when data is collected.
 *
 * @example
 * class MyCollector extends BaseCollector {
 *   constructor() {
 *     super('my-collector');
 *   }
 *
 *   async initialize() {
 *     // Hook APIs
 *   }
 *
 *   async start() {
 *     // Start collecting
 *     this.emit('data', { ... });
 *   }
 * }
 */
class BaseCollector {
  /**
   * @param {string} name - Unique collector name (e.g., 'rtc-peer-connection')
   * @param {Object} [options={}] - Collector-specific options
   * @param {number} [options.pollIntervalMs=1000] - Polling interval in milliseconds
   */
  constructor(name, options = {}) {
    if (new.target === BaseCollector) {
      throw new Error('BaseCollector is abstract and cannot be instantiated directly');
    }

    /** @type {string} */
    this.name = name;

    /** @type {Object} */
    this.options = options;

    /** @type {boolean} */
    this.active = false;

    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * Returns the formatted log prefix for this collector.
   * @returns {string}
   */
  get logPrefix() {
    return `[${this.name}]`;
  }

  /**
   * Initialize the collector (hook APIs, setup listeners, etc.)
   * @abstract
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Start collecting data - Template Method Pattern
   *
   * Subclasses should override hook methods (_processEarlyInstances, _onStartComplete)
   * instead of overriding this method entirely.
   *
   * Exception: Complex collectors (AudioContextCollector) may override start() entirely
   * and should add @override JSDoc to indicate intentional override.
   *
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // Hook 1: Process early captures and registry instances
    const processedCount = await this._processEarlyInstances();

    // Hook 2: Post-start actions (polling, etc.)
    await this._onStartComplete(processedCount);

    // Log start message
    const msg = processedCount > 0
      ? `Started (processed ${processedCount} early instance(s))`
      : 'Started';
    logger.info(this.logPrefix, msg);
  }

  /**
   * Hook: Process early captures from early-inject.js and registry
   * Override in subclass to process instances created before collector started
   * @protected
   * @returns {Promise<number>} Number of processed instances
   */
  async _processEarlyInstances() {
    return 0;
  }

  /**
   * Hook: Post-start actions after early instances are processed
   * Override in subclass for actions like starting polling, emitting existing state, etc.
   * @protected
   * @param {number} processedCount - Number of early instances that were processed
   * @returns {Promise<void>}
   */
  async _onStartComplete(processedCount) {
    // Default: no-op
  }

  /**
   * Stop collecting data and cleanup
   * @abstract
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('stop() must be implemented by subclass');
  }

  /**
   * Re-emit current data from active instances - Template Method Pattern
   * Called when UI needs to be refreshed (e.g., after data reset)
   *
   * Subclasses should override hook methods (_reEmitActiveItems) instead of this method.
   * Exception: Complex collectors (AudioContextCollector, RTCPeerConnectionCollector)
   * may override reEmit() entirely with @override JSDoc.
   */
  reEmit() {
    if (!this.active) return;

    // Hook: Re-emit main active items (streams, recorders, etc.)
    const emittedCount = this._reEmitActiveItems();

    // Log completion
    if (emittedCount > 0) {
      logger.info(this.logPrefix, `Re-emitted ${emittedCount} item(s)`);
    }
  }

  /**
   * Hook: Re-emit active items
   * Override in subclass to emit current state from active instances
   * @protected
   * @returns {number} Number of items emitted
   */
  _reEmitActiveItems() {
    return 0;
  }

  /**
   * Reset session state when technology changes or new recording starts
   * Called by PageInspector when COLLECTOR_RESET message is received
   *
   * @param {'hard' | 'soft' | 'none'} resetType - Type of reset
   *   - 'hard': Technology changed (e.g., MediaRecorder → ScriptProcessor)
   *             Clear all pipeline + encoder data
   *   - 'soft': Same technology, new recording (e.g., Opus → MP3 with same path)
   *             Clear only encoder data, preserve warming/pipeline data
   *   - 'none': No reset needed, just update encoder data
   * @param {number} sessionId - New recording session ID
   */
  resetSession(resetType, sessionId) {
    // Default: no-op
    // Subclasses that maintain encoder/pipeline state should override
  }

  /**
   * Register a global handler on window object for early hook communication.
   * EarlyHook.js captures instances before collectors are ready - this handler
   * allows collectors to receive those instances when they initialize.
   *
   * @param {string} handlerName - Global handler name (e.g., '__rtcPeerConnectionCollectorHandler')
   * @param {Function} handler - Handler function to register
   */
  registerGlobalHandler(handlerName, handler) {
    try {
      // @ts-ignore - Dynamic window property assignment
      window[handlerName] = handler;
      logger.info(this.logPrefix, `Global handler registered: ${handlerName}`);
    } catch (err) {
      logger.warn(this.logPrefix, `Failed to register global handler ${handlerName}:`, err);
    }
  }

  /**
   * Emit event to listeners (used internally by subclasses)
   * Only emits if collector is active (started)
   * @param {string} eventName - Event name (e.g., 'data', 'error', 'stats')
   * @param {*} data - Event payload
   */
  emit(eventName, data) {
    // Only emit if collector is active (started)
    if (!this.active) {
      return;
    }

    const callbacks = this.listeners.get(eventName);
    if (callbacks) {
      callbacks.forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          logger.error(this.logPrefix, 'Event handler error:', err);
        }
      });
    }
  }

  /**
   * Subscribe to collector events
   * @param {string} eventName - Event to listen for
   * @param {Function} callback - Callback function
   */
  on(eventName, callback) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    const set = this.listeners.get(eventName);
    if (set) {
        set.add(callback);
    }
  }

  /**
   * Unsubscribe from events
   * @param {string} eventName - Event name
   * @param {Function} callback - Callback function to remove
   */
  off(eventName, callback) {
    const callbacks = this.listeners.get(eventName);
    if (callbacks) {
      callbacks.delete(callback);
    }
  }

  /**
   * Remove all listeners for an event (or all events if no eventName provided)
   * @param {string} [eventName] - Optional event name to clear
   */
  removeAllListeners(eventName) {
    if (eventName) {
      this.listeners.delete(eventName);
    } else {
      this.listeners.clear();
    }
  }
}

export default BaseCollector;
