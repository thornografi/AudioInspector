/**
 * encoder-ui.js - Encoder detection and rendering module
 *
 * Contains:
 * - DETECTION_LABELS: Pattern to user-friendly label mapping
 * - ENCODER_DETECTORS: OCP-compliant encoder detection array
 * - renderEncodingSection(): Main encoding UI render function
 * - Helper functions for encoder display
 */

import {
  escapeHtml,
  formatTime,
  formatWorkletName,
  extractCodecName,
  normalizeMimeType,
  debugLog
} from './helpers.js';

// SOURCE: src/core/constants.js - OPUS_FRAME_SIZES_MS
const OPUS_FRAME_SIZES_MS = [2.5, 5, 10, 20, 40, 60];

// ═══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * UI helper - pulsing status text (Detecting / Waiting / Pending / Loading)
 */
export function renderStatusPulse(text, tooltip) {
  const safeText = escapeHtml(text);
  if (tooltip) {
    return `<span class="has-tooltip status-pulse" data-tooltip="${escapeHtml(tooltip)}">${safeText}</span>`;
  }
  return `<span class="status-pulse">${safeText}</span>`;
}

/**
 * Format encoder type for display (e.g., "opus-wasm" → "Opus (WASM)")
 */
export function formatEncoderDisplay(encoder) {
  if (!encoder) return 'Unknown';
  const lower = String(encoder).toLowerCase();

  // Generic WASM encoder types
  const detectedEncoders = {
    'opus-wasm': 'Opus (WASM)',
    'mp3-wasm': 'MP3 (WASM)',
    'aac-wasm': 'AAC (WASM)',
    'vorbis-wasm': 'Vorbis (WASM)',
    'flac-wasm': 'FLAC (WASM)',
    'pcm': 'Linear PCM'
  };

  if (detectedEncoders[lower]) {
    return detectedEncoders[lower];
  }

  // Legacy fallback - old format still in storage
  const legacyEncoders = {
    'opus-recorder': 'Opus (WASM)',
    'lamejs': 'MP3 (WASM)',
    'fdk-aac.js': 'AAC (WASM)',
    'vorbis.js': 'Vorbis (WASM)',
    'libflac.js': 'FLAC (WASM)',
    'linear-pcm': 'Linear PCM'
  };

  if (legacyEncoders[lower]) {
    return legacyEncoders[lower];
  }

  // Return as-is if not recognized
  return encoder;
}

/**
 * Detect encoder input technology from pipeline processors
 * Priority: Worklet > ScriptProcessor > WebAudio > MediaStream
 * Returns the "technology" that processes audio before encoding
 */
export function detectEncoderInputTechnology(processors) {
  if (!processors || processors.length === 0) return null;

  // Filter out analysers (monitors don't process audio for encoding)
  const mainChain = processors.filter(p => p.type !== 'analyser');
  if (mainChain.length === 0) return null;

  // Look for Worklet (highest priority - modern audio processing)
  const worklet = mainChain.find(p => {
    const type = (p.type || '').toLowerCase();
    return type === 'audioworkletnode' || type === 'audioworklet';
  });
  if (worklet) {
    const name = worklet.name || worklet.processorName;
    const shortName = formatWorkletName(name);
    return shortName ? `Worklet (${shortName})` : 'Worklet';
  }

  // Look for ScriptProcessor (legacy audio processing)
  const scriptProc = mainChain.find(p => {
    const type = (p.type || '').toLowerCase();
    return type === 'scriptprocessor' || type === 'scriptprocessornode';
  });
  if (scriptProc) {
    return 'ScriptProcessor';
  }

  // Look for any WebAudio processing nodes (not sources)
  const webAudioNodes = mainChain.filter(p => {
    const type = (p.type || '').toLowerCase();
    // Exclude source nodes - we want processing nodes
    return !type.includes('source') && !type.includes('element');
  });

  if (webAudioNodes.length > 0) {
    // Return the last WebAudio node in the chain
    const lastNode = webAudioNodes[webAudioNodes.length - 1];
    const nodeType = formatWebAudioNodeType(lastNode.type);
    return `WebAudio (${nodeType})`;
  }

  // Only source nodes - direct stream
  const sourceNode = mainChain.find(p => {
    const type = (p.type || '').toLowerCase();
    return type.includes('source');
  });
  if (sourceNode) {
    return 'MediaStream (direct)';
  }

  return null;
}

