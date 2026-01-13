// @ts-check

import { logger } from '../../core/Logger.js';
import { LOG_PREFIX } from '../constants.js';

/**
 * Hooks a constructor function on a target object.
 * 
 * @param {Object} target - The object containing the constructor (e.g., window)
 * @param {string} property - The name of the property to hook (e.g., 'RTCPeerConnection')
 * @param {Function} onInstance - Callback invoked with (instance, args) when a new instance is created
 * @param {Function} [shouldHook] - Optional predicate that returns true if the hook logic should run
 * @returns {Function|null} The original constructor, or null if target/property didn't exist
 */
export function hookConstructor(target, property, onInstance, shouldHook = () => true) {
  const Original = /** @type {any} */ (target)[property];
  if (!Original) return null;

  const handler = {
    // @ts-ignore
    construct(target, args, newTarget) {
      const shouldProcess = shouldHook();

      // Only log when inspector is active (prevents log spam when disabled)
      if (shouldProcess) {
        logger.info(LOG_PREFIX.INSPECTOR, `📡 Constructor called: ${property}`);
      }

      if (!shouldProcess) {
        return Reflect.construct(target, args, newTarget);
      }

      try {
        const instance = Reflect.construct(target, args, newTarget);
        try {
            onInstance(instance, args);
        } catch (err) {
            logger.error(LOG_PREFIX.INSPECTOR, `Error in ${property} hook listener:`, err);
        }
        return instance;
      } catch (err) {
        // If constructor fails, propagate error
        throw err;
      }
    }
  };

  try {
    const ProxyConstructor = new Proxy(Original, handler);
    // @ts-ignore
    target[property] = ProxyConstructor;
  } catch (e) {
    logger.error(LOG_PREFIX.INSPECTOR, `Failed to assign proxy hook to ${property}:`, e);
    return null;
  }

  return Original;
}

/**
 * Hooks an async method (returning a Promise) on a target object.
 *
 * @param {Object} target - The object containing the method (e.g., navigator.mediaDevices)
 * @param {string} property - The name of the method (e.g., 'getUserMedia')
 * @param {Function} onResult - Callback invoked with (result, args, thisArg) after the promise resolves
 * @param {Function} [shouldHook] - Optional predicate that returns true if the hook logic should run
 * @returns {Function|null} The original method, or null if target/property didn't exist
 */
export function hookAsyncMethod(target, property, onResult, shouldHook = () => true) {
  // @ts-ignore
  if (!target || !target[property]) return null;

  // @ts-ignore
  const original = target[property];

  // Do NOT bind 'this' here. We need to respect the 'this' context at the call site,
  // especially for prototype methods (like AudioWorklet.prototype.addModule).
  // For singleton objects (like navigator.mediaDevices), 'this' will naturally be the singleton.

  // @ts-ignore
  target[property] = async function(/** @type {any[]} */ ...args) {
    if (!shouldHook()) {
      return original.apply(this, args);
    }

    const result = await original.apply(this, args);
    try {
      // Pass 'this' context to handler for proper context identification
      await onResult(result, args, this);
    } catch (err) {
      logger.error(LOG_PREFIX.INSPECTOR, `Error in ${property} hook:`, err);
    }
    return result;
  };

  return original;
}

/**
 * Hooks a synchronous method on a target object.
 *
 * @param {Object} target - The object containing the method (e.g., AudioContext.prototype)
 * @param {string} property - The name of the method (e.g., 'createScriptProcessor')
 * @param {Function} onCall - Callback invoked with (result, args, thisArg) after the method returns
 * @param {Function} [shouldHook] - Optional predicate that returns true if the hook logic should run
 * @returns {Function|null} The original method, or null if target/property didn't exist
 */
export function hookMethod(target, property, onCall, shouldHook = () => true) {
  // @ts-ignore
  if (!target || !target[property]) return null;

  // @ts-ignore
  const original = target[property];

  // @ts-ignore
  target[property] = function(/** @type {any[]} */ ...args) {
    if (!shouldHook()) {
      return original.apply(this, args);
    }

    const result = original.apply(this, args);
    try {
      // Pass 'this' context to handler for proper context identification
      onCall(result, args, this);
    } catch (err) {
      logger.error(LOG_PREFIX.INSPECTOR, `Error in ${property} hook:`, err);
    }
    return result;
  };

  return original;
}
