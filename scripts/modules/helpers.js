/**
 * helpers.js - Shared helper functions for popup modules
 *
 * DRY: Common utilities used by both encoder-ui.js and renderers.js
 */

// ═══════════════════════════════════════════════════════════════════════════════
// STRING FORMATTING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * XSS protection - Escape HTML special characters
 * @param {string} text - Input text
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format timestamp for display
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Formatted time string (HH:MM:SS)
 */
export function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Format worklet processor name for display
 * Removes common suffixes: -processor, -encoder, -worklet
 * @param {string} name - Raw processor name (e.g., 'passthrough-processor')
 * @returns {string} Formatted name (e.g., 'passthrough')
 */
export function formatWorkletName(name) {
  if (!name) return '';
  return name
    .replace(/-processor$/, '')
    .replace(/-encoder$/, '')
    .replace(/-worklet$/, '');
}

/**
 * Capitalize first letter of a string
 * @param {string} str - Input string
 * @returns {string} Capitalized string
 */
export function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Extract codec name from mime type or codec string
 * Handles formats like 'audio/opus', 'opus', 'audio/webm;codecs=opus'
 * @param {string} codecString - Codec or mime type string
 * @returns {string} Extracted codec name or '-' if invalid
 */
export function extractCodecName(codecString) {
  if (!codecString) return '-';
  // Handle 'audio/opus' → 'opus'
  const parts = codecString.split('/');
  return parts[1] || parts[0] || '-';
}

/**
 * Normalize mime type for comparison
 * Extracts base mime type without parameters (e.g., 'audio/webm;codecs=opus' → 'audio/webm')
 * @param {string} mimeType - Full mime type string
 * @returns {string} Normalized base mime type in lowercase
 */
export function normalizeMimeType(mimeType) {
  if (typeof mimeType !== 'string') return '';
  return mimeType.split(';')[0].trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO SPEC FORMATTING (DRY: Industry-standard formats)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format bit depth for display (industry standard: hyphenated)
 * @param {number|string} value - Bit depth value (e.g., 16, 24, 32)
 * @returns {string} Formatted bit depth (e.g., "16-bit") or "-" if invalid
 */
export function formatBitDepth(value) {
  if (value === null || value === undefined || value === '') return '-';
  return `${value}-bit`;
}

/**
 * Format channel count for display (industry standard: compact)
 * @param {number|string} value - Channel count (e.g., 1, 2, 6)
 * @returns {string} Formatted channels (e.g., "2ch") or "-" if invalid
 */
export function formatChannels(value) {
  if (value === null || value === undefined || value === '') return '-';
  return `${value}ch`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUALITY METRICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format jitter (seconds to ms)
 * @param {number} jitterSec - Jitter in seconds
 * @returns {string} Formatted jitter string
 */
export function formatJitter(jitterSec) {
  if (!jitterSec) return 'N/A';
  return `${(jitterSec * 1000).toFixed(2)} ms`;
}

/**
 * Get quality class based on metric value
 * @param {string} metric - Metric type ('jitter', 'packetLoss', 'rtt')
 * @param {number} value - Metric value
 * @returns {string} CSS class ('good', 'warning', 'error', or '')
 */
export function getQualityClass(metric, value) {
  if (metric === 'jitter') {
    if (value < 0.03) return 'good';     // < 30ms
    if (value < 0.1) return 'warning';   // < 100ms
    return 'error';
  }
  if (metric === 'packetLoss') {
    if (value < 1) return 'good';        // < 1%
    if (value < 5) return 'warning';     // < 5%
    return 'error';
  }
  if (metric === 'rtt') {
    if (value < 0.15) return 'good';     // < 150ms
    if (value < 0.3) return 'warning';   // < 300ms
    return 'error';
  }
  return '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOLTIP BUILDER (DRY: Centralized tooltip HTML generation)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create tooltip HTML span (DRY: eliminates repetitive tooltip markup)
 * @param {string} text - Display text (will be escaped for XSS protection)
 * @param {string} tooltip - Tooltip content (will be escaped for XSS protection)
 * @param {string} [position='right'] - Tooltip position: 'left' | 'right'
 * @param {boolean} [isInfoIcon=false] - Use info icon style (has-tooltip--info)
 * @returns {string} HTML span with tooltip
 *
 * @example
 * // Basic tooltip
 * createTooltip('🌐 WebRTC Native', 'Browser WebRTC encoder')
 * // → '<span class="has-tooltip tooltip-right" data-tooltip="Browser WebRTC encoder">🌐 WebRTC Native</span>'
 *
 * @example
 * // Info icon tooltip (left positioned)
 * createTooltip('ⓘ', 'This tab is recording audio', 'left', true)
 * // → '<span class="has-tooltip has-tooltip--info tooltip-left" data-tooltip="This tab is recording audio">ⓘ</span>'
 */
export function createTooltip(text, tooltip, position = 'right', isInfoIcon = false) {
  const classes = isInfoIcon
    ? `has-tooltip has-tooltip--info tooltip-${position}`
    : `has-tooltip tooltip-${position}`;

  // Security: Escape both text and tooltip to prevent XSS
  const safeText = escapeHtml(text);
  const safeTooltip = escapeHtml(tooltip);

  return `<span class="${classes}" data-tooltip="${safeTooltip}">${safeText}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOG HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Debug flag - enable via localStorage.setItem('audioInspector_debug', 'true')
 */
const DEBUG = typeof localStorage !== 'undefined' &&
  localStorage.getItem('audioInspector_debug') === 'true';

/**
 * Conditional debug logger
 * Only logs when DEBUG is enabled (localStorage.audioInspector_debug === 'true')
 * @param {...any} args - Arguments to log
 */
export function debugLog(...args) {
  if (DEBUG) {
    console.log('[AudioInspector]', ...args);
  }
}

/**
 * Determine log line color class based on message content
 * @param {string} message - Log message
 * @param {string} level - Log level ('info', 'warn', 'error')
 * @returns {string} CSS class
 */
export function getLogColorClass(message, level) {
  // Priority 1: Level-based errors/warnings from logger
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';

  const msgLower = message.toLowerCase();

  // Priority 2: Explicit errors (highest priority after level)
  if (msgLower.includes('error') ||
      msgLower.includes('failed') ||
      msgLower.includes('❌')) {
    return 'error';
  }

  // Priority 3: Success states (green) - completed actions
  if (msgLower.includes('✅') ||
      msgLower.includes('started') ||
      msgLower.includes('ready') ||
      msgLower.includes('success') ||
      msgLower.includes('loaded')) {
    return 'success';
  }

  // Priority 4: Info states (blue) - ongoing/initialization
  if (msgLower.includes('initializ') ||
      msgLower.includes('starting')) {
    return 'info';
  }

  // Priority 5: Warning states (orange)
  if (msgLower.includes('waiting') ||
      msgLower.includes('warning') ||
      msgLower.includes('⚠️')) {
    return 'warn';
  }

  // Default: no special class
  return '';
}
