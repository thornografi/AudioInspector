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
  createTooltip,
  formatChannels,
  debugLog
} from './helpers.js';

import {
  renderAudioFlow,
  mapNodeTypeToProcessorType,
  isDestinationNodeType,
  getEffectNodeTypes,
  AUDIO_NODE_DISPLAY_MAP
} from './audio-flow.js';

import {
  deriveEncodingOutput,
  toRenderOptions
} from './encoding-location.js';

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

// Encoding cache: contextId → { encodingNodeId, encoderCodec }
// Prevents encoding badge from disappearing when inspector stops (technology change)
const _encodingInfoCache = new Map();

export const MAX_AUDIO_CONTEXTS = 4;

// DSP field configuration (OCP: add new DSP types without modifying loop)
export const DSP_FIELDS = [
  { key: 'echoCancellation', label: 'Echo Cancellation' },
  { key: 'autoGainControl', label: 'Auto Gain Control' },
  { key: 'noiseSuppression', label: 'Noise Suppression' },
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

  const connInfo = connCount > 0 ? `(${connCount})` : '';

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

    // Build Mode cell with tooltip
    const modeTooltip = mode !== '-' ? 'Constant/Variable Bitrate encoding' : null;
    const fecTooltip = fec ? 'Forward Error Correction' : null;
    const modeValue = mode !== '-'
      ? (fec
          ? `${createTooltip(mode, modeTooltip)} ${createTooltip(fec, fecTooltip)}`
          : createTooltip(mode, modeTooltip))
      : mode;

    sendHtml += `<tr><td class="metric-label">Codec</td><td class="metric-value">${codec}</td></tr>`;
    sendHtml += `<tr><td class="metric-label">Bitrate</td><td class="metric-value">${bitrate}</td></tr>`;
    sendHtml += `<tr><td>Mode</td><td>${modeValue}</td></tr>`;
  } else {
    sendHtml += `<tr><td>Codec</td><td>-</td></tr>`;
    sendHtml += `<tr><td>Bitrate</td><td>-</td></tr>`;
    sendHtml += `<tr><td>Mode</td><td>-</td></tr>`;
  }
  sendHtml += `<tr><td>${createTooltip('RTT', 'Round-Trip Time (network latency)')}</td><td class="${rttClass}">${rttText}</td></tr>`;
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

    recvHtml += `<tr><td class="metric-label">Codec</td><td class="metric-value">${codec}</td></tr>`;
    recvHtml += `<tr><td class="metric-label">Bitrate</td><td class="metric-value">${bitrate}</td></tr>`;
    recvHtml += `<tr><td>${createTooltip('Jitter', 'Packet delay variation', 'left')}</td><td class="${jitterClass}">${jitter}</td></tr>`;
    recvHtml += `<tr><td>${createTooltip('Loss', 'Packet loss percentage', 'left')}</td><td class="${plrClass}">${plr.toFixed(1)}%</td></tr>`;
  } else {
    recvHtml += `<tr><td>Codec</td><td>-</td></tr>`;
    recvHtml += `<tr><td>Bitrate</td><td>-</td></tr>`;
    recvHtml += `<tr><td>${createTooltip('Jitter', 'Packet delay variation', 'left')}</td><td>-</td></tr>`;
    recvHtml += `<tr><td>${createTooltip('Loss', 'Packet loss percentage', 'left')}</td><td>-</td></tr>`;
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
    html += `<tr><td>Input Latency</td><td>-</td></tr>`;
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

  html += `<tr><td class="metric-label">Rate</td><td class="metric-value">${s.sampleRate || '-'} Hz</td></tr>`;
  html += `<tr><td>Channels</td><td>${formatChannels(s.channelCount)}</td></tr>`;
  html += `<tr><td>Bit Depth</td><td>${formatBitDepth(s.sampleSize)}</td></tr>`;

  const inLatency = s.latency ? `${(s.latency * 1000).toFixed(1)} ms` : '-';
  html += `<tr><td>Input Latency</td><td>${inLatency}</td></tr>`;

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
 * @param {Array} contexts - AudioContext array
 * @param {Object|null} audioConnections - Audio connections data (optional)
 *        Used to prioritize contexts that have actual connections in the graph
 */
export function filterOutgoingContexts(contexts, audioConnections = null) {
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
    // ═══════════════════════════════════════════════════════════════════════════
    // TECHNOLOGY CHANGE FIX: Prioritize contexts that have actual connections
    // When technology changes, a new context (ctx_3) is created but its connections
    // are never emitted (inspector stops). We should prefer contexts WITH connections.
    // ═══════════════════════════════════════════════════════════════════════════
    const connections = audioConnections?.connections || [];
    const contextsWithConnections = micInputContexts.filter(ctx => {
      if (connections.length === 0) return true; // No connections data - include all
      return connections.some(conn => conn.contextId === ctx.contextId);
    });

    debugLog(` 🔍 filterOutgoingContexts: ${contextsWithConnections.length}/${micInputContexts.length} Mic Input context(s) have connections`);

    // If some contexts have connections, prioritize those; otherwise fall back to all
    const pool = contextsWithConnections.length > 0 ? contextsWithConnections : micInputContexts;
    const sortedMicInputs = [...pool].sort(
      (a, b) => getContextTimestamp(b) - getContextTimestamp(a)
    );

    debugLog(` 🔍 filterOutgoingContexts: returning ${contextsWithConnections.length > 0 ? 'NEWEST with connections' : 'NEWEST'}: ${sortedMicInputs[0].contextId}`);
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
// PROCESSOR TREE (Paralel Branch Desteği)
// ═══════════════════════════════════════════════════════════════════════════════
// mapNodeTypeToProcessorType ve isDestinationNodeType artık audio-flow.js'den
// import ediliyor (merkezi AUDIO_NODE_DISPLAY_MAP'ten türetilmiş)

/**
 * @typedef {Object} ProcessorTreeNode
 * @property {Object} processor - { type, nodeId, ... }
 * @property {ProcessorTreeNode[]} children
 * @property {string} [terminalType] - 'encoder' | 'speakers' | null
 */

/**
 * DFS ile processor tree oluştur (paralel branch + cycle detection destekli)
 *
 * Bu fonksiyon N-ary tree döndürür (paralel branch'leri destekler).
 *
 * @param {Array} connections - Audio node bağlantıları
 * @param {Object} ctx - AudioContext verisi (pipeline.processors içerir)
 * @returns {ProcessorTreeNode|null} - Root node veya null
 */
export function deriveProcessorTreeFromConnections(connections, ctx) {
  if (!connections || connections.length === 0) return null;

  // Pipeline processor'larını nodeId ile indexle
  const pipelineByNodeId = new Map();
  const pipelineProcessors = ctx?.pipeline?.processors || [];
  for (const p of pipelineProcessors) {
    if (p?.nodeId) {
      pipelineByNodeId.set(p.nodeId, p);
    }
  }

  // Graph yapısını kur
  const nodeTypeById = new Map();
  const edges = new Map(); // sourceId → [destId, ...]

  for (const c of connections) {
    if (!c?.sourceId || !c?.destId) continue;
    // AudioParam bağlantılarını atla
    if (typeof c.destType === 'string' && c.destType.startsWith('AudioParam(')) continue;

    if (c.sourceType) nodeTypeById.set(c.sourceId, c.sourceType);
    if (c.destType) nodeTypeById.set(c.destId, c.destType);

    const list = edges.get(c.sourceId) || [];
    list.push(c.destId);
    edges.set(c.sourceId, list);
  }

  // Start node'ları bul (MediaStreamAudioSource)
  const startIds = connections
    .filter(c => c?.sourceType === 'MediaStreamAudioSource' && c?.sourceId)
    .map(c => c.sourceId);

  if (startIds.length === 0) return null;

  // Destination node'ları bul
  const destIds = new Set(
    connections
      .filter(c => isDestinationNodeType(c?.destType) && c?.destId)
      .map(c => c.destId)
  );

  /**
   * Node ID → ProcessorTreeNode dönüşümü
   */
  const nodeIdToProcessor = (nodeId) => {
    const nodeType = nodeTypeById.get(nodeId);

    // Destination node → terminal marker döndür
    if (isDestinationNodeType(nodeType)) {
      const terminalType = nodeType === 'MediaStreamAudioDestination' ? 'encoder' : 'speakers';
      return { processor: null, terminalType, nodeId };
    }

    // Source node → skip (root'ta gösterilecek)
    if (nodeType === 'MediaStreamAudioSource') {
      return null;
    }

    // Pipeline'dan processor bilgisi al
    const fromPipeline = pipelineByNodeId.get(nodeId);
    if (fromPipeline) {
      return { processor: { ...fromPipeline }, nodeId };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRICT MODE: Pipeline'da olmayan node'ları flow'a EKLEME
    // ═══════════════════════════════════════════════════════════════════════
    // Eski davranış (KALDIRILDI): nodeType'dan FAKE processor oluşturuyordu
    // Problem: Connection'da "Gain" var ama pipeline'da o nodeId yok →
    //          Fallback gainValue=undefined → default "pass" → yanlış "Volume(pass)" gösterimi
    // Yeni davranış: null döndür → bu node flow'da görünmez
    console.warn(`[Audio Flow] Node ${nodeId} (${nodeType}) pipeline'da yok, atlanıyor`);
    return null;
  };

  /**
   * DFS ile tree oluştur (cycle detection + merge point handling)
   */
  const buildTreeDFS = (nodeId, visited, globalSeen) => {
    // Cycle detection: aynı DFS path'te tekrar görüldü
    if (visited.has(nodeId)) {
      return null; // Feedback loop - atla
    }

    // Merge point: farklı path'ten zaten işlendi
    // "İlk kazansın" stratejisi: ilk gören branch gösterir
    if (globalSeen.has(nodeId)) {
      return null;
    }

    const nodeInfo = nodeIdToProcessor(nodeId);
    if (!nodeInfo) {
      // Source node - children'ları direkt işle
      const neighbors = edges.get(nodeId) || [];
      if (neighbors.length === 0) return null;

      // Tek child varsa onu döndür
      if (neighbors.length === 1) {
        return buildTreeDFS(neighbors[0], visited, globalSeen);
      }

      // Birden fazla child - virtual root oluştur
      const children = [];
      for (const nextId of neighbors) {
        const childTree = buildTreeDFS(nextId, new Set(visited), globalSeen);
        if (childTree) children.push(childTree);
      }
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];

      // Virtual root (processor: null, children var)
      return { processor: null, children, nodeId };
    }

    // Bu node'u işaretleme
    visited.add(nodeId);
    globalSeen.add(nodeId);

    // Terminal node (destination)
    if (nodeInfo.terminalType) {
      return {
        processor: null,
        terminalType: nodeInfo.terminalType,
        children: [],
        nodeId
      };
    }

    // Normal processor node
    const treeNode = {
      processor: nodeInfo.processor,
      children: [],
      nodeId
    };

    // Children'ları işle
    const neighbors = edges.get(nodeId) || [];
    for (const nextId of neighbors) {
      const childTree = buildTreeDFS(nextId, new Set(visited), globalSeen);
      if (childTree) {
        treeNode.children.push(childTree);
      }
    }

    return treeNode;
  };

  // Her start node için tree oluştur
  const globalSeen = new Set();
  const trees = [];

  for (const startId of startIds) {
    const tree = buildTreeDFS(startId, new Set(), globalSeen);
    if (tree) trees.push(tree);
  }

  if (trees.length === 0) return null;
  if (trees.length === 1) return trees[0];

  // Birden fazla start node - virtual root ile birleştir
  return { processor: null, children: trees, nodeId: null };
}

/**
 * ProcessorTree'yi flat processor array'e dönüştür
 * extractProcessingInfo() için gerekli (Processing/Effects text hesaplama)
 *
 * @param {ProcessorTreeNode} tree - Tree yapısı
 * @returns {Array} - Flat processor array
 */
export function flattenProcessorTree(tree) {
  if (!tree) return [];

  const processors = [];
  const visited = new Set();

  const traverse = (node) => {
    if (!node) return;

    // Cycle/duplicate prevention
    if (node.nodeId && visited.has(node.nodeId)) return;
    if (node.nodeId) visited.add(node.nodeId);

    // Processor varsa ekle
    if (node.processor) {
      processors.push(node.processor);
    }

    // Children'ları traverse et
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  };

  traverse(tree);
  return processors;
}

/**
 * Extract Processing and Effects info from processors
 * OCP: AUDIO_NODE_DISPLAY_MAP ve getEffectNodeTypes() kullanır
 */
export function extractProcessingInfo(mainProcessors, monitors) {
  let processingText = '';
  let effectsText = '';

  const worklet = mainProcessors.find(p => p.type === 'audioWorkletNode');
  const scriptProc = mainProcessors.find(p => p.type === 'scriptProcessor');

  if (worklet) {
    const procName = worklet.processorName || 'processor';
    const shortName = formatWorkletName(procName);
    processingText = `Worklet(${shortName})`;
  } else if (scriptProc) {
    processingText = 'ScriptProcessor';
  }

  // OCP: Merkezi config'den effect label'larını al (lazy evaluation)
  const effectNodeTypes = getEffectNodeTypes();
  const effectNodes = mainProcessors
    .filter(p => {
      if (!effectNodeTypes.includes(p.type)) return false;

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
 * @param {Array|Object|null} contexts - AudioContext data
 * @param {Object} options - Rendering options (OCP: config object pattern)
 * @param {Object|null} options.audioConnections - Audio connection graph data
 * @param {Object|null} options.detectedEncoder - Detected encoder data (for node-level tracking)
 * @param {Object|null} options.mediaRecorder - MediaRecorder data (for audioSource check)
 * @param {Object|null} options.recordingActive - Recording state data
 */
export function renderACStats(contexts, options = {}) {
  const {
    audioConnections = null,
    detectedEncoder = null,
    mediaRecorder = null,
    recordingActive = null
  } = options;
  const container = document.getElementById('acContent');
  const timestamp = document.getElementById('acTimestamp');

  if (!contexts || (Array.isArray(contexts) && contexts.length === 0)) {
    container.innerHTML = '<div class="no-data">No context</div>';
    timestamp.textContent = '';
    return;
  }

  let contextArray = Array.isArray(contexts) ? contexts : [contexts];
  contextArray = filterOutgoingContexts(contextArray, audioConnections);

  if (contextArray.length === 0) {
    container.innerHTML = '<div class="no-data">No outgoing audio</div>';
    timestamp.textContent = '';
    return;
  }

  if (contextArray.length > MAX_AUDIO_CONTEXTS) {
    contextArray = contextArray.slice(0, MAX_AUDIO_CONTEXTS);
  }

  const firstCtx = contextArray[0];
  const contextTimestamp = formatTime(firstCtx.static?.timestamp);

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
        ${createTooltip('ⓘ', purpose.tooltip, 'left', true)}
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

    // YENİ: Tree-based rendering dene (paralel branch desteği)
    const processorTree = ctxConnections.length > 0
      ? deriveProcessorTreeFromConnections(ctxConnections, ctx)
      : null;
    debugLog(` 🔍 Audio Path: processorTree=`, processorTree ? 'exists' : 'null');

    const hasInputSource = !!ctx.pipeline?.inputSource;
    const monitors = ctx.pipeline?.processors?.filter(p => p.type === 'analyser') || [];

    // extractProcessingInfo için: tree varsa flatten et, yoksa boş array
    const processorsForInfo = processorTree
      ? flattenProcessorTree(processorTree)
      : [];
    const { processingText, effectsText } = extractProcessingInfo(processorsForInfo, monitors);

    html += `<div class="context-item${index > 0 ? ' context-separator' : ''}">`;

    const latencyTooltip = `Base ${(baseLatency * 1000).toFixed(1)}ms + output ${(outputLatency * 1000).toFixed(1)}ms`;

    const inputLabel = hasInputSource
      ? `${purpose.icon} ${capitalizeFirst(ctx.pipeline?.inputSource || 'unknown')}`
      : '-';

    html += `
      <div class="ac-section ac-section--first">
        <div class="sub-header sub-header--ac">
          <span class="ac-section-title">Context Info</span>
          <span class="timestamp">${contextTimestamp}</span>
        </div>
        <table class="ac-main-table">
          <tbody>
            <tr><td>Input</td><td>${inputLabel}</td></tr>
            <tr><td class="metric-label">Channels</td><td class="metric-value">${formatChannels(ctx.static?.channelCount)}</td></tr>
            <tr><td>State</td><td class="${stateClass}">${ctx.static?.state || '-'}</td></tr>
            <tr><td>${createTooltip('Latency', latencyTooltip, 'left')}</td><td>${latencyMs}</td></tr>
            <tr><td>Processing</td><td>${processingText || 'None'}</td></tr>
            <tr><td>Effects</td><td>${effectsText || 'None'}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    if (processorTree) {
      // Tree göster
      const pipelineTs = formatTime(ctx.pipeline?.timestamp);

      // ═══════════════════════════════════════════════════════════════════════
      // ENCODING LOCATION (Strategy Pattern - encoding-location.js)
      // Dinamik encoding badge lokasyonu - hard-coded mantık yok
      // ═══════════════════════════════════════════════════════════════════════

      // Cache'ten oku (technology change sonrası badge korunması için)
      const cachedEncoding = ctx.contextId ? _encodingInfoCache.get(ctx.contextId) : null;

      // Strategy pattern ile encoding lokasyonunu belirle
      const encodingData = {
        detectedEncoder,
        mediaRecorder,
        recordingActive,
        ctx
      };

      let encodingOutput = deriveEncodingOutput(encodingData, ctxConnections, processorTree);

      // Cache'ten oku eğer yeni tespit yoksa
      if (!encodingOutput && cachedEncoding) {
        debugLog(` 🔍 Encoding cache: READ ctx=${ctx.contextId} (from cache)`);
        encodingOutput = cachedEncoding;
      }

      // Cache'e yaz (yeni tespit varsa)
      if (encodingOutput && ctx.contextId) {
        _encodingInfoCache.set(ctx.contextId, encodingOutput);
        debugLog(` 🔍 Encoding cache: WRITE ctx=${ctx.contextId}, strategy=${encodingOutput.strategyName}`);
      }

      // renderAudioFlow için options formatına dönüştür
      const renderOptions = toRenderOptions(encodingOutput);
      debugLog(` 🔍 Encoding render options:`, renderOptions);

      html += `
        <div class="ac-section">
          <div class="sub-header sub-header--ac">
            <span class="ac-section-title">Audio Path</span>
            <span class="timestamp">${pipelineTs}</span>
          </div>
          ${renderAudioFlow(processorTree, monitors, ctx.pipeline?.inputSource, renderOptions)}
        </div>
      `;
    } else if (hasInputSource) {
      // Input var ama graph yok - hata mesajı
      html += `
        <div class="ac-section">
          <div class="sub-header sub-header--ac">
            <span class="ac-section-title">Audio Path</span>
          </div>
          <div class="no-data">No audio graph data</div>
        </div>
      `;
    }
    // else: hasInputSource da yoksa Audio Path bölümü hiç gösterilmez

    if (ctx.encodingHint) {
      html += `
        <div class="ac-section pcm-processing-section">
          <div class="processing-item">
            <span class="detail-label">⚠️ Processing</span>
            <span class="detail-value">${createTooltip(ctx.encodingHint.hint, 'Raw audio data - not yet encoded')}</span>
          </div>
        </div>`;
    }

    html += `</div>`;
  });

  debugLog(` 🔍 renderACStats: HTML length=${html.length}, container=`, container);
  debugLog(` 🔍 renderACStats: HTML preview (first 500 chars):`, html.substring(0, 500));
  container.innerHTML = html;
  debugLog(` 🔍 renderACStats: DOM updated, container.children.length=`, container.children.length);

  // Clear main card-header timestamp (now shown in sub-headers)
  if (timestamp) timestamp.textContent = '';
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
