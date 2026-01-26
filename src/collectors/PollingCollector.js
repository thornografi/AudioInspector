// @ts-check

import BaseCollector from './BaseCollector.js';
import { logger } from '../core/Logger.js';

/**
 * @abstract
 * Base class for collectors that need to poll for data periodically.
 * Extends BaseCollector and provides polling mechanisms.
 */
class PollingCollector extends BaseCollector {
  /**
   * @param {string} name - Unique collector name
   * @param {Object} [options={}] - Collector options
   * @param {number} [options.pollIntervalMs=1000] - Polling interval in milliseconds
   */
  constructor(name, options = {}) {
    super(name, options);

    /** @type {number|null} */
    this.pollIntervalId = null;

    /** @type {number} */
    this.pollIntervalMs = options.pollIntervalMs || 1000;

    /** @type {boolean} Re-entrancy guard - prevents overlapping collectData calls */
    this.isCollecting = false;
  }

  /**
   * Start the polling mechanism.
   * Subclasses should call this in their start() hooks (e.g., _onStartComplete).
   * Note: this.active is set by BaseCollector.start() template method,
   * so we check pollIntervalId to detect if polling is already running.
   */
  async startPolling() {
    // Guard: Check if polling is already running (not active flag, which is set by BaseCollector)
    if (this.pollIntervalId !== null) {
      logger.warn(this.logPrefix, `Polling already active.`);
      return;
    }

    // Note: this.active is already true from BaseCollector.start() template
    this.isCollecting = false; // Reset guard on start

    // Call collectData immediately on start
    await this.collectData();

    this.pollIntervalId = setInterval(async () => {
      // Re-entrancy guard: skip if previous collectData is still running
      if (this.isCollecting) {
        logger.warn(this.logPrefix, 'Skipping poll - previous collection still in progress');
        return;
      }
      this.isCollecting = true;
      try {
        await this.collectData();
      } finally {
        this.isCollecting = false;
      }
    }, this.pollIntervalMs);

    logger.info(this.logPrefix, `Polling started (every ${this.pollIntervalMs}ms)`);
  }

  /**
   * Stop the polling mechanism.
   * Subclasses should call this in their `stop()` method.
   */
  async stopPolling() {
    if (!this.active) {
      logger.warn(this.logPrefix, `Polling already stopped.`);
      return;
    }

    this.active = false;
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    logger.info(this.logPrefix, `Polling stopped.`);
  }

  /**
   * Abstract method that subclasses must implement to define how data is collected.
   * @abstract
   * @returns {Promise<void>}
   */
  async collectData() {
    throw new Error('collectData() must be implemented by subclass');
  }
}

export default PollingCollector;
