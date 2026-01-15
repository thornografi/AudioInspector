// @ts-check

/**
 * Event names for collector/reporter communication
 */
export const EVENTS = {
  DATA: 'data',
  ERROR: 'error',
  CONNECTION_CREATED: 'connection-created',
  CONNECTION_CLOSED: 'connection-closed'
};

/**
 * Data payload types
 */
export const DATA_TYPES = {
  RTC_STATS: 'rtc_stats',
  USER_MEDIA: 'userMedia',
  AUDIO_CONTEXT: 'audioContext',
  AUDIO_WORKLET: 'audioWorklet',
  MEDIA_RECORDER: 'mediaRecorder',
  WASM_ENCODER: 'wasmEncoder',
  PLATFORM_DETECTED: 'platform_detected'
};

/**
 * Default metadata values
 */
export const DEFAULT_METADATA = {
  DESCRIPTION: '',
  VERSION: '1.0.0',
  TAGS: []
};

/**
 * Log prefixes for consistent logging
 */
export const LOG_PREFIX = {
  COLLECTOR: (name) => `[${name}]`,
  INSPECTOR: '[PageInspector]'
};

/**
 * Window message marker for extension communication
 */
export const MESSAGE_MARKER = '__audioPipelineInspector';

/**
 * Window flag for install check
 */
export const INSTALL_FLAG = '__audioPipelineInspectorInstalled';

/**
 * Default poll interval for RTC stats collectors
 */
export const RTC_STATS_POLL_INTERVAL_MS = 1000;

/**
 * AudioContext destination types
 */
export const DESTINATION_TYPES = {
  SPEAKERS: 'speakers',
  MEDIA_STREAM: 'MediaStreamDestination'
};

/**
 * UI display limits
 */
export const UI_LIMITS = {
  MAX_AUDIO_CONTEXTS: 4
};

/**
 * Storage keys for collected measurement data
 * Used for cleanup operations (tab close, browser restart, origin change, etc.)
 *
 * IMPORTANT: This is the single source of truth.
 * The following files have inline copies that MUST be kept in sync:
 * - scripts/background.js (cannot import ES modules)
 * - scripts/popup.js (cannot import ES modules)
 * - scripts/content.js (cannot import ES modules)
 */
export const DATA_STORAGE_KEYS = [
  'rtc_stats',
  'user_media',
  'audio_contexts',
  'audio_worklet',
  'media_recorder',
  'wasm_encoder'
];

/**
 * Stream source registry
 * GetUserMediaCollector ve RTCPeerConnectionCollector tarafından doldurulur
 * AudioContextCollector tarafından sorgulanır
 *
 * Amaç: createMediaStreamSource() çağrıldığında stream'in
 * mikrofon mu (giden ses) yoksa remote mu (gelen ses) olduğunu ayırt etmek
 */
export const streamRegistry = {
  /** @type {Set<string>} getUserMedia stream ID'leri (mikrofon) */
  microphone: new Set(),
  /** @type {Set<string>} RTCPeerConnection remote stream ID'leri */
  remote: new Set()
};
