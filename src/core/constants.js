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
  MEDIA_RECORDER: 'mediaRecorder',
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
