// @ts-check

import { LOG_PREFIX } from './constants.js';

/**
 * @typedef {'info' | 'warn' | 'error'} LogLevel
 */

/**
 * @typedef {object} LogEntry
 * @property {string} timestamp
 * @property {LogLevel} level
 * @property {string} prefix
 * @property {string} message
 * @property {any} [data]
 */

/**
 * Centralized logger service.
 * Allows toggling debug logs on/off.
 */
class Logger {
  constructor() {
    this.enabled = true; // Default to true for now, can be toggled via messages
    /** @type {LogEntry[]} */
    /** @type {LogEntry[]} */
    this.history = [];
    this.MAX_HISTORY = 100;
    /** @type {((entry: LogEntry) => void)[]} */
    this.listeners = [];
  }

  /**
   * Add a listener for new log entries
   * @param {(entry: LogEntry) => void} callback 
   */
  addListener(callback) {
    this.listeners.push(callback);
  }

  /**
   * Remove a listener
   * @param {(entry: LogEntry) => void} callback 
   */
  removeListener(callback) {
    this.listeners = this.listeners.filter(cb => cb !== callback);
  }

  /**
   * Enable or disable logging
   * @param {boolean} enabled
   * @returns {void}
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Log info message
   * @param {string} prefix - Context prefix
   * @param {string} message
   * @param {any} [data]
   * @returns {void}
   */
  info(prefix, message, data) {
    if (!this.enabled) return;
    this._log('info', prefix, message, data);
  }

  /**
   * Log warning message
   * @param {string} prefix
   * @param {string} message
   * @param {any} [data]
   * @returns {void}
   */
  warn(prefix, message, data) {
    this._log('warn', prefix, message, data);
  }

  /**
   * Log error message
   * @param {string} prefix
   * @param {string} message
   * @param {any} [data]
   * @returns {void}
   */
  error(prefix, message, data) {
    this._log('error', prefix, message, data);
  }

  /**
   * Internal log handler
   * @private
   * @param {LogLevel} level
   * @param {string} prefix
   * @param {string} message
   * @param {any} [data]
   * @returns {void}
   */
  _log(level, prefix, message, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      prefix,
      message,
      data
    };

    this.history.push(entry);
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }

    // Expose history globally for debugging
    // @ts-ignore
    window.__audioPipelineLogs = this.history;

    // Notify listeners
    this.listeners.forEach(listener => {
      try {
        listener(entry);
      } catch (e) {
        console.error('Error in log listener:', e);
      }
    });

    const formattedMsg = `${prefix} ${message}`;
    // Asserting the type of console to ensure 'level' can be used as an index
    const consoleMethod = /** @type {(...args: any[]) => void} */ (console[level]);
    if (data !== undefined) {
      consoleMethod(formattedMsg, data);
    } else {
      consoleMethod(formattedMsg);
    }
  }
}

export const logger = new Logger();