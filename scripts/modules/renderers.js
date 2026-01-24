/**
 * renderers.js - UI Rendering Module
 *
 * Contains:
 * - renderRTCStats(): WebRTC stats rendering
 * - renderGUMStats(): getUserMedia stats rendering
 * - renderACStats(): AudioContext stats rendering
 * - renderDebugLogs(): Debug log rendering
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
  formatBitDepth,
  formatChannels,
  debugLog
} from './helpers.js';

import {
  renderAudioPathTree,
  mapNodeTypeToProcessorType,
  isDestinationNodeType,
  EFFECT_NODE_TYPES,
  AUDIO_NODE_DISPLAY_MAP
} from './audio-tree.js';

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

    container.innerHTML = `<div class="rtc-columns">${sendHtml}${recvHtml}</div>`;
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

  container.innerHTML = `<div class="rtc-columns">${sendHtml}${recvHtml}</div>`;
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
  html += `<tr><td>Channels</td><td>${formatChannels(s.channelCount)}</td></tr>`;
  html += `<tr><td>Bit Depth</td><td>${formatBitDepth(s.sampleSize)}</td></tr>`;

  const inLatency = s.latency ? `${(s.latency * 1000).toFixed(1)} ms` : '-';
  html += `<tr><td>In Latency</td><td>${inLatency}</td></tr>`;

  DSP_FIELDS.forEach(field => {
    const value = s[field.key];
    const display = value === true ? 'Yes' : value === false ? 'No' : '-';
    const cls = value === true ? 'good' : '';
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
      tooltip: 'Microphone input stream'
    };
  }

  // 2. Remote audio bağlı - GELEN SES (incoming audio)
  if (ctx.pipeline?.inputSource === 'remote') {
    return {
      icon: '📥',
      label: 'Remote Input',
      tooltip: 'Remote peer audio stream'
    };
  }

  // 3. MediaStreamDestination = audio routed to stream - GİDEN SES
  if (ctx.pipeline?.destinationType === DESTINATION_TYPES.MEDIA_STREAM) {
    return {
      icon: '📤',
      label: 'Stream Output',
      tooltip: 'Audio routed to MediaStream'
    };
  }

  // 4. AnalyserNode = VU Meter / visualizer
  if (ctx.pipeline?.processors?.some(p => p.type === 'analyser')) {
    return {
      icon: '📊',
      label: 'VU Meter',
      tooltip: 'AnalyserNode - audio visualization'
    };
  }

  // 5. Default → Page Audio
  return { icon: '🎵', label: 'Page Audio', tooltip: 'Site audio processing' };
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
// mapNodeTypeToProcessorType ve isDestinationNodeType artık audio-tree.js'den
// import ediliyor (merkezi AUDIO_NODE_DISPLAY_MAP'ten türetilmiş)

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
 * OCP: AUDIO_NODE_DISPLAY_MAP ve EFFECT_NODE_TYPES kullanır
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

  // OCP: Merkezi config'den effect label'larını al
  const effectNodes = mainProcessors
    .filter(p => {
      if (!EFFECT_NODE_TYPES.includes(p.type)) return false;

      // GainNode: 1.0 (pass) ise effect olarak sayma
      if (p.type === 'gain') {
        const gain = p.gainValue ?? p.gain;
        if (gain === 1 || (gain !== undefined && Math.abs(gain - 1) < 0.001)) {
          return false; // bypass - effect değil
        }
      }

      return true;
    })
    .map(p => AUDIO_NODE_DISPLAY_MAP[p.type]?.label)
    .filter(Boolean);

  const uniqueEffects = [...new Set(effectNodes)];
  if (uniqueEffects.length > 0) {
    effectsText = uniqueEffects.join(', ');
  }

  return { processingText, effectsText };
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
        <span class="has-tooltip has-tooltip--info tooltip-left" data-tooltip="${purpose.tooltip}">ⓘ</span>
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

    const latencyTooltip = `Base ${(baseLatency * 1000).toFixed(1)}ms + output ${(outputLatency * 1000).toFixed(1)}ms`;

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
            <tr><td>Channels</td><td class="metric-value">${formatChannels(ctx.static?.channelCount)}</td></tr>
            <tr><td>State</td><td class="${stateClass}">${ctx.static?.state || '-'}</td></tr>
            <tr><td><span class="has-tooltip tooltip-left" data-tooltip="${latencyTooltip}">Latency</span></td><td>${latencyMs}</td></tr>
            <tr><td>Processing</td><td>${processingText || 'None'}</td></tr>
            <tr><td>Effects</td><td>${effectsText || 'None'}</td></tr>
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
