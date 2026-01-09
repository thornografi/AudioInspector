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
  }

  /**
   * Start the polling mechanism.
   * Subclasses should call this in their `start()` method.
   */
  async startPolling() {
    if (this.active) {
      logger.warn(this.logPrefix, `Polling already active.`);
      return;
    }

    this.active = true;

    // Call collectData immediately on start
    await this.collectData();

    this.pollIntervalId = setInterval(async () => {
      await this.collectData();
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
