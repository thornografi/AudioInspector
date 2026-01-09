// @ts-check

import { logger } from '../core/Logger.js';
import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES } from '../core/constants.js';
import { hookAsyncMethod } from '../core/utils/ApiHook.js';

/**
 * Collects getUserMedia stats (microphone constraints, settings, capabilities).
 * Hooks into navigator.mediaDevices.getUserMedia.
 */
class GetUserMediaCollector extends BaseCollector {
  constructor(options = {}) {
    super('get-user-media', options);

    /** @type {Function|null} */
    this.originalGetUserMedia = null;

    /** @type {Map<string, Object>} */
    this.activeStreams = new Map();
  }

  /**
   * Initialize collector - hook getUserMedia
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!navigator.mediaDevices) {
      logger.warn(this.logPrefix, `navigator.mediaDevices not available`);
      return;
    }

    this.originalGetUserMedia = hookAsyncMethod(
      navigator.mediaDevices,
      'getUserMedia',
      (/** @type {any} */ stream, /** @type {any} */ args) => {
        // Only process if audio is requested
        const constraints = args[0];
        if (constraints?.audio) {
             this._processStream(stream, constraints).catch(err => {
                 logger.error(this.logPrefix, `Error processing stream:`, err);
             });
        }
      },
      () => true  // Always hook, emit() will check active flag
    );
  }

  /**
   * Process the stream and extract audio metadata
   * @param {MediaStream} stream
   * @param {MediaStreamConstraints} constraints
   */
  async _processStream(stream, constraints) {
    const audioTrack = stream.getAudioTracks()[0];

    if (audioTrack) {
      const settings = audioTrack.getSettings();
      const capabilities = audioTrack.getCapabilities ? audioTrack.getCapabilities() : {};

      const metadata = {
        type: DATA_TYPES.USER_MEDIA,
        timestamp: Date.now(),
        // Platform will be added by a separate detector or enriched later?
        // For now, collectors just collect raw data.
        requested: constraints.audio,
        settings: {
          // Core audio properties
          sampleRate: settings.sampleRate,
          sampleSize: settings.sampleSize,
          channelCount: settings.channelCount,
          latency: /** @type {any} */ (settings).latency,

          // Enhancements
          echoCancellation: settings.echoCancellation,
          autoGainControl: settings.autoGainControl,
          noiseSuppression: settings.noiseSuppression,

          // Device info
          deviceId: settings.deviceId,
          groupId: settings.groupId,
          label: audioTrack.label
        },
        capabilities: capabilities
      };

      this.activeStreams.set(stream.id, metadata);
      this.emit(EVENTS.DATA, metadata);

      logger.info(this.logPrefix, `Audio track detected:`, metadata);
    }
  }

  /**
   * Start collector (passive)
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;
    logger.info(this.logPrefix, `Started`);
  }

  /**
   * Stop collector and cleanup
   * @returns {Promise<void>}
   */
  async stop() {
    this.active = false;
    // We don't restore getUserMedia because other extensions might have hooked it too,
    // and restoring it might break them or the chain.
    // Ideally, we should, but for this "forever running" page script, it's usually fine.
    // If we strictly want to be clean:
    /*
    if (this.originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = this.originalGetUserMedia;
    }
    */
    this.activeStreams.clear();
    logger.info(this.logPrefix, `Stopped`);
  }
}

export default GetUserMediaCollector;
