// @ts-check

/**
 * Event names for collector/reporter communication
 */
export const EVENTS = {
  DATA: 'data',
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
  AUDIO_CONNECTION: 'audioConnection',
  PLATFORM_DETECTED: 'platform_detected'
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
 * Storage keys for collected measurement data
 * Used for cleanup operations (tab close, browser restart, origin change, etc.)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ SINGLE SOURCE OF TRUTH - ALL INLINE COPIES MUST MATCH THIS          ║
 * ║                                                                      ║
 * ║ Files with inline copies (cannot import ES modules):                 ║
 * ║ - scripts/background.js:6   → DATA_STORAGE_KEYS                      ║
 * ║ - scripts/popup.js:17       → DATA_STORAGE_KEYS                      ║
 * ║ - scripts/content.js:82     → DATA_STORAGE_KEYS                      ║
 * ║                                                                      ║
 * ║ When adding/removing keys:                                           ║
 * ║ 1. Update this array first                                          ║
 * ║ 2. Update all 3 inline copies with EXACT same values                 ║
 * ║ 3. Verify clearInspectorData() in each file uses spread operator    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
export const DATA_STORAGE_KEYS = [
  'rtc_stats',
  'user_media',
  'audio_contexts',
  'audio_worklet',
  'media_recorder',
  'wasm_encoder',
  'audio_connections'
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

/**
 * Keywords that indicate encoder/audio-related Workers and AudioWorklets
 * Used for WASM encoder detection in Worker URLs and processor names
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ SINGLE SOURCE OF TRUTH - SYNC REQUIRED                              ║
 * ║                                                                      ║
 * ║ Files with inline copies (cannot import ES modules):                 ║
 * ║ - scripts/early-inject.js:490 → ENCODER_KEYWORDS                     ║
 * ║                                                                      ║
 * ║ When adding keywords: Update both locations!                         ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
export const ENCODER_KEYWORDS = [
  'encoder', 'opus', 'ogg', 'mp3', 'aac', 'vorbis', 'flac',
  'lame', 'audio', 'media', 'wasm', 'codec', 'voice', 'recorder'
];
