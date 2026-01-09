// @ts-check

import { logger } from '../core/Logger.js';
import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES } from '../core/constants.js';
import { parseMimeType, getCodecInfo } from '../core/utils/CodecParser.js';
import { getInstanceRegistry, clearRegistryKey } from '../core/utils/EarlyHook.js';

/**
 * Collects MediaRecorder stats (mimeType, bitrate).
 * Hooks into window.MediaRecorder.
 */
class MediaRecorderCollector extends BaseCollector {
  constructor(options = {}) {
    super('media-recorder', options);

    /** @type {Function|null} */
    this.originalMediaRecorder = null;
    
    /** @type {Map<any, any>} */
    this.activeRecorders = new Map();

    /** @type {Map<any, Array<{type: string, listener: any}>>} */
    this.listenersMap = new Map();
  }

  /**
   * Initialize collector - hook MediaRecorder
   * NOTE: Early hooks (EarlyHook.js) already installed MediaRecorder Proxy.
   * We skip hookConstructor here to avoid overwriting the early Proxy.
   * @returns {Promise<void>}
   */
  async initialize() {
    logger.info(this.logPrefix, 'Initializing MediaRecorderCollector');
    if (!window.MediaRecorder) {
      logger.warn(this.logPrefix, `window.MediaRecorder is not available. MediaRecorderCollector cannot function.`);
      return;
    }

    // Register global handler IMMEDIATELY (even before start)
    // @ts-ignore
    window.__mediaRecorderCollectorHandler = (recorder, args) => {
      logger.info(this.logPrefix, 'MediaRecorder constructor called via hook');
      this._handleNewRecorder(recorder, args);
    };

    // Early hooks already installed constructor hooks, so we skip hookConstructor here
    logger.info(this.logPrefix, 'Skipping constructor hook (early hook already installed)');
  }

  /**
   * @param {any} recorder 
   * @param {string} type 
   * @param {EventListenerOrEventListenerObject} listener 
   */
  _addRecorderListener(recorder, type, listener) {
    recorder.addEventListener(type, listener);
    if (!this.listenersMap.has(recorder)) {
      this.listenersMap.set(recorder, []);
    }
    const listeners = this.listenersMap.get(recorder);
    if (listeners) {
        listeners.push({type, listener});
    }
  }

  /**
   * @param {any} recorder 
   */
  _removeAllListeners(recorder) {
    const listeners = this.listenersMap.get(recorder);
    if (listeners) {
      listeners.forEach(({type, listener}) => {
        recorder.removeEventListener(type, listener);
      });
      this.listenersMap.delete(recorder);
    }
  }

  /**
   * Helper to create an event listener for MediaRecorder instance.
   * @param {any} recorder
   * @param {string} eventType
   * @param {string} eventName
   * @param {any} metadata
   * @returns {void}
   */
  _createRecorderEventListener(recorder, eventType, eventName, metadata) {
    const listener = (/** @type {any} */ event) => {
      metadata.state = recorder.state; // State might change on event
      const eventData = { name: eventName, timestamp: Date.now() };
      
      if (eventType === 'dataavailable' && event.data && event.data.size > 0) {
        Object.assign(eventData, { size: event.data.size, mimeType: event.data.type });
      } else if (eventType === 'error' && event.error) {
        Object.assign(eventData, { message: event.error.message });
      }
      
      metadata.events.push(eventData);
      this.emit(EVENTS.DATA, metadata);  // Emit metadata directly
      
      if (eventType === 'dataavailable') {
        logger.info(this.logPrefix, `MediaRecorder ${eventName}: size=${event.data.size}, type=${event.data.type}`);
      } else if (eventType === 'error') {
        logger.error(this.logPrefix, `MediaRecorder ${eventName}:`, event.error);
      } else {
        logger.info(this.logPrefix, `MediaRecorder ${eventName}`);
      }

      // Special handling for 'stop' event to clean up
      if (eventType === 'stop') {
        // We delay cleanup slightly to ensure 'stop' event propagates if needed, 
        // though typically synchronous cleanup is fine.
        // But we must NOT delete metadata yet if we want to report the 'stop' event itself.
        // The event is already emitted above.
      }
    };
    this._addRecorderListener(recorder, eventType, listener);
  }

  /**
   * Handle new MediaRecorder instance
   * @private
   * @param {any} recorder
   * @param {any[]} args
   */
  _handleNewRecorder(recorder, args) {
      logger.info(this.logPrefix, `_handleNewRecorder called for new MediaRecorder instance.`);
      const options = args[1] || {}; // Constructor signature: (stream, options)

      // Parse mimeType to extract codec info
      const parsedMime = parseMimeType(recorder.mimeType);
      const codecInfo = getCodecInfo(parsedMime.codec);

      const metadata = {
        type: DATA_TYPES.MEDIA_RECORDER,
        timestamp: Date.now(),
        mimeType: recorder.mimeType,
        parsedMimeType: parsedMime,
        codecInfo: codecInfo,
        audioBitsPerSecond: recorder.audioBitsPerSecond,
        state: recorder.state,
        requestedOptions: options,
        events: []
      };

      this.activeRecorders.set(recorder, metadata);
      
      // Add event listeners (Standard events only)
      this._createRecorderEventListener(recorder, 'dataavailable', 'dataavailable', metadata);
      this._createRecorderEventListener(recorder, 'start', 'event:start', metadata);
      this._createRecorderEventListener(recorder, 'stop', 'event:stop', metadata);
      this._createRecorderEventListener(recorder, 'pause', 'event:pause', metadata);
      this._createRecorderEventListener(recorder, 'resume', 'event:resume', metadata);
      this._createRecorderEventListener(recorder, 'error', 'error', metadata);

      // İlk emit kaldırıldı - sadece 'start' event'inde emit edilecek
      // (inactive MediaRecorder'lar artık görünmeyecek)

      logger.info(this.logPrefix, `MediaRecorder created:`, JSON.stringify(metadata));
  }

  /**
   * Start collector
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // Registry'deki eski instance'ları ignore et
    // Sadece yeni oluşturulan MediaRecorder'ları izle
    // Bu, profil değişikliğinde eski verilerin görünmesini önler
    logger.info(this.logPrefix, 'Started - listening for new MediaRecorder instances only');
  }

  /**
   * Stop collector
   * @returns {Promise<void>}
   */
  async stop() {
    this.active = false;

    // Handler remains registered (initialized in initialize())
    // When the collector is globally stopped, remove all listeners from all active recorders
    this.activeRecorders.forEach((_meta, recorder) => {
      this._removeAllListeners(recorder);
    });
    this.activeRecorders.clear();

    // Clear registry to prevent stale data on next start
    clearRegistryKey('mediaRecorders');

    logger.info(this.logPrefix, `Stopped`);
  }
}

export default MediaRecorderCollector;
