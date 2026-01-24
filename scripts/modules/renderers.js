/**
 * renderers.js - UI Rendering Module
 *
 * Contains:
 * - renderRTCStats(): WebRTC stats rendering
 * - renderGUMStats(): getUserMedia stats rendering
 * - renderACStats(): AudioContext stats rendering
 * - renderDebugLogs(): Debug log rendering
 * - Audio path tree rendering
 * - Helper functions and mappings
 */

import {
  escapeHtml,
  formatTime,
  formatWorkletName,
  capitalizeFirst,
  extractCodecName,
  formatJitter,
  getQualityClass,
  getLogColorClass,
  debugLog
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// ╔══════════════════════════════════════════════════════════════════════╗
// ║ SOURCE: src/core/constants.js - DESTINATION_TYPES                   ║
// ║ Cannot import ES modules in popup scripts - must be kept in sync    ║
// ╚══════════════════════════════════════════════════════════════════════╝
export const DESTINATION_TYPES = {
  SPEAKERS: 'speakers',
  MEDIA_STREAM: 'MediaStreamDestination'
};

// SOURCE: src/core/constants.js - RECENT_CONTEXT_THRESHOLD_MS
const RECENT_THRESHOLD_MS = 5000;

export const MAX_AUDIO_CONTEXTS = 4;

// DSP field configuration (OCP: add new DSP types without modifying loop)
export const DSP_FIELDS = [
  { key: 'echoCancellation', label: 'Echo Cancel' },
  { key: 'autoGainControl', label: 'Auto Gain' },
  { key: 'noiseSuppression', label: 'Noise Supp' },
  { key: 'voiceIsolation', label: 'Voice Isolation' }
];

// ═══════════════════════════════════════════════════════════════════════════════
// WEBRTC STATS RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render WebRTC stats (fixed two-column layout)
 */
export function renderRTCStats(data) {
  const container = document.getElementById('rtcContent');
  const timestamp = document.getElementById('rtcTimestamp');

  // Find active connection with send or recv
  let pc = null;
  let connCount = 0;

  if (data?.peerConnections?.length > 0) {
    connCount = data.peerConnections.length;
    pc = data.peerConnections.find(c => c.send && c.recv)
      || data.peerConnections.find(c => c.send || c.recv)
      || data.peerConnections[0];
  }

  const connInfo = connCount > 0 ? ` (${connCount})` : '';

  let sendHtml = `<div class="rtc-column">
    <div class="sub-header sub-header--rtc">
      <span class="direction-icon send">TX</span>
      <span class="sub-header-title">Outgoing${connInfo}</span>
    </div>`;

  let recvHtml = `<div class="rtc-column">
    <div class="sub-header sub-header--rtc">
      <span class="direction-icon recv">RX</span>
      <span class="sub-header-title">Incoming</span>
    </div>`;

  if (!pc) {
    sendHtml += `<table><tbody>
      <tr><td>Codec</td><td>-</td></tr>
      <tr><td>Bitrate</td><td>-</td></tr>
      <tr><td>Mode</td><td>-</td></tr>
      <tr><td>RTT</td><td>-</td></tr>
    </tbody></table></div>`;

    recvHtml += `<table><tbody>
      <tr><td>Codec</td><td>-</td></tr>
      <tr><td>Bitrate</td><td>-</td></tr>
      <tr><td>Jitter</td><td>-</td></tr>
      <tr><td>Loss</td><td>-</td></tr>
    </tbody></table></div>`;

    container.innerHTML = sendHtml + recvHtml;
    timestamp.textContent = '';
    return;
  }

  timestamp.textContent = formatTime(data.timestamp);

  const rttText = pc.rtt !== null ? `${(pc.rtt * 1000).toFixed(0)} ms` : '-';
  const rttClass = pc.rtt !== null ? getQualityClass('rtt', pc.rtt) : '';

  // Send column
  sendHtml += `<table><tbody>`;
  if (pc.send) {
    const codec = extractCodecName(pc.send.codec);
    const bitrate = pc.send.bitrateKbps !== null ? `${pc.send.bitrateKbps} kbps` : '-';
    const mode = pc.send.opusParams ? (pc.send.opusParams.cbr === 1 ? 'CBR' : 'VBR') : '-';
    const fec = pc.send.opusParams?.useinbandfec === 1 ? '+FEC' : '';

    sendHtml += `<tr><td>Codec</td><td class="metric-value">${codec}</td></tr>`;
    sendHtml += `<tr><td>Bitrate</td><td class="metric-value">${bitrate}</td></tr>`;
    sendHtml += `<tr><td>Mode</td><td>${mode} ${fec}</td></tr>`;
  } else {
    sendHtml += `<tr><td>Codec</td><td>-</td></tr>`;
    sendHtml += `<tr><td>Bitrate</td><td>-</td></tr>`;
    sendHtml += `<tr><td>Mode</td><td>-</td></tr>`;
  }
  sendHtml += `<tr><td>RTT</td><td class="${rttClass}">${rttText}</td></tr>`;
  sendHtml += `</tbody></table></div>`;

  // Recv column
  recvHtml += `<table><tbody>`;
  if (pc.recv) {
    const codec = extractCodecName(pc.recv.codec);
    const bitrate = pc.recv.bitrateKbps !== null ? `${pc.recv.bitrateKbps} kbps` : '-';
    const jitter = formatJitter(pc.recv.jitter);
    const jitterClass = getQualityClass('jitter', pc.recv.jitter);
    const plr = pc.recv.packetsReceived > 0 ? ((pc.recv.packetsLost / (pc.recv.packetsReceived + pc.recv.packetsLost)) * 100) : 0;
    const plrClass = getQualityClass('packetLoss', plr);

    recvHtml += `<tr><td>Codec</td><td class="metric-value">${codec}</td></tr>`;
    recvHtml += `<tr><td>Bitrate</td><td class="metric-value">${bitrate}</td></tr>`;
    recvHtml += `<tr><td>Jitter</td><td class="${jitterClass}">${jitter}</td></tr>`;
    recvHtml += `<tr><td>Loss</td><td class="${plrClass}">${plr.toFixed(1)}%</td></tr>`;
  } else {
    recvHtml += `<tr><td>Codec</td><td>-</td></tr>`;
    recvHtml += `<tr><td>Bitrate</td><td>-</td></tr>`;
    recvHtml += `<tr><td>Jitter</td><td>-</td></tr>`;
    recvHtml += `<tr><td>Loss</td><td>-</td></tr>`;
  }
  recvHtml += `</tbody></table></div>`;

  container.innerHTML = sendHtml + recvHtml;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GETUSERMEDIA STATS RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render getUserMedia stats (fixed layout)
 */
export function renderGUMStats(data) {
  const container = document.getElementById('gumContent');
  const timestamp = document.getElementById('gumTimestamp');

  let html = `<table><tbody>`;

  if (!data || !data.settings) {
    html += `<tr><td>Rate</td><td>-</td></tr>`;
    html += `<tr><td>Channels</td><td>-</td></tr>`;
    html += `<tr><td>Bit Depth</td><td>-</td></tr>`;
    html += `<tr><td>In Latency</td><td>-</td></tr>`;
    DSP_FIELDS.forEach(field => {
      html += `<tr><td>${field.label}</td><td>-</td></tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
    timestamp.textContent = '';
    return;
  }

  timestamp.textContent = formatTime(data.timestamp);
  const s = data.settings;

  html += `<tr><td>Rate</td><td class="metric-value">${s.sampleRate || '-'} Hz</td></tr>`;
  html += `<tr><td>Channels</td><td>${s.channelCount || '?'}ch</td></tr>`;
  html += `<tr><td>Bit Depth</td><td>${s.sampleSize || '?'}bit</td></tr>`;

  const inLatency = s.latency ? `${(s.latency * 1000).toFixed(1)} ms` : '-';
  html += `<tr><td>In Latency</td><td>${inLatency}</td></tr>`;

  DSP_FIELDS.forEach(field => {
    const value = s[field.key];
    const display = value ? '✓' : '-';
    const cls = value ? 'good' : '';
    html += `<tr><td>${field.label}</td><td class="${cls}">${display}</td></tr>`;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIOCONTEXT PURPOSE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine AudioContext purpose based on evidence-based model
 */
export function getContextPurpose(ctx) {
  // 1. Mikrofon bağlı - GİDEN SES (outgoing audio)
  if (ctx.pipeline?.inputSource === 'microphone') {
    return {
      icon: '🎤',
      label: 'Mic Input',
      tooltip: 'Microphone stream detected - outgoing audio'
    };
  }

  // 2. Remote audio bağlı - GELEN SES (incoming audio)
  if (ctx.pipeline?.inputSource === 'remote') {
    return {
      icon: '📥',
      label: 'Remote Input',
      tooltip: 'Remote stream detected - incoming audio from peer'
    };
  }

  // 3. MediaStreamDestination = audio routed to stream - GİDEN SES
  if (ctx.pipeline?.destinationType === DESTINATION_TYPES.MEDIA_STREAM) {
    return {
      icon: '📤',
      label: 'Stream Output',
      tooltip: 'MediaStreamDestination created - audio routed to stream'
    };
  }

  // 4. AnalyserNode = VU Meter / visualizer
  if (ctx.pipeline?.processors?.some(p => p.type === 'analyser')) {
    return {
      icon: '📊',
      label: 'VU Meter',
      tooltip: 'AnalyserNode detected - audio visualization'
    };
  }

  // 5. Default → Page Audio
  return { icon: '🎵', label: 'Page Audio', tooltip: 'VU meter, audio effects, playback analysis etc.' };
}

/**
 * Filter AudioContext'leri - giden ses + aktif/yeni context'leri döndür
 */
export function filterOutgoingContexts(contexts) {
  const now = Date.now();
  // RECENT_THRESHOLD_MS defined at module level (SOURCE: constants.js)

  const getContextTimestamp = (ctx) => ctx.pipeline?.timestamp || ctx.static?.timestamp || 0;

  debugLog(` 🔍 filterOutgoingContexts: input has ${contexts.length} context(s)`);
  contexts.forEach((ctx, i) => {
    const purpose = getContextPurpose(ctx);
    debugLog(` 🔍 Input Context[${i}]: ${ctx.contextId} - purpose="${purpose.label}", inputSource=${ctx.pipeline?.inputSource}, state=${ctx.static?.state}`);
  });

  const candidates = contexts.filter(ctx => {
    const purpose = getContextPurpose(ctx);

    if (purpose.label === 'Mic Input' || purpose.label === 'Stream Output') {
      return true;
    }

    const isRunning = ctx.static?.state === 'running';
    const isRecent = (now - (ctx.static?.timestamp || 0)) < RECENT_THRESHOLD_MS;

    return isRunning || isRecent;
  });

  debugLog(` 🔍 filterOutgoingContexts: ${candidates.length} candidate(s) after first pass`);

  const micInputContexts = candidates.filter(ctx =>
    getContextPurpose(ctx).label === 'Mic Input'
  );

  debugLog(` 🔍 filterOutgoingContexts: ${micInputContexts.length} Mic Input context(s) found`);

  if (micInputContexts.length > 0) {
    const sortedMicInputs = [...micInputContexts].sort(
      (a, b) => getContextTimestamp(b) - getContextTimestamp(a)
    );
    debugLog(` 🔍 filterOutgoingContexts: returning NEWEST Mic Input context: ${sortedMicInputs[0].contextId}`);
    return [sortedMicInputs[0]];
  }

  debugLog(` 🔍 filterOutgoingContexts: no Mic Input, returning all ${candidates.length} candidate(s)`);
  return candidates;
}

export function filterConnectionsByContext(connections, contexts) {
  if (!connections || connections.length === 0) return [];
  if (!contexts || contexts.length === 0) return connections;

  const contextIds = new Set(
    contexts.map(ctx => ctx.contextId).filter(Boolean)
  );
  if (contextIds.size === 0) return connections;

  const hasContextIds = connections.some(conn => conn.contextId);
  if (!hasContextIds) return connections;

  return connections.filter(conn => contextIds.has(conn.contextId));
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO PATH GRAPH HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function mapNodeTypeToProcessorType(nodeType) {
  if (!nodeType || typeof nodeType !== 'string') return null;
  switch (nodeType) {
    case 'AudioWorklet': return 'audioWorkletNode';
    case 'ScriptProcessor': return 'scriptProcessor';
    case 'Analyser': return 'analyser';
    case 'Gain': return 'gain';
    case 'BiquadFilter': return 'biquadFilter';
    case 'DynamicsCompressor': return 'dynamicsCompressor';
    case 'Oscillator': return 'oscillator';
    case 'Delay': return 'delay';
    case 'Convolver': return 'convolver';
    case 'WaveShaper': return 'waveShaper';
    case 'Panner': return 'panner';
    default:
      return nodeType.charAt(0).toLowerCase() + nodeType.slice(1);
  }
}

export function isDestinationNodeType(nodeType) {
  if (!nodeType || typeof nodeType !== 'string') return false;
  return nodeType === 'AudioDestination' ||
    nodeType === 'MediaStreamAudioDestination' ||
    nodeType === 'MediaStreamDestination';
}

/**
 * Derive the main Audio Path chain from the connection graph
 */
export function deriveMainChainProcessorsFromConnections(connections, ctx) {
  if (!connections || connections.length === 0) return [];

  const pipelineByNodeId = new Map();
  const pipelineProcessors = ctx?.pipeline?.processors || [];
  for (const p of pipelineProcessors) {
    if (p?.nodeId) {
      pipelineByNodeId.set(p.nodeId, p);
    }
  }

  const nodeTypeById = new Map();
  const edges = new Map();

  for (const c of connections) {
    if (!c?.sourceId || !c?.destId) continue;
    if (typeof c.destType === 'string' && c.destType.startsWith('AudioParam(')) continue;

    if (c.sourceType) nodeTypeById.set(c.sourceId, c.sourceType);
    if (c.destType) nodeTypeById.set(c.destId, c.destType);

    const list = edges.get(c.sourceId) || [];
    list.push(c.destId);
    edges.set(c.sourceId, list);
  }

  const startIds = connections
    .filter(c => c?.sourceType === 'MediaStreamAudioSource' && c?.sourceId)
    .map(c => c.sourceId);

  const destIds = new Set(
    connections
      .filter(c => isDestinationNodeType(c?.destType) && c?.destId)
      .map(c => c.destId)
  );

  const findPath = (startId) => {
    const queue = [startId];
    const prev = new Map();
    prev.set(startId, null);

    while (queue.length > 0) {
      const cur = queue.shift();
      if (destIds.has(cur)) {
        const path = [];
        let n = cur;
        while (n) {
          path.push(n);
          n = prev.get(n);
        }
        path.reverse();
        return path;
      }

      const neighbors = edges.get(cur) || [];
      for (const next of neighbors) {
        if (!next || prev.has(next)) continue;
        prev.set(next, cur);
        queue.push(next);
      }
    }
    return null;
  };

  let bestPath = null;
  for (const startId of startIds) {
    const path = findPath(startId);
    if (!path) continue;
    if (!bestPath || path.length < bestPath.length) {
      bestPath = path;
    }
  }

  if (!bestPath || bestPath.length < 2) return [];

  const processors = [];
  for (const nodeId of bestPath) {
    const nodeType = nodeTypeById.get(nodeId);
    if (nodeType === 'MediaStreamAudioSource') continue;
    if (isDestinationNodeType(nodeType)) continue;

    const fromPipeline = pipelineByNodeId.get(nodeId);
    if (fromPipeline) {
      if (fromPipeline.type !== 'analyser') {
        processors.push(fromPipeline);
      }
      continue;
    }

    const mappedType = mapNodeTypeToProcessorType(nodeType);
    if (!mappedType || mappedType === 'analyser') continue;

    const entry = { type: mappedType, nodeId, timestamp: Date.now() };
    if (mappedType === 'audioWorkletNode') {
      entry.processorName = '?';
    }
    processors.push(entry);
  }

  return processors;
}

/**
 * MediaStreamSource tekrarlarını tek girdiye indirger
 */
export function dedupeMediaStreamSources(processors) {
  if (!processors || processors.length === 0) return [];

  let seen = false;
  return processors.filter(proc => {
    if (proc.type !== 'mediaStreamSource') return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

/**
 * Extract Processing and Effects info from processors
 */
export function extractProcessingInfo(mainProcessors, monitors) {
  let processingText = '';
  let effectsText = '';

  const worklet = mainProcessors.find(p => p.type === 'audioWorkletNode');
  const scriptProc = mainProcessors.find(p => p.type === 'scriptProcessor');

  if (worklet) {
    const procName = worklet.processorName || 'processor';
    const shortName = formatWorkletName(procName);
    processingText = `Worklet (${shortName})`;
  } else if (scriptProc) {
    processingText = 'ScriptProcessor';
  }

  const effectNodes = [];

  mainProcessors.forEach(p => {
    if (p.type === 'biquadFilter') effectNodes.push('Filter');
    else if (p.type === 'convolver') effectNodes.push('Reverb');
    else if (p.type === 'delay') effectNodes.push('Delay');
    else if (p.type === 'dynamicsCompressor') effectNodes.push('Compressor');
    else if (p.type === 'waveShaper') effectNodes.push('Distortion');
    else if (p.type === 'stereoPanner') effectNodes.push('Panner');
    else if (p.type === 'panner') effectNodes.push('3D Panner');
  });

  const uniqueEffects = [...new Set(effectNodes)];
  if (uniqueEffects.length > 0) {
    effectsText = uniqueEffects.join(', ');
  }

  return { processingText, effectsText };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO NODE DISPLAY MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

export const AUDIO_NODE_DISPLAY_MAP = {
  // SOURCE NODES
  mediaStreamSource: {
    label: 'Microphone',
    tooltip: 'MediaStreamAudioSourceNode'
  },
  mediaElementSource: {
    label: 'Media Player',
    tooltip: 'MediaElementAudioSourceNode',
    getParam: (proc) => proc.mediaType || null
  },
  bufferSource: {
    label: 'Audio Buffer',
    tooltip: 'AudioBufferSourceNode',
    getParam: (proc) => proc.loop ? 'loop' : null
  },
  oscillator: {
    label: 'Tone Generator',
    tooltip: 'OscillatorNode',
    getParam: (proc) => {
      const typeMap = {
        'sine': 'sine',
        'square': 'square',
        'sawtooth': 'saw',
        'triangle': 'tri',
        'custom': 'custom'
      };
      return typeMap[proc.oscillatorType] || proc.oscillatorType || null;
    }
  },
  constantSource: {
    label: 'DC Offset',
    tooltip: 'ConstantSourceNode'
  },

  // EFFECT / PROCESSING NODES
  gain: {
    label: 'Volume',
    tooltip: 'GainNode',
    getParam: (proc) => {
      const gain = proc.gainValue ?? proc.gain;
      if (gain === undefined || gain === null) return null;

      if (gain === 1 || Math.abs(gain - 1) < 0.001) {
        return 'pass';
      }
      if (gain === 0) {
        return 'muted';
      }
      if (gain < 1) {
        const dB = 20 * Math.log10(gain);
        return `${dB.toFixed(0)}dB`;
      }
      const dB = 20 * Math.log10(gain);
      return `+${dB.toFixed(0)}dB`;
    }
  },
  biquadFilter: {
    label: 'Filter',
    tooltip: 'BiquadFilterNode',
    getParam: (proc) => {
      const typeMap = {
        'lowpass': 'LP',
        'highpass': 'HP',
        'bandpass': 'BP',
        'lowshelf': 'LS',
        'highshelf': 'HS',
        'peaking': 'peak',
        'notch': 'notch',
        'allpass': 'AP'
      };
      const shortType = typeMap[proc.filterType] || proc.filterType;
      if (proc.frequency) {
        const freq = proc.frequency >= 1000
          ? `${(proc.frequency / 1000).toFixed(1)}k`
          : `${Math.round(proc.frequency)}`;
        return `${shortType} ${freq}Hz`;
      }
      return shortType || null;
    }
  },
  dynamicsCompressor: {
    label: 'Compressor',
    tooltip: 'DynamicsCompressorNode',
    getParam: (proc) => {
      if (proc.threshold !== undefined && proc.ratio !== undefined) {
        return `${proc.threshold}dB ${proc.ratio}:1`;
      }
      if (proc.threshold !== undefined) {
        return `${proc.threshold}dB`;
      }
      return null;
    }
  },
  convolver: {
    label: 'Reverb',
    tooltip: 'ConvolverNode',
    getParam: (proc) => proc.normalize === false ? 'raw' : null
  },
  delay: {
    label: 'Delay',
    tooltip: 'DelayNode',
    getParam: (proc) => {
      const time = proc.delayTime ?? proc.maxDelayTime;
      if (time !== undefined) {
        const ms = time * 1000;
        return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
      }
      return null;
    }
  },
  waveShaper: {
    label: 'Distortion',
    tooltip: 'WaveShaperNode',
    getParam: (proc) => {
      if (proc.oversample && proc.oversample !== 'none') {
        return proc.oversample;
      }
      return null;
    }
  },
  stereoPanner: {
    label: 'Panner',
    tooltip: 'StereoPannerNode',
    getParam: (proc) => {
      const pan = proc.pan;
      if (pan === undefined || pan === null) return null;
      if (pan === 0 || Math.abs(pan) < 0.01) return 'center';
      if (pan < 0) return `L${Math.abs(Math.round(pan * 100))}%`;
      return `R${Math.round(pan * 100)}%`;
    }
  },
  panner: {
    label: '3D Panner',
    tooltip: 'PannerNode',
    getParam: (proc) => {
      const modelMap = { 'equalpower': 'EQ', 'HRTF': 'HRTF' };
      return modelMap[proc.panningModel] || null;
    }
  },
  iirFilter: {
    label: 'IIR Filter',
    tooltip: 'IIRFilterNode'
  },

  // ANALYSIS NODES
  analyser: {
    label: 'Analyzer',
    tooltip: 'AnalyserNode',
    getParam: (proc) => {
      if (proc.fftSize) {
        return `${proc.fftSize}pt`;
      }
      return null;
    }
  },

  // CHANNEL NODES
  channelSplitter: {
    label: 'Splitter',
    tooltip: 'ChannelSplitterNode',
    getParam: (proc) => proc.numberOfOutputs ? `${proc.numberOfOutputs}ch` : null
  },
  channelMerger: {
    label: 'Merger',
    tooltip: 'ChannelMergerNode',
    getParam: (proc) => proc.numberOfInputs ? `${proc.numberOfInputs}ch` : null
  },

  // WORKLET / SCRIPT NODES
  audioWorkletNode: {
    label: 'Processor',
    tooltip: 'AudioWorkletNode',
    getParam: (proc) => {
      if (!proc.processorName) return null;
      const name = formatWorkletName(proc.processorName);
      const encoderMap = {
        'opus': 'Opus',
        'mp3': 'MP3',
        'ogg': 'OGG',
        'vorbis': 'Vorbis',
        'aac': 'AAC',
        'flac': 'FLAC',
        'wav': 'WAV',
        'pcm': 'PCM'
      };
      return encoderMap[name.toLowerCase()] || name;
    }
  },
  scriptProcessor: {
    label: 'Processor',
    tooltip: 'ScriptProcessorNode (deprecated)',
    getParam: (proc) => {
      if (proc.bufferSize) {
        return `${proc.bufferSize}`;
      }
      return null;
    }
  },

  // DESTINATION NODES
  mediaStreamDestination: {
    label: 'Stream Output',
    tooltip: 'MediaStreamAudioDestinationNode'
  },
  destination: {
    label: 'Speakers',
    tooltip: 'AudioDestinationNode'
  }
};

/**
 * Format processor for tree display
 */
export function formatProcessorForTree(proc) {
  const mapping = AUDIO_NODE_DISPLAY_MAP[proc.type];

  if (mapping) {
    const param = mapping.getParam ? mapping.getParam(proc) : null;
    return {
      label: mapping.label,
      param,
      tooltip: mapping.tooltip
    };
  }

  const readableType = proc.type
    ? proc.type.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim()
    : 'Unknown';

  return {
    label: readableType,
    param: null,
    tooltip: proc.type || 'Unknown AudioNode'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO PATH TREE RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render Audio Path as nested ASCII tree with tooltips
 */
export function renderAudioPathTree(mainProcessors, monitors, inputSource) {
  if ((!mainProcessors || mainProcessors.length === 0) && !inputSource) {
    return '<div class="no-data">No audio path</div>';
  }

  const buildNestedTree = () => {
    const rootLabel = inputSource
      ? capitalizeFirst(inputSource)
      : 'Source';
    const rootTooltip = inputSource === 'microphone'
      ? 'MediaStreamAudioSourceNode'
      : inputSource === 'remote'
        ? 'MediaStreamAudioSourceNode (remote)'
        : 'AudioSourceNode';
    const root = { label: rootLabel, tooltip: rootTooltip, children: [], isRoot: true };

    const chainProcessors = (mainProcessors || []).filter(p => p.type !== 'mediaStreamSource');

    let currentParent = root;
    let lastProcessorNode = root;

    chainProcessors.forEach((proc) => {
      const formatted = formatProcessorForTree(proc);
      const node = {
        label: formatted.label,
        param: formatted.param,
        tooltip: formatted.tooltip,
        children: []
      };

      currentParent.children.push(node);
      lastProcessorNode = node;
      currentParent = node;
    });

    const encoderNode = {
      label: 'Encoder',
      param: 'output',
      tooltip: 'Audio output → Encoding pipeline (see ENCODING section)',
      children: []
    };

    const analyzerNodes = monitors.map((mon) => {
      const formatted = formatProcessorForTree(mon);
      return {
        label: formatted.label,
        param: formatted.param,
        tooltip: formatted.tooltip + ' (monitoring tap)',
        children: [],
        isMonitor: true
      };
    });

    lastProcessorNode.children.push(encoderNode);
    analyzerNodes.forEach(an => lastProcessorNode.children.push(an));

    return root;
  };

  const tree = buildNestedTree();

  const getCharCount = (node) => {
    return node.label?.length || 0;
  };

  const renderNode = (node, isRoot = false) => {
    const hasChildren = node.children && node.children.length > 0;
    const charCount = getCharCount(node);

    const classes = ['tree-node'];
    if (isRoot) classes.push('tree-root');
    if (hasChildren) classes.push('has-children');
    if (node.isMonitor) classes.push('tree-monitor');

    // Label ve param ayrı elementler - JS ölçümü için gerekli
    const labelHtml = `<span class="tree-label-text">${escapeHtml(node.label)}</span>`;
    const paramHtml = node.param
      ? `<span class="tree-param">(${escapeHtml(node.param)})</span>`
      : '';

    const labelClass = node.tooltip ? 'tree-label has-tooltip' : 'tree-label';
    const tooltipAttr = node.tooltip ? ` data-tooltip="${escapeHtml(node.tooltip)}"` : '';

    let html = `<div class="${classes.join(' ')}">`;
    html += `<span class="${labelClass}"${tooltipAttr}>${labelHtml}${paramHtml}</span>`;

    if (hasChildren) {
      html += `<div class="tree-children" style="--parent-chars: ${charCount}">`;
      node.children.forEach(child => {
        html += renderNode(child, false);
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  };

  return `<div class="audio-tree">${renderNode(tree, true)}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIOCONTEXT STATS RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render AudioContext stats - supports multiple contexts
 */
export function renderACStats(contexts, audioConnections = null) {
  const container = document.getElementById('acContent');
  const timestamp = document.getElementById('acTimestamp');

  if (!contexts || (Array.isArray(contexts) && contexts.length === 0)) {
    container.innerHTML = '<div class="no-data">No context</div>';
    timestamp.textContent = '';
    return;
  }

  let contextArray = Array.isArray(contexts) ? contexts : [contexts];
  contextArray = filterOutgoingContexts(contextArray);

  if (contextArray.length === 0) {
    container.innerHTML = '<div class="no-data">No outgoing audio</div>';
    timestamp.textContent = '';
    return;
  }

  if (contextArray.length > MAX_AUDIO_CONTEXTS) {
    contextArray = contextArray.slice(0, MAX_AUDIO_CONTEXTS);
  }

  const firstCtx = contextArray[0];
  timestamp.textContent = formatTime(firstCtx.static?.timestamp);

  let html = '';

  debugLog(` 🔍 renderACStats: rendering ${contextArray.length} context(s)`);
  contextArray.forEach((ctx, index) => {
    debugLog(` 🔍 Context[${index}]:`, {
      contextId: ctx.contextId,
      inputSource: ctx.pipeline?.inputSource,
      hasMediaStreamSource: ctx.pipeline?.processors?.some(p => p.type === 'mediaStreamSource'),
      processorCount: ctx.pipeline?.processors?.length,
      state: ctx.static?.state
    });

    const purpose = getContextPurpose(ctx);
    debugLog(` 🔍 Context[${index}] purpose: ${purpose.label} (${purpose.icon})`);

    if (purpose.label === 'Page Audio') {
      html += `<div class="context-item context-minimal${index > 0 ? ' context-separator' : ''}">
        <span class="context-purpose">${purpose.icon} ${purpose.label}</span>
        <span class="has-tooltip has-tooltip--info" data-tooltip="${purpose.tooltip}">ⓘ</span>
        <span class="context-subtext">Site audio processing (VU meter, effects, etc.)</span>
      </div>`;
      return;
    }

    const baseLatency = ctx.static?.baseLatency || 0;
    const outputLatency = ctx.static?.outputLatency || 0;
    const totalLatency = baseLatency + outputLatency;
    const latencyMs = totalLatency > 0 ? `${(totalLatency * 1000).toFixed(1)}ms` : '-';
    const stateClass = ctx.static?.state === 'running' ? 'good' : (ctx.static?.state === 'suspended' ? 'warning' : '');

    const ctxConnections = filterConnectionsByContext(audioConnections?.connections, [ctx]);
    debugLog(` 🔍 Audio Path: ctxConnections.length=${ctxConnections.length}`);
    const mainFromGraph = ctxConnections.length > 0
      ? deriveMainChainProcessorsFromConnections(ctxConnections, ctx)
      : [];
    debugLog(` 🔍 Audio Path: mainFromGraph.length=${mainFromGraph.length}`);
    let mainProcessors = mainFromGraph.length > 0
      ? mainFromGraph
      : (ctx.pipeline?.processors?.filter(p => p.type !== 'analyser') || []);
    debugLog(` 🔍 Audio Path: mainProcessors (before fallback)=`, mainProcessors);

    const hasInputSource = !!ctx.pipeline?.inputSource;

    if (hasInputSource && !mainProcessors.some(p => p.type === 'mediaStreamSource')) {
      mainProcessors = [
        { type: 'mediaStreamSource', timestamp: ctx.pipeline?.timestamp },
        ...mainProcessors
      ];
      debugLog(` 🔍 Audio Path: FALLBACK applied! Added mediaStreamSource to chain`);
    }

    mainProcessors = dedupeMediaStreamSources(mainProcessors);
    debugLog(` 🔍 Audio Path: FINAL mainProcessors.length=${mainProcessors.length}`);

    const monitors = ctx.pipeline?.processors?.filter(p => p.type === 'analyser') || [];
    const { processingText, effectsText } = extractProcessingInfo(mainProcessors, monitors);

    html += `<div class="context-item${index > 0 ? ' context-separator' : ''}">`;

    const channelTooltip = 'Output channel capacity (destination.maxChannelCount)';
    const latencyTooltip = `Total output latency (baseLatency: ${(baseLatency * 1000).toFixed(1)}ms + outputLatency: ${(outputLatency * 1000).toFixed(1)}ms). Input latency is shown in getUserMedia section.`;

    const inputLabel = hasInputSource
      ? `${purpose.icon} ${capitalizeFirst(ctx.pipeline.inputSource)}`
      : '-';

    html += `
      <div class="ac-section ac-section--first">
        <div class="sub-header sub-header--ac">
          <span class="ac-section-title">Context Info</span>
        </div>
        <table class="ac-main-table">
          <tbody>
            <tr><td>Input</td><td>${inputLabel}</td></tr>
            <tr><td><span class="has-tooltip" data-tooltip="${channelTooltip}">Channels</span></td><td class="metric-value">${ctx.static?.channelCount || '-'}</td></tr>
            <tr><td>State</td><td class="${stateClass}">${ctx.static?.state || '-'}</td></tr>
            <tr><td><span class="has-tooltip" data-tooltip="${latencyTooltip}">Latency</span></td><td>${latencyMs}</td></tr>
            ${processingText ? `<tr><td>Processing</td><td>${processingText}</td></tr>` : ''}
            ${effectsText ? `<tr><td>Effects</td><td>${effectsText}</td></tr>` : ''}
          </tbody>
        </table>
      </div>
    `;

    const hasMainProcessors = mainProcessors.length > 0;

    if (hasInputSource || hasMainProcessors) {
      const pipelineTs = formatTime(ctx.pipeline?.timestamp);

      html += `
        <div class="ac-section">
          <div class="sub-header sub-header--ac">
            <span class="ac-section-title">Audio Path</span>
            <span class="ac-detected-time-subtle">(${pipelineTs})</span>
          </div>
          ${renderAudioPathTree(mainProcessors, monitors, ctx.pipeline?.inputSource)}
        </div>
      `;
    }

    if (ctx.encodingHint) {
      html += `
        <div class="ac-section pcm-processing-section">
          <div class="processing-item">
            <span class="detail-label">⚠️ Processing</span>
            <span class="detail-value has-tooltip" data-tooltip="Raw audio data - not yet encoded">${escapeHtml(ctx.encodingHint.hint)}</span>
          </div>
        </div>`;
    }

    html += `</div>`;
  });

  debugLog(` 🔍 renderACStats: HTML length=${html.length}, container=`, container);
  debugLog(` 🔍 renderACStats: HTML preview (first 500 chars):`, html.substring(0, 500));
  container.innerHTML = html;
  debugLog(` 🔍 renderACStats: DOM updated, container.children.length=`, container.children.length);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG LOGS RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render Debug Logs (compact single-line format)
 */
export function renderDebugLogs(logs, updateLogBadgeFn) {
  const container = document.getElementById('debugContent');
  const logCount = logs?.length || 0;

  if (updateLogBadgeFn) {
    updateLogBadgeFn(logCount);
  }

  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="no-data">Waiting for events...</div>';
    return;
  }

  let html = '';
  logs.forEach(log => {
    const time = formatTime(log.timestamp);
    const colorClass = getLogColorClass(log.message, log.level);

    html += `<div class="log-line ${colorClass}">
      <span class="log-time">${time}</span>
      <span class="log-prefix">[${escapeHtml(log.prefix)}]</span>
      <span class="log-message">${escapeHtml(log.message)}</span>
    </div>`;
  });

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}