/**
 * Format WebAudio node type to readable name
 */
function formatWebAudioNodeType(type) {
  if (!type) return 'Unknown';
  const t = type.toLowerCase();

  const nodeNames = {
    'gain': 'Gain',
    'gainnode': 'Gain',
    'biquadfilter': 'Filter',
    'biquadfilternode': 'Filter',
    'dynamicscompressor': 'Compressor',
    'dynamicscompressornode': 'Compressor',
    'convolver': 'Convolver',
    'convolvernode': 'Convolver',
    'waveshaper': 'WaveShaper',
    'waveshapernode': 'WaveShaper',
    'panner': 'Panner',
    'pannernode': 'Panner',
    'stereopanner': 'Panner',
    'stereopannernode': 'Panner',
    'delay': 'Delay',
    'delaynode': 'Delay',
    'iirfilter': 'IIRFilter',
    'iirfilternode': 'IIRFilter'
  };

  return nodeNames[t] || type;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION LABELS
// ═══════════════════════════════════════════════════════════════════════════════
// Pattern to user-friendly detection label mapping (shown in Encoder tooltip)
// Shows detection method (Worker/AudioWorklet) and data quality (full/basic)
//
// Source: src/core/utils/EarlyHook.js → encoderInfo.pattern assignments
// Source: scripts/early-inject.js → Blob hook pattern assignments
//
// ⚠️ SYNC: Keys must match src/collectors/utils/encoder-patterns.js → PATTERN_PRIORITY
//    When adding new patterns: Update both PATTERN_PRIORITY and DETECTION_LABELS
export const DETECTION_LABELS = {
  // AudioWorklet patterns (AudioWorklet.port.postMessage hook)
  'audioworklet-config': { text: 'AudioWorklet (full)', icon: '✓', tooltip: 'Full config via Worklet hook' },
  'audioworklet-init': { text: 'AudioWorklet (basic)', icon: '○', tooltip: 'Basic config via Worklet hook' },
  'audioworklet-deferred': { text: 'AudioWorklet (late)', icon: '◐', tooltip: 'Late Worklet detection' },
  // Worker patterns (Worker.postMessage hook)
  'direct': { text: 'Worker Hook (full)', icon: '✓', tooltip: 'Full config via Worker hook' },
  'nested': { text: 'Worker Hook (full)', icon: '✓', tooltip: 'Nested config via Worker hook' },
  'worker-init': { text: 'Worker Hook (basic)', icon: '○', tooltip: 'Basic config via Worker hook' },
  'worker-audio-init': { text: 'Worker (real-time)', icon: '◐', tooltip: 'Worker init - bitrate may vary' },
  // Blob creation patterns (audio file created - post-hoc detection)
  'audio-blob': { text: 'Blob (post-hoc)', icon: '◑', tooltip: 'Detected from audio Blob' },
  // Default
  'unknown': { text: 'Detected', icon: '?', tooltip: 'Method unknown' }
};

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SOURCE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get input source display info for MediaRecorder
 * Shows where the audio stream originates from
 * @param {string} audioSource - 'microphone', 'system', 'synthesized', 'remote', 'unknown', 'none'
 * @param {boolean} hasAudioTrack - Whether the stream has an audio track
 * @returns {{icon: string, label: string, tooltip?: string}|null}
 */
export function getInputSourceInfo(audioSource, hasAudioTrack) {
  if (!hasAudioTrack) {
    return null; // Don't show input for video-only recordings
  }

  switch (audioSource) {
    case 'microphone':
      return {
        icon: '🎤',
        label: 'Microphone'
        // No tooltip - label is self-explanatory
      };
    case 'system':
      return {
        icon: '🔊',
        label: 'System Audio'
        // No tooltip - label is self-explanatory
      };
    case 'synthesized':
      return {
        icon: '🔄',
        label: 'Web Audio',
        tooltip: 'Processed via WebAudio API'  // Useful - explains routing
      };
    case 'remote':
      return {
        icon: '📡',
        label: 'Remote',
        tooltip: 'WebRTC remote track'  // Useful - clarifies source
      };
    case 'unknown':
      return {
        icon: '❓',
        label: 'Unknown'
        // No tooltip - nothing useful to add
      };
    default:
      // 'none' or truly undefined - don't show
      return null;
  }
}

/**
 * Build Input row object for ENCODER_DETECTORS
 * Centralizes input row creation to avoid DRY violations
 * @param {ReturnType<typeof getInputSourceInfo>} inputInfo - Result from getInputSourceInfo
 * @returns {{label: string, value: string, isMetric: boolean}|null}
 */
export function buildInputRow(inputInfo) {
  if (!inputInfo) return null;
  return {
    label: 'Input',
    value: inputInfo.tooltip
      ? `<span class="has-tooltip" data-tooltip="${inputInfo.tooltip}">${inputInfo.icon} ${inputInfo.label}</span>`
      : `${inputInfo.icon} ${inputInfo.label}`,
    isMetric: false
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENCODER DETECTORS - OCP Compliant Encoder Detection Pattern
// ═══════════════════════════════════════════════════════════════════════════════
//
// Purpose: Detect and extract encoding information from different sources
// Pattern: Array-based detector pattern for Open-Closed Principle compliance
//
// PRIORITY ORDER (CRITICAL - DO NOT REORDER WITHOUT UNDERSTANDING IMPACT)
// Array.find() returns the FIRST matching detector, so order determines priority:
//
// 1. Detected Encoder        → Highest priority (explicit, most reliable)
// 2. WebRTC (RTCPeerConnection) → High priority (explicit from stats)
// 3. PendingMediaRecorder    → MediaRecorder active but mimeType empty
// 4. MediaRecorder           → Medium-high priority (explicit from API)
// 5. PendingWebAudio         → WebAudio pipeline detected, encoder pending
// 6. ScriptProcessor         → LOWEST priority (heuristic guess)
//
// ⚠️ WARNING: Changing array order will break priority logic!
// ⚠️ ScriptProcessor MUST be last - it's a fallback heuristic

export const ENCODER_DETECTORS = [
  {
    name: 'DetectedEncoder',
    detect: (data) => {
      // Skip if no encoder data detected
      if (!data.detectedEncoder) return false;

      // If MediaRecorder is ACTIVE and encoder is from Blob detection only,
      // defer to MediaRecorder detector only when blob format matches MediaRecorder output.
      // Otherwise keep Blob signal (e.g., PCM/WAV export while a MediaRecorder exists on the page).
      const isOnlyBlobDetection = data.detectedEncoder.pattern === 'audio-blob';
      const mr = data.mediaRecorder;
      const mrIsActive = mr?.state === 'recording' || mr?.state === 'paused';
      const hasActiveMediaRecorder = mrIsActive && !!mr?.mimeType && mr?.hasAudioTrack !== false;
      if (isOnlyBlobDetection && hasActiveMediaRecorder) {
        const blobMimeBase = normalizeMimeType(data.detectedEncoder.mimeType);
        const mrMimeBase = normalizeMimeType(mr.mimeType);
        const sameBaseMime = blobMimeBase && mrMimeBase && blobMimeBase === mrMimeBase;

        const blobCodec = String(data.detectedEncoder.codec || '').toLowerCase();
        const blobContainer = String(data.detectedEncoder.container || '').toLowerCase();
        const isWavLike = blobCodec === 'pcm' || blobContainer === 'wav' || blobMimeBase === 'audio/wav' || blobMimeBase === 'audio/wave';

        if (!isWavLike && sameBaseMime) {
          return false; // Let MediaRecorder detector handle native recorder output
        }
      }

      return true;
    },
    extract: (data) => {
      const enc = data.detectedEncoder;

      // Build codec display with application type suffix if available
      // e.g., "OPUS (VoIP)", "OPUS (Audio)", "OPUS (LowDelay)"
      const rawCodec = enc.codec ?? 'unknown';
      const isUnknownCodec = typeof rawCodec === 'string' && rawCodec.toLowerCase() === 'unknown';

      const mimeBase = normalizeMimeType(enc.mimeType);
      const codecLower = String(rawCodec || '').toLowerCase();
      const containerLower = String(enc.container || '').toLowerCase();
      const isLinearPcmWav = codecLower === 'pcm' && (
        containerLower === 'wav' ||
        mimeBase === 'audio/wav' ||
        mimeBase === 'audio/wave'
      );

      // Show "Detecting..." for unknown codec (will be confirmed when Blob is created)
      // Codec = format (PCM, OPUS, MP3), Encoder = process (Linear PCM, Opus WASM)
      const codecBase = isUnknownCodec
        ? renderStatusPulse('Detecting...', 'Confirmed when recording stops')
        : (isLinearPcmWav ? 'PCM' : String(rawCodec).toUpperCase());
      const codecDisplay = enc.applicationName
        ? `${codecBase} (${enc.applicationName})`
        : codecBase;

      // Build rows dynamically based on available data
      const rows = [
        { label: 'Codec', value: codecDisplay, isMetric: true }
      ];

      // Encoder info (opus-wasm, mp3-wasm, aac-wasm, vorbis-wasm, flac-wasm, pcm)
      // Tooltip: sadece worker/worklet filename varsa göster (detection yöntemi kullanıcı için anlamsız)
      if (enc.encoder) {
        const encoderDisplay = formatEncoderDisplay(enc.encoder);

        // Tooltip sadece filename varsa
        const encoderTooltip = enc.workerFilename
          || (enc.processorName ? formatWorkletName(enc.processorName) : null)
          || enc.encoderPath?.split('/').pop()
          || null;

        if (encoderTooltip) {
          rows.push({
            label: 'Encoder',
            value: `<span class="has-tooltip" data-tooltip="${escapeHtml(encoderTooltip)}">${encoderDisplay}</span>`,
            isMetric: true
          });
        } else {
          rows.push({ label: 'Encoder', value: encoderDisplay, isMetric: true });
        }
      } else {
        rows.push({ label: 'Encoder', value: '-', isMetric: false });
      }

      // Container format (OGG, WebM, WAV, MP4, etc.)
      // Always show - use "-" if not detected
      if (enc.container) {
        rows.push({ label: 'Container', value: enc.container.toUpperCase(), isMetric: true });
      } else {
        rows.push({ label: 'Container', value: '-', isMetric: false });
      }

      // Library (underlying C library: libopus, LAME, FDK AAC, etc.)
      // Always show - use "-" if not available (e.g., PCM has no library)
      if (enc.library) {
        rows.push({ label: 'Library', value: enc.library, isMetric: true });
      } else {
        rows.push({ label: 'Library', value: '-', isMetric: false });
      }

      // Bit Depth (important for PCM/WAV - shows sample format: 16-bit int, 32-bit float, etc.)
      if (enc.wavBitDepth) {
        rows.push({ label: 'Bit Depth', value: `${enc.wavBitDepth}bit`, isMetric: true });
      } else {
        rows.push({ label: 'Bit Depth', value: '-', isMetric: false });
      }

      // Bitrate - always show, dynamically calculated from blob size / duration
      if (enc.bitRate && enc.bitRate > 0) {
        rows.push({ label: 'Bitrate', value: `${Math.round(enc.bitRate / 1000)} kbps`, isMetric: true });
      } else if (enc.isLiveEstimate === true) {
        rows.push({
          label: 'Bitrate',
          value: '<span class="has-tooltip" data-tooltip="Calculated when recording stops">Calculating...</span>',
          isMetric: false
        });
      } else {
        rows.push({ label: 'Bitrate', value: '-', isMetric: false });
      }

      // Frame size (if available) - smart unit detection for Opus
      if (enc.frameSize) {
        // Opus frame sizes defined in OPUS_FRAME_SIZES_MS (SOURCE: constants.js)
        // OR sample counts: 120, 240, 480, 960, 1920, 2880 samples (48kHz)
        const unit = OPUS_FRAME_SIZES_MS.includes(enc.frameSize) || enc.frameSize < 100 ? 'ms' : 'samples';
        rows.push({ label: 'Frame', value: `${enc.frameSize} ${unit}`, isMetric: false });
      }

      // Input: Detect technology from AudioContext pipeline
      // Shows WHAT TECHNOLOGY processes audio before encoding (Worklet > ScriptProcessor > WebAudio)
      const deriveEncoderInput = () => {
        const contexts = Array.isArray(data.audioContext)
          ? data.audioContext
          : (data.audioContext ? [data.audioContext] : []);

        for (const ctx of contexts) {
          const processors = ctx?.pipeline?.processors || [];
          if (processors.length === 0) continue;

          const technology = detectEncoderInputTechnology(processors);
          if (technology) return technology;
        }
        return null;
      };

      const encoderInput = deriveEncoderInput();
      rows.push({
        label: 'Input',
        value: encoderInput || '-',
        isMetric: !!encoderInput
      });

      return {
        codec: enc.codec ? String(enc.codec).toUpperCase() : 'UNKNOWN',
        bitrateKbps: enc.bitRate ? `${Math.round(enc.bitRate / 1000)}` : '-',
        source: enc.workerFilename || enc.processorName || 'Worker',
        timestamp: enc.timestamp || Date.now(),
        rows
      };
    }
  },
  {
    name: 'WebRTC',
    detect: (data) => data.rtcStats?.peerConnections?.length > 0,
    extract: (data) => {
      const pc = data.rtcStats.peerConnections.find(c => c.send) || data.rtcStats.peerConnections[0];
      if (!pc?.send?.codec) return null;

      const codecRaw = extractCodecName(pc.send.codec);
      const codec = codecRaw.toUpperCase();
      const bitrateKbps = pc.send.bitrateKbps || '-';

      const rows = [
        { label: 'Codec', value: codec, isMetric: true },
        { label: 'Bitrate', value: `${bitrateKbps} kbps`, isMetric: true },
        // Encoder type - Browser's built-in WebRTC encoder
        {
          label: 'Encoder',
          value: '<span class="has-tooltip" data-tooltip="Browser WebRTC encoder">🌐 WebRTC Native</span>',
          isMetric: false
        }
      ];

      // Opus params (DTX, FEC, CBR/VBR, stereo) - if available
      if (pc.send.opusParams) {
        const op = pc.send.opusParams;
        const modeParts = [];
        if (op.cbr !== undefined) modeParts.push(op.cbr ? 'CBR' : 'VBR');
        if (op.dtx !== undefined) modeParts.push(`DTX:${op.dtx ? 'on' : 'off'}`);
        if (op.fec !== undefined) modeParts.push(`FEC:${op.fec ? 'on' : 'off'}`);
        if (op.stereo !== undefined) modeParts.push(op.stereo ? 'Stereo' : 'Mono');
        if (modeParts.length > 0) {
          rows.push({ label: 'Mode', value: modeParts.join(' / '), isMetric: false });
        }
      }

      return {
        codec,
        bitrateKbps,
        source: 'WebRTC',
        timestamp: data.rtcStats.timestamp || Date.now(),
        rows
      };
    }
  },
  // ─────────────────────────────────────────────────────────────────────
  // PendingMediaRecorder Detector
  // ─────────────────────────────────────────────────────────────────────
  // Detects MediaRecorder that is actively recording but mimeType is not yet available.
  // Some browsers/sites don't set mimeType until start() or first dataavailable event.
  // This ensures we show "recording in progress" instead of "no encoder".
  // Priority: BEFORE MediaRecorder (catches the "mimeType empty" edge case)
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'PendingMediaRecorder',
    detect: (data) => {
      const mr = data.mediaRecorder;
      if (!mr) return false;
      const isActive = mr.state === 'recording' || mr.state === 'paused';
      const hasMimeType = !!mr.mimeType;
      // Active MediaRecorder without mimeType
      return isActive && !hasMimeType;
    },
    extract: (data) => {
      const mr = data.mediaRecorder;
      const inputInfo = getInputSourceInfo(mr.audioSource, mr.hasAudioTrack);

      const rows = [
        {
          label: 'Codec',
          value: renderStatusPulse('Detecting...', 'Waiting for first audio data'),
          isMetric: false
        },
        {
          label: 'Container',
          value: renderStatusPulse('Detecting...', 'From mimeType'),
          isMetric: false
        },
        {
          label: 'Bitrate',
          value: mr.audioBitsPerSecond
            ? `${Math.round(mr.audioBitsPerSecond / 1000)} kbps`
            : renderStatusPulse('Detecting...', 'When encoding starts'),
          isMetric: !!mr.audioBitsPerSecond
        },
        {
          label: 'Encoder',
          value: '<span class="has-tooltip" data-tooltip="Browser MediaRecorder">🌐 MediaRecorder API</span>',
          isMetric: true
        },
        {
          label: 'State',
          value: `<span class="badge badge-code">${mr.state}</span>`,
          isMetric: false
        }
      ];

      // Add input source if available
      const inputRow = buildInputRow(inputInfo);
      if (inputRow) rows.push(inputRow);

      return {
        codec: 'Detecting...',
        bitrateKbps: '-',
        source: 'MediaRecorder',
        timestamp: mr.timestamp || Date.now(),
        rows
      };
    }
  },
  {
    name: 'MediaRecorder',
    detect: (data) => !!data.mediaRecorder?.mimeType,
    extract: (data) => {
      const mr = data.mediaRecorder;
      const mimeTypeLower = (mr.mimeType || '').toLowerCase();

      // Extract codec from various sources
      let codecRaw = mr.parsedMimeType?.codec ||
        mr.mimeType.split('codecs=')[1]?.replace(/['"]/g, '') || '';

      // Edge Case: MP3 detection from mimeType when codecs= parameter is absent
      // MP3 is self-contained (codec IS the format), so mimeType alone is sufficient
      if (!codecRaw && (mimeTypeLower.includes('audio/mp3') || mimeTypeLower.includes('audio/mpeg'))) {
        codecRaw = 'mp3';
      }

      const codec = codecRaw ? codecRaw.toUpperCase() : '-';
      const container = mr.parsedMimeType?.container?.toUpperCase() || '';
      const bitrateKbps = mr.audioBitsPerSecond
        ? `${Math.round(mr.audioBitsPerSecond / 1000)}`
        : '-';

      const stateClass = mr.state === 'recording' ? 'good' :
        (mr.state === 'paused' ? 'warning' : '');

      const rows = [
        { label: 'Codec', value: codec, isMetric: true }
      ];

      if (container) {
        rows.push({ label: 'Container', value: container, isMetric: false });
      }

      rows.push({ label: 'Bitrate', value: `${bitrateKbps} kbps`, isMetric: true });

      // Encoder type - Browser's built-in MediaRecorder API (not WASM)
      // This distinguishes from WASM encoders like opus-recorder, lamejs, etc.
      rows.push({
        label: 'Encoder',
        value: '<span class="has-tooltip" data-tooltip="Browser MediaRecorder (native)">🌐 MediaRecorder API</span>',
        isMetric: false
      });

      if (mr.state) {
        rows.push({
          label: 'State',
          value: `<span class="badge badge-code">${mr.state}</span>`,
          isMetric: false,
          cssClass: stateClass
        });
      }

      // Input source - shows where audio comes from (technical but useful)
      // 'synthesized' = AudioContext pipeline (PCM processed via ScriptProcessor/AudioWorklet)
      // 'microphone' = Direct microphone input
      // 'system' = System audio capture
      debugLog('[Popup] MediaRecorder Input Debug:', {
        audioSource: mr.audioSource,
        hasAudioTrack: mr.hasAudioTrack,
        trackInfo: mr.trackInfo
      });
      const inputInfo = getInputSourceInfo(mr.audioSource, mr.hasAudioTrack);
      debugLog('[Popup] getInputSourceInfo result:', inputInfo);
      const inputRow = buildInputRow(inputInfo);
      if (inputRow) {
        rows.push(inputRow);
      } else {
        debugLog('[Popup] ⚠️ inputInfo is null - Input row NOT added');
      }

      return {
        codec,
        bitrateKbps,
        source: 'MediaRecorder',
        timestamp: mr.timestamp || Date.now(),
        rows
      };
    }
  },
  {
    name: 'PendingWebAudio',
    detect: (data) => {
      // ═══════════════════════════════════════════════════════════════════
      // SINGLE SOURCE OF TRUTH: Use recordingActive from early-inject.js
      // This is the ONLY reliable indicator - no complex heuristics needed
      // ═══════════════════════════════════════════════════════════════════
      if (data.detectedEncoder) return false;
      if (data.rtcStats?.peerConnections?.length > 0) return false;
      if (data.mediaRecorder?.mimeType) return false;
      if (!data.audioContext) return false;

      // Check for active audio pipeline with microphone input
      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      const hasActiveAudioPipeline = contexts.some(ctx => {
        const input = ctx?.pipeline?.inputSource;
        const processors = ctx?.pipeline?.processors || [];
        const hasProcessing = processors.some(p => p.type === 'audioWorkletNode' || p.type === 'scriptProcessor');
        return (input === 'microphone' || input === 'system' || input === 'synthesized') && hasProcessing;
      });

      if (!hasActiveAudioPipeline) return false;

      // SIMPLE: Just check if recording is active (set by MediaRecorder.start or Blob tracking)
      return data.recordingActive?.active === true;
    },
    extract: (data) => {
      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      const ctx = contexts.find(c => {
        const input = c?.pipeline?.inputSource;
        const processors = c?.pipeline?.processors || [];
        const hasProcessing = processors.some(p => p.type === 'audioWorkletNode' || p.type === 'scriptProcessor');
        return (input === 'microphone' || input === 'system' || input === 'synthesized') && hasProcessing;
      });
      if (!ctx) return null;

      const processors = ctx.pipeline?.processors || [];
      const pipelineType = processors.some(p => p.type === 'audioWorkletNode')
        ? 'AudioWorklet'
        : (processors.some(p => p.type === 'scriptProcessor') ? 'ScriptProcessor' : 'WebAudio');

      // Derive Input from AudioContext pipeline (this CAN be detected during recording)
      const encoderInput = detectEncoderInputTechnology(processors);

      return {
        codec: 'Detecting...',
        bitrateKbps: '-',
        source: 'WebAudio',
        timestamp: ctx.pipeline?.timestamp || ctx.static?.timestamp || Date.now(),
        rows: [
          {
            label: 'Codec',
            value: renderStatusPulse('Detecting...', 'Confirmed when Blob created'),
            isMetric: false
          },
          {
            label: 'Encoder',
            value: renderStatusPulse('Detecting...', `Pending - ${pipelineType} detected`),
            isMetric: false
          },
          {
            label: 'Container',
            value: renderStatusPulse('Detecting...', 'From output Blob mimeType'),
            isMetric: false
          },
          {
            label: 'Library',
            value: renderStatusPulse('Detecting...', 'From WASM/Worker analysis'),
            isMetric: false
          },
          {
            label: 'Bit Depth',
            value: renderStatusPulse('Detecting...', 'From WAV header or config'),
            isMetric: false
          },
          {
            label: 'Bitrate',
            value: renderStatusPulse('Calculating...', 'From Blob size/duration'),
            isMetric: false
          },
          {
            label: 'Input',
            value: `<span class="has-tooltip" data-tooltip="WebAudio processing tech">${encoderInput || pipelineType}</span>`,
            isMetric: true
          }
        ]
      };
    }
  },

  // ─────────────────────────────────────────────────────────────────────
  // ScriptProcessor Detector (Heuristic - LOWEST PRIORITY)
  // ─────────────────────────────────────────────────────────────────────
  // Detects ScriptProcessor usage which MAY indicate encoding to WAV/MP3
  // This is a fallback when no explicit encoder (WASM/WebRTC/MediaRecorder) is found
  // Priority: Lowest (only shown when no other encoder is detected)
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'ScriptProcessor',
    detect: (data) => {
      // Check if any AudioContext has ScriptProcessor in pipeline
      if (!data.audioContext) return false;

      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      return contexts.some(ctx =>
        ctx.pipeline?.processors?.some(p => p.type === 'scriptProcessor')
      );
    },
    extract: (data) => {
      const contexts = Array.isArray(data.audioContext) ? data.audioContext : [data.audioContext];
      const ctx = contexts.find(c =>
        c.pipeline?.processors?.some(p => p.type === 'scriptProcessor')
      );

      if (!ctx) return null;

      const sp = ctx.pipeline.processors.find(p => p.type === 'scriptProcessor');
      const bufferSize = sp?.bufferSize || '-';
      const channels = sp?.inputChannels || sp?.outputChannels || '-';

      // ScriptProcessor works with raw PCM data (uncompressed audio samples)
      // It's not a codec - it processes raw Float32Array audio buffers
      // The actual encoding (if any) happens downstream (WAV/MP3 encoding in JS or Worker)
      // NOTE: Buffer/Channels NOT shown here - already displayed in AudioContext section (DRY)
      return {
        codec: 'Raw PCM',
        bitrateKbps: '-',
        source: 'ScriptProcessor',
        timestamp: ctx.static?.timestamp || Date.now(),
        rows: [
          {
            label: 'Codec',
            value: '<span class="has-tooltip" data-tooltip="Raw PCM (Float32Array)">Raw PCM</span>',
            isMetric: true
          },
          {
            label: 'Encoder',
            value: '<span class="has-tooltip" data-tooltip="Heuristic - encoding unconfirmed">ScriptProcessor</span>',
            isMetric: false
          }
        ]
      };
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER ENCODING SECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render Encoding section - OCP compliant with detector pattern
 */
export function renderEncodingSection(detectedEncoder, rtcStats, mediaRecorder, audioContext, userMedia, recordingActive) {
  const container = document.getElementById('encodingContent');
  const timestamp = document.getElementById('encodingTimestamp');
  if (!container) return;

  const data = { detectedEncoder, rtcStats, mediaRecorder, audioContext, userMedia, recordingActive };

  // DEBUG: Log all available data
  debugLog('[Popup] renderEncodingSection data:', {
    hasDetectedEncoder: !!detectedEncoder,
    detectedEncoderPattern: detectedEncoder?.pattern,
    hasRtcStats: !!rtcStats,
    hasMediaRecorder: !!mediaRecorder,
    mediaRecorderState: mediaRecorder?.state,
    mediaRecorderAudioSource: mediaRecorder?.audioSource,
    hasAudioContext: !!audioContext,
    hasUserMedia: !!userMedia,
    userMediaTimestamp: userMedia?.timestamp,
    recordingActive: recordingActive?.active
  });

  // Find first matching detector (priority order maintained by array order)
  const detector = ENCODER_DETECTORS.find(d => d.detect(data));
  debugLog('[Popup] Selected detector:', detector?.name || 'NONE');

  if (!detector) {
    // No encoder detected
    container.innerHTML = '<div class="no-data">No encoder</div>';
    if (timestamp) timestamp.textContent = '';
    return;
  }

  const encoderData = detector.extract(data);

  if (!encoderData) {
    // Detected but extraction failed
    container.innerHTML = '<div class="no-data">No encoder</div>';
    if (timestamp) timestamp.textContent = '';
    return;
  }

  // Build HTML from rows
  let html = `<table><tbody>`;
  encoderData.rows.forEach(row => {
    const valueClass = row.isMetric ? 'class="metric-value"' : (row.cssClass ? `class="${row.cssClass}"` : '');
    html += `<tr><td>${row.label}</td><td ${valueClass}>${row.value}</td></tr>`;
  });
  html += `</tbody></table>`;

  container.innerHTML = html;
  if (timestamp) timestamp.textContent = formatTime(encoderData.timestamp);
}
