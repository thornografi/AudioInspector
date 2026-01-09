// @ts-check

/**
 * @abstract
 * Base class for platform/environment detection.
 * Detectors identify which platform/service the extension is running on.
 *
 * @example
 * class TeamsDetector extends BaseDetector {
 *   constructor() {
 *     super('microsoft-teams', 100); // priority 100
 *   }
 *
 *   detect() {
 *     return window.location.hostname.includes('teams.microsoft.com');
 *   }
 *
 *   getMetadata() {
 *     return { name: 'Microsoft Teams', vendor: 'Microsoft' };
 *   }
 * }
 */
class BaseDetector {
  /**
   * @param {string} name - Unique detector name
   * @param {number} [priority=0] - Detection priority (higher = checked first)
   */
  constructor(name, priority = 0) {
    if (new.target === BaseDetector) {
      throw new Error('BaseDetector is abstract and cannot be instantiated directly');
    }

    /** @type {string} */
    this.name = name;

    /** @type {number} */
    this.priority = priority;
  }

  /**
   * Check if this detector matches current environment
   * @abstract
   * @returns {boolean}
   */
  detect() {
    throw new Error('detect() must be implemented by subclass');
  }

  /**
   * Get platform metadata
   * @abstract
   * @returns {Object} Platform metadata (name, version, features, etc.)
   */
  getMetadata() {
    throw new Error('getMetadata() must be implemented by subclass');
  }
}

export default BaseDetector;
