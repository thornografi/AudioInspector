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
   * Start collecting data
   * @abstract
   * @returns {Promise<void>}
   */
  async start() {
    throw new Error('start() must be implemented by subclass');
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
          console.error(`[${this.name}] Event handler error:`, err);
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
