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
      
      // Cap events array to prevent memory/storage overflow (FIFO - oldest removed first)
      if (metadata.events.length >= 50) {
        metadata.events.shift();
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
   * Analyze MediaStream tracks to determine source type
   * @private
   * @param {MediaStream} stream
   * @returns {{hasAudio: boolean, hasVideo: boolean, audioSource: string, trackInfo: Array}}
   */
  _analyzeStreamTracks(stream) {
      const result = {
        hasAudio: false,
        hasVideo: false,
        audioSource: 'none', // 'microphone', 'system', 'synthesized', 'unknown'
        trackInfo: []
      };

      if (!stream || typeof stream.getTracks !== 'function') {
        return result;
      }

      const tracks = stream.getTracks();
      for (const track of tracks) {
        const info = {
          kind: track.kind,
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState
        };

        if (track.kind === 'audio') {
          result.hasAudio = true;
          // Determine audio source from label
          const label = (track.label || '').toLowerCase();
          if (label.includes('microphone') || label.includes('mic') || label.includes('input')) {
            result.audioSource = 'microphone';
          } else if (label.includes('system') || label.includes('loopback') || label.includes('stereo mix')) {
            result.audioSource = 'system';
          } else if (label === '' || label.includes('mediastreamdestination')) {
            // Empty label often means synthesized (from AudioContext)
            result.audioSource = 'synthesized';
          } else {
            result.audioSource = 'unknown';
          }
        } else if (track.kind === 'video') {
          result.hasVideo = true;
        }

        result.trackInfo.push(info);
      }

      return result;
  }

  /**
   * Handle new MediaRecorder instance
   * @private
   * @param {any} recorder
   * @param {any[]} args
   */
  _handleNewRecorder(recorder, args) {
      logger.info(this.logPrefix, `_handleNewRecorder called for new MediaRecorder instance.`);
      const stream = args[0]; // Constructor signature: (stream, options)
      const options = args[1] || {};

      // Analyze stream tracks to determine source
      const trackAnalysis = this._analyzeStreamTracks(stream);

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
        // NEW: Track analysis to prevent false positives
        hasAudioTrack: trackAnalysis.hasAudio,
        hasVideoTrack: trackAnalysis.hasVideo,
        audioSource: trackAnalysis.audioSource, // 'microphone', 'system', 'synthesized', 'unknown', 'none'
        trackInfo: trackAnalysis.trackInfo,
        events: []
      };

      this.activeRecorders.set(recorder, metadata);

      // Emit immediately (emit() checks this.active internally)
      this.emit(EVENTS.DATA, metadata);
      logger.info(this.logPrefix, `MediaRecorder created:`, JSON.stringify(metadata));

      // Attach event listeners to track recorder lifecycle
      const eventTypes = ['start', 'stop', 'pause', 'resume', 'dataavailable', 'error'];
      eventTypes.forEach(eventType => {
        this._createRecorderEventListener(recorder, eventType, eventType, metadata);
      });
      logger.info(this.logPrefix, `Attached ${eventTypes.length} event listeners to MediaRecorder`);
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
