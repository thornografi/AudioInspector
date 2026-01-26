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
      logger.error(this.logPrefix, `window.MediaRecorder is not available. MediaRecorderCollector cannot function.`);
      return;
    }

    // Register global handler for early hook communication
    this.registerGlobalHandler('__mediaRecorderCollectorHandler', (recorder, args) => {
      logger.info(this.logPrefix, 'MediaRecorder constructor called via hook');
      this._handleNewRecorder(recorder, args);
    });
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
      // dataavailable = sadece data chunk, teşhis değeri yok, UI kullanmıyor
      if (eventType === 'dataavailable') {
        return;
      }

      metadata.state = recorder.state; // State might change on event
      const eventData = { name: eventName, timestamp: Date.now() };

      if (eventType === 'error' && event.error) {
        Object.assign(eventData, { message: event.error.message });
      }

      // Cap events array to prevent memory/storage overflow (FIFO - oldest removed first)
      if (metadata.events.length >= 50) {
        metadata.events.shift();
      }
      metadata.events.push(eventData);

      this.emit(EVENTS.DATA, metadata);  // Emit metadata directly

      // Sadece önemli event'leri logla (start, stop, pause, resume, error)
      if (eventType === 'error') {
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
          if (label.includes('microphone') || label.includes('mic') || label.includes('input') ||
              label.includes('analogue') || label.includes('analog') || label.includes('line in') ||
              label.includes('usb audio') || label.includes('focusrite') || label.includes('scarlett') ||
              label.includes('audio interface') || label.includes('external')) {
            // Physical audio input device (microphone, audio interface, etc.)
            result.audioSource = 'microphone';
          } else if (label.includes('system') || label.includes('loopback') || label.includes('stereo mix') ||
                     label.includes('what u hear') || label.includes('wasapi')) {
            result.audioSource = 'system';
          } else if (label === '' || label.includes('mediastreamdestination') || label.includes('destinationnode')) {
            // Empty label or MediaStreamAudioDestinationNode = synthesized (from AudioContext)
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
   * Get source audio track settings (sampleSize, sampleRate, channelCount)
   * @private
   * @param {MediaStream} stream
   * @returns {{sampleSize: number|undefined, sampleRate: number|undefined, channelCount: number|undefined}|null}
   */
  _getSourceAudioInfo(stream) {
    const audioTrack = stream?.getAudioTracks?.()?.[0];
    if (!audioTrack) return null;
    const settings = audioTrack.getSettings();
    return {
      sampleSize: settings.sampleSize,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount
    };
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

      // DEBUG: Log track analysis details
      logger.info(this.logPrefix, `🔍 Track Analysis: hasAudio=${trackAnalysis.hasAudio}, hasVideo=${trackAnalysis.hasVideo}, audioSource=${trackAnalysis.audioSource}`);
      if (trackAnalysis.trackInfo?.length > 0) {
        trackAnalysis.trackInfo.forEach((t, i) => {
          logger.info(this.logPrefix, `🔍 Track[${i}]: kind=${t.kind}, label="${t.label}", enabled=${t.enabled}, muted=${t.muted}, readyState=${t.readyState}`);
        });
      }

      // Get source audio track settings (bit depth, sample rate, channel count)
      const sourceAudio = this._getSourceAudioInfo(stream);

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
        // Source audio track settings (bit depth, sample rate, channel count)
        sourceAudio: sourceAudio,
        events: []
      };

      this.activeRecorders.set(recorder, metadata);

      // Emit immediately (emit() checks this.active internally)
      this.emit(EVENTS.DATA, metadata);

      // DEBUG: Log full metadata for debugging
      logger.info(this.logPrefix, `MediaRecorder created - mimeType=${metadata.mimeType}, audioSource=${metadata.audioSource}, hasAudioTrack=${metadata.hasAudioTrack}`);
      logger.info(this.logPrefix, `MediaRecorder metadata: ${JSON.stringify(metadata, null, 0)}`);

      // Attach event listeners to track recorder lifecycle
      const eventTypes = ['start', 'stop', 'pause', 'resume', 'dataavailable', 'error'];
      eventTypes.forEach(eventType => {
        this._createRecorderEventListener(recorder, eventType, eventType, metadata);
      });
      logger.info(this.logPrefix, `Attached ${eventTypes.length} event listeners to MediaRecorder`);
  }

  /**
   * Hook: Process early captures (MediaRecorders created before inspector started)
   * This handles cases like veed.io where recording starts before user
   * clicks "Start" in the extension
   * @protected
   * @override
   * @returns {Promise<number>} Number of processed recorders
   */
  async _processEarlyInstances() {
    let processedCount = 0;

    // 1. Check early-inject.js captures first (MAIN world content script)
    // @ts-ignore
    const earlyCaptures = window.__earlyCaptures?.mediaRecorders;
    if (earlyCaptures?.length) {
      logger.info(this.logPrefix, `📥 Processing ${earlyCaptures.length} early MediaRecorder capture(s)`);
      for (const capture of earlyCaptures) {
        // Skip if already processed
        if (!this.activeRecorders.has(capture.instance)) {
          this._handleNewRecorder(capture.instance, [capture.stream, capture.options || {}]);
          processedCount++;
        }
      }
    }

    // 2. Check EarlyHook.js registry (fallback)
    const registry = getInstanceRegistry();
    if (registry.mediaRecorders?.length) {
      for (const entry of registry.mediaRecorders) {
        // Skip if already processed from earlyCaptures
        if (!this.activeRecorders.has(entry.instance)) {
          // Registry doesn't have stream/options, try to get from recorder
          const stream = entry.instance.stream;
          this._handleNewRecorder(entry.instance, [stream, {}]);
          processedCount++;
        }
      }
    }

    return processedCount;
  }

  /**
   * Hook: Re-emit active recorders
   * @protected
   * @override
   * @returns {number} Number of recorders emitted
   */
  _reEmitActiveItems() {
    let emittedCount = 0;
    for (const [recorder, metadata] of this.activeRecorders.entries()) {
      // Skip inactive recorders (already stopped)
      if (recorder.state === 'inactive') continue;

      // Update state before emit
      metadata.state = recorder.state;
      this.emit(EVENTS.DATA, metadata);
      emittedCount++;
    }
    return emittedCount;
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
