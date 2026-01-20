// @ts-check

import { logger } from '../core/Logger.js';
import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES, streamRegistry } from '../core/constants.js';
import { hookAsyncMethod } from '../core/utils/ApiHook.js';

/**
 * Collects getUserMedia stats (microphone constraints, settings, capabilities).
 * Hooks into navigator.mediaDevices.getUserMedia.
 */
class GetUserMediaCollector extends BaseCollector {
  constructor(options = {}) {
    super('get-user-media', options);

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

    // Register global handler for early hook communication
    this.registerGlobalHandler('__getUserMediaCollectorHandler', (stream, args) => {
      const constraints = args[0];
      if (constraints?.audio) {
        this._processStream(stream, constraints).catch(err => {
          logger.error(this.logPrefix, `Error processing stream:`, err);
        });
      }
    });

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
          voiceIsolation: settings.voiceIsolation,

          // Device info
          deviceId: settings.deviceId,
          groupId: settings.groupId,
          label: audioTrack.label
        },
        capabilities: capabilities
      };

      // Stream'i mikrofon registry'sine kaydet (AudioContextCollector tarafından sorgulanacak)
      streamRegistry.microphone.add(stream.id);

      // Track ended olduğunda registry'den temizle (memory leak önleme)
      audioTrack.addEventListener('ended', () => {
        streamRegistry.microphone.delete(stream.id);
        this.activeStreams.delete(stream.id);
        logger.info(this.logPrefix, `Audio track ended, stream ${stream.id} removed from registry`);
      });

      this.activeStreams.set(stream.id, metadata);
      this.emit(EVENTS.DATA, metadata);

      logger.info(this.logPrefix, `Audio track detected (stream ${stream.id} registered as microphone):`, metadata);
    }
  }

  /**
   * Start collector (passive)
   * @returns {Promise<void>}
   */
  async start() {
    this.active = true;

    // Process early captures from early-inject.js
    // These are getUserMedia calls that happened before page.js loaded
    // @ts-ignore
    const earlyCaptures = window.__earlyCaptures?.getUserMedia;
    if (earlyCaptures?.length) {
      logger.info(this.logPrefix, `📥 Processing ${earlyCaptures.length} early getUserMedia capture(s)`);

      for (const capture of earlyCaptures) {
        // Skip if already processed (stream already in activeStreams)
        if (this.activeStreams.has(capture.stream.id)) continue;

        // Skip if stream is no longer active (ended)
        const audioTrack = capture.stream.getAudioTracks()[0];
        if (!audioTrack || audioTrack.readyState !== 'live') {
          logger.info(this.logPrefix, `Skipping ended stream ${capture.stream.id}`);
          continue;
        }

        try {
          await this._processStream(capture.stream, capture.constraints);
        } catch (err) {
          logger.error(this.logPrefix, `Error processing early capture:`, err);
        }
      }

      // NOT: earlyCaptures'ı silmiyoruz - inspector tekrar başlatıldığında
      // hala aktif stream'leri tekrar işleyebilmek için tutuyoruz
    }

    // Mevcut activeStreams'deki verileri emit et
    // Bu, inspector aktif değilken yakalanan stream'lerin UI'da görünmesini sağlar
    // (hook tetiklendi ama emit() o zaman inactive olduğu için çalışmadı)
    if (this.activeStreams.size > 0) {
      logger.info(this.logPrefix, `📤 Emitting ${this.activeStreams.size} existing stream(s)`);
      this.reEmit();
    }

    logger.info(this.logPrefix, `Started`);
  }

  /**
   * Re-emit current data from active streams
   * Called when UI needs to be refreshed (e.g., after data reset)
   */
  reEmit() {
    if (!this.active) return;

    let emittedCount = 0;
    for (const [streamId, metadata] of this.activeStreams.entries()) {
      this.emit(EVENTS.DATA, metadata);
      emittedCount++;
    }

    if (emittedCount > 0) {
      logger.info(this.logPrefix, `Re-emitted ${emittedCount} stream(s)`);
    }
  }

  /**
   * Stop collector and cleanup
   *
   * NOT: Bu collector RTCPeerConnectionCollector ve MediaRecorderCollector'dan
   * farklı davranır - activeStreams temizlenMEZ. Nedeni:
   * - getUserMedia stream'leri uzun ömürlüdür (kayıt boyunca aktif kalır)
   * - Inspector restart'ta hala aktif stream'ler reEmit edilebilmeli
   * - "Kayıt başlat → Inspector başlat" senaryosu desteklenmeli
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.active = false;
    // We don't restore getUserMedia because other extensions might have hooked it too,
    // and restoring it might break them or the chain.

    // activeStreams'i temizlemiyoruz - inspector tekrar başlatıldığında
    // hala aktif stream'leri tekrar emit edebilmek için tutuyoruz
    // Sadece ended olan stream'leri temizleyelim
    for (const [streamId, metadata] of this.activeStreams.entries()) {
      // Stream referansını early captures'dan bul
      // @ts-ignore
      const capture = window.__earlyCaptures?.getUserMedia?.find(c => c.stream.id === streamId);
      if (capture) {
        const audioTrack = capture.stream.getAudioTracks()[0];
        if (!audioTrack || audioTrack.readyState !== 'live') {
          this.activeStreams.delete(streamId);
          streamRegistry.microphone.delete(streamId);
        }
      }
    }

    logger.info(this.logPrefix, `Stopped`);
  }
}

export default GetUserMediaCollector;
