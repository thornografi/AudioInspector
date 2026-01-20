// @ts-check

import { logger } from '../../core/Logger.js';
import { LOG_PREFIX } from '../constants.js';

// NOTE: Constructor hooks are handled by EarlyHook.js (createConstructorHook factory)
// This file only contains method-level hooks (hookAsyncMethod, hookMethod)

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
  if (!target) return null;

  // @ts-ignore
  const original = target[property];
  if (typeof original !== 'function') return null;

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
  if (!target) return null;

  // @ts-ignore
  const original = target[property];
  if (typeof original !== 'function') return null;

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
