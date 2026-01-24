// @ts-check
/**
 * processor-handlers.js - OCP-based processor handler factory and registry
 *
 * This module provides the sync handlers for AudioContext method calls.
 * Extracted from AudioContextCollector.js for better modularity.
 *
 * DRY: All DSP nodes use the same factory pattern - add new nodes with single line.
 * OCP: Add new handlers without modifying the sync loop.
 */

import { DESTINATION_TYPES } from '../../core/constants.js';

/**
 * Factory: Creates a processor handler with duplicate check
 * DRY: All DSP nodes use this pattern - add new nodes with single line
 * @param {string} type - Processor type name
 * @param {Object<string, any>} [fieldMap] - Maps data fields to entry fields with defaults: { fieldName: 'defaultValue' }
 * @returns {function(Object, Object): void} Handler function
 */
export const createProcessorHandler = (type, fieldMap = {}) => (data, pipeline) => {
  if (!pipeline?.processors) return;

  const nodeId = data?.nodeId || null;
  const timestamp = data?.timestamp || Date.now();

  // Prefer stable nodeId dedup when available (prevents stale duplicates across sessions)
  if (nodeId) {
    const existingIdx = pipeline.processors.findIndex(p => p?.nodeId === nodeId);
    if (existingIdx >= 0) {
      const updated = { ...pipeline.processors[existingIdx], type, nodeId, timestamp };
      for (const [field, defaultVal] of Object.entries(fieldMap)) {
        updated[field] = data[field] ?? defaultVal;
      }
      pipeline.processors[existingIdx] = updated;
      return;
    }
  } else if (pipeline.processors.some(p => p.type === type && p.timestamp === timestamp)) {
    return;
  }

  const entry = { type, nodeId, timestamp };
  for (const [field, defaultVal] of Object.entries(fieldMap)) {
    entry[field] = data[field] ?? defaultVal;
  }
  pipeline.processors.push(entry);
};

/**
 * Sync handlers for methodCalls - OCP: Add new handlers without modifying sync loop
 * Maps registry keys to pipeline sync functions
 *
 * ⚠️ SYNC REQUIRED: When adding a new processor type here, also add a corresponding
 * hook in EarlyHook.js → METHOD_HOOK_CONFIGS
 */
export const METHOD_CALL_SYNC_HANDLERS = {
  // Special handlers - also add to processors array for cleanup tracking
  mediaStreamSource: (data, pipeline) => {
    pipeline.inputSource = 'microphone';
    // Also add as processor for proper cleanup on disconnect
    createProcessorHandler('mediaStreamSource')(data, pipeline);
  },
  mediaStreamDestination: (data, pipeline) => {
    pipeline.destinationType = DESTINATION_TYPES.MEDIA_STREAM;
    // Also add as processor for proper cleanup on disconnect
    createProcessorHandler('mediaStreamDestination')(data, pipeline);
  },

  // Processor handlers - OCP: Add new DSP node with single line
  scriptProcessor: createProcessorHandler('scriptProcessor', { bufferSize: 4096, inputChannels: 2, outputChannels: 2 }),
  analyser: createProcessorHandler('analyser', { fftSize: 2048 }),
  gain: createProcessorHandler('gain', { gainValue: 1 }),
  biquadFilter: createProcessorHandler('biquadFilter', { filterType: 'lowpass', frequency: null }),
  dynamicsCompressor: createProcessorHandler('dynamicsCompressor'),
  oscillator: createProcessorHandler('oscillator', { oscillatorType: 'sine' }),
  delay: createProcessorHandler('delay', { maxDelayTime: 1 }),
  convolver: createProcessorHandler('convolver'),
  waveShaper: createProcessorHandler('waveShaper', { oversample: 'none' }),
  panner: createProcessorHandler('panner', { panningModel: 'equalpower' })
};
