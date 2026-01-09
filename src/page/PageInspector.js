// @ts-check

import RTCPeerConnectionCollector from '../collectors/RTCPeerConnectionCollector.js';
import GetUserMediaCollector from '../collectors/GetUserMediaCollector.js';
import AudioContextCollector from '../collectors/AudioContextCollector.js';
import MediaRecorderCollector from '../collectors/MediaRecorderCollector.js';
import { logger } from '../core/Logger.js';
import { EVENTS, INSTALL_FLAG, LOG_PREFIX, RTC_STATS_POLL_INTERVAL_MS, MESSAGE_MARKER } from '../core/constants.js';

/**
 * Main coordinator for page-level audio inspection.
 * Orchestrates collectors and handles reporting.
 */
class PageInspector {
  constructor() {
    /** @type {Array<import('../collectors/BaseCollector').default>} */
    this.collectors = [];

    /** @type {boolean} */
    this.initialized = false;

    /** @type {boolean} */
    this.inspectorEnabled = false;
  }

  /**
   * Initialize the page inspector
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      logger.warn(LOG_PREFIX.INSPECTOR, 'Already initialized');
      return;
    }

    logger.info(LOG_PREFIX.INSPECTOR, 'Initializing...');

    // Wire up logger to report logs to extension
    logger.addListener((entry) => {
      this._reportLog(entry);
    });

    try {
      // 1. Instantiate Collectors
      this.collectors = [
        new RTCPeerConnectionCollector({ pollIntervalMs: RTC_STATS_POLL_INTERVAL_MS }),
        new GetUserMediaCollector(),
        new AudioContextCollector(),
        new MediaRecorderCollector()
      ];

      // 2. Initialize and Wire Collectors
      for (const collector of this.collectors) {
        logger.info(LOG_PREFIX.INSPECTOR, `Starting initialization of ${collector.name}...`);
        
        // Wire events for reporting
        collector.on(EVENTS.DATA, (/** @type {any} */ data) => {
          this._report(data);
        });

        // Initialize hook
        try {
          await collector.initialize();
          logger.info(LOG_PREFIX.INSPECTOR, `✅ Initialized ${collector.name}`);
        } catch (initErr) {
          logger.error(LOG_PREFIX.INSPECTOR, `❌ Failed to initialize ${collector.name}:`, initErr);
        }
      }

      logger.info(LOG_PREFIX.INSPECTOR, 'Waiting for extension command to start...');

      // 4. Setup control listeners
      this._setupControlListener();

      this.initialized = true;
      logger.info(LOG_PREFIX.INSPECTOR, '✅ Initialized successfully. Ready for command.');
      logger.info(LOG_PREFIX.INSPECTOR, `Loaded ${this.collectors.length} collectors`);

      // 5. Notify content script that we're ready (for state restoration)
      this._notifyReady();

    } catch (err) {
      logger.error(LOG_PREFIX.INSPECTOR, '❌ Initialization failed:', err);
      throw err;
    }
  }

  /**
   * Notify content script that PageInspector is ready
   * @private
   */
  _notifyReady() {
    try {
      window.postMessage({
        [MESSAGE_MARKER]: true,
        type: 'INSPECTOR_READY'
      }, '*');
      logger.info(LOG_PREFIX.INSPECTOR, 'Notified content script: READY');
    } catch (err) {
      logger.error(LOG_PREFIX.INSPECTOR, 'Failed to notify ready', err);
    }
  }

  /**
   * Report log entry to extension
   * @private
   * @param {import('../core/Logger.js').LogEntry} entry
   */
  _reportLog(entry) {
    try {
      window.postMessage({
        [MESSAGE_MARKER]: true,
        type: 'LOG_ENTRY',
        payload: entry
      }, '*');
    } catch (err) {
      // Avoid infinite loops if logging fails
      console.error('Failed to report log:', err);
    }
  }

  /**
   * Direct reporting to window.postMessage
   * @private
   * @param {Object} data - Data to report
   */
  _report(data) {
    if (!data) return;
    
    // In strict mode or some contexts, we might want to check this.inspectorEnabled
    // But typically collectors won't emit DATA unless they are active.
    
    try {
      window.postMessage({
        [MESSAGE_MARKER]: true,
        payload: data
      }, '*');
    } catch (err) {
      logger.error(LOG_PREFIX.INSPECTOR, 'Failed to report data', err);
    }
  }

  /**
   * Setup listener for control messages from extension
   * @private
   */
  _setupControlListener() {
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      if (!event.data?.__audioPipelineInspector) return;

      if (event.data.type === 'SET_ENABLED') {
        const enabled = event.data.enabled;

        if (this.inspectorEnabled === enabled) {
            logger.info(LOG_PREFIX.INSPECTOR, `SET_ENABLED = ${enabled} (already in this state, ignoring)`);
            return;
        }

        logger.info(LOG_PREFIX.INSPECTOR, `Control message: SET_ENABLED = ${enabled} (current: ${this.inspectorEnabled})`);

        this.inspectorEnabled = enabled;

        if (enabled) {
            logger.info(LOG_PREFIX.INSPECTOR, 'Starting all collectors...');
            await this._startAllCollectors();
            logger.setEnabled(true); // Enable logging after start
            logger.info(LOG_PREFIX.INSPECTOR, '✅ Started');
        } else {
            logger.info(LOG_PREFIX.INSPECTOR, 'Stopping all collectors...');
            await this._stopAllCollectors();
            logger.info(LOG_PREFIX.INSPECTOR, '⏸️ Stopped');
            logger.setEnabled(false); // Disable logging AFTER stopped message
        }
      }
    });
  }

  /**
   * Shutdown the page inspector
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (!this.initialized) {
      return;
    }

    logger.info(LOG_PREFIX.INSPECTOR, 'Shutting down...');
    await this._stopAllCollectors();
    this.initialized = false;
    logger.info(LOG_PREFIX.INSPECTOR, 'Shutdown complete');
  }

  /**
   * @private
   */
  async _stopAllCollectors() {
    await Promise.all(this.collectors.map(c => c.stop()));
  }

  /**
   * @private
   */
  async _startAllCollectors() {
    await Promise.all(this.collectors.map(c => c.start()));
  }
}

// Auto-run (when not feature-flagged)
export function autoRun() {
  const win = /** @type {any} */ (window);
  if (win[INSTALL_FLAG]) {
    logger.info(LOG_PREFIX.INSPECTOR, 'Already installed');
    return;
  }
  win[INSTALL_FLAG] = true;

  const inspector = new PageInspector();
  inspector.initialize().catch(err => {
    logger.error(LOG_PREFIX.INSPECTOR, 'Auto-run failed:', err);
  });

  // Expose for debugging
  win.__pageInspector = inspector;
}
