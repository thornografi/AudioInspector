// @ts-check
/**
 * encoder-patterns.js - Encoder detection pattern priority and utilities
 *
 * PATTERN PRIORITY: Prevent lower-priority patterns from overwriting better ones
 * Example: Blob detection (post-hoc) should not overwrite Worker detection (real-time)
 *
 * Higher number = higher priority (better detection source)
 */

/**
 * Pattern priority for encoder detection
 * Used to prevent lower-quality detections from overwriting better ones
 *
 * ⚠️ SYNC: Keys must match scripts/modules/encoder-ui.js → DETECTION_LABELS
 *    When adding new patterns: Update both PATTERN_PRIORITY and DETECTION_LABELS
 *
 * @type {Object<string, number>}
 */
export const PATTERN_PRIORITY = {
  'audioworklet-config': 5,  // Full AudioWorklet config (highest priority)
  'audioworklet-init': 4,    // AudioWorklet initialization
  'audioworklet-deferred': 4, // Deferred AudioWorklet matching
  'direct': 4,               // Worker hook with explicit encoder fields
  'nested': 4,               // Nested encoder config
  'worker-init': 3,          // Worker init message
  'worker-audio-init': 3,    // Worker audio init pattern
  'audio-blob': 2,           // Blob creation (post-hoc, confirms format)
  'unknown': 1               // Unknown pattern (lowest priority)
};

/**
 * Opus application names mapping (internal)
 * 2048 = OPUS_APPLICATION_VOIP
 * 2049 = OPUS_APPLICATION_AUDIO
 * 2051 = OPUS_APPLICATION_LOWDELAY
 */
const OPUS_APPLICATION_NAMES = {
  2048: 'VoIP',
  2049: 'Audio',
  2051: 'LowDelay'
};

/**
 * Get human-readable Opus application name
 * @param {number|string} application - Opus application code
 * @param {string} [fallbackName] - Optional fallback name
 * @returns {string|null} Application name
 */
export const getOpusApplicationName = (application, fallbackName = null) => {
  if (typeof application === 'string') {
    return application;
  }
  return OPUS_APPLICATION_NAMES[application] || fallbackName || null;
};
