// @ts-check

import BaseDetector from './BaseDetector.js';

/**
 * Helper for simple regex/string matching detectors
 */
class RegexDetector extends BaseDetector {
  /**
   * @param {string} name - Internal name
   * @param {string} displayName - Human readable name
   * @param {string[]} matchers - Strings to check in hostname
   * @param {number} priority
   */
  constructor(name, displayName, matchers, priority = 10) {
    super(name, priority);
    this.displayName = displayName;
    this.matchers = matchers;
  }

  detect() {
    const hostname = window.location.hostname.toLowerCase();
    return this.matchers.some(m => {
      // Tam eşleşme veya alt domain eşleşmesi kontrolü (örn: web.whatsapp.com)
      return hostname === m || hostname.endsWith('.' + m);
    });
  }

  getMetadata() {
    return {
      platform: this.displayName,
      url: window.location.href
    };
  }
}

export default RegexDetector;
