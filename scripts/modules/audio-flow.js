/**
 * audio-flow.js - Audio Path Flow/Pipeline Rendering Module
 *
 * Self-contained workflow/pipeline visualization component.
 * Dependencies: helpers.js (escapeHtml, capitalizeFirst, formatWorkletName)
 * CSS: audio-flow.css
 *
 * Contains:
 * - AUDIO_NODE_DISPLAY_MAP: Merkezi node config (connectionType, category, label, tooltip)
 * - mapNodeTypeToProcessorType(): ConnectionType → ProcessorType dönüşümü
 * - isDestinationNodeType(): Destination node kontrolü
 * - getNodeTypesByCategory(): Kategori bazlı node listesi
 * - getEffectNodeTypes(): Effect kategorisindeki node'lar (lazy)
 * - invalidateConnectionTypeCache(): Cache temizleme (yeni node türü eklenirse)
 * - formatProcessorForFlow(): Format processor for flow display
 * - renderAudioFlow(): Render audio path as workflow pipeline
 * - measureFlowLabels(): Measure label widths for arrow positioning
 *
 * CSS Selectors (FLOW_SELECTORS, FLOW_CLASSES): Regresyon koruması için sabitler
 */

import {
  escapeHtml,
  capitalizeFirst,
  formatWorkletName
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// FLOW SABİTLERİ (CSS ile Senkron)
// ═══════════════════════════════════════════════════════════════════════════════
// Bu değerler CSS (audio-flow.css) ile senkron tutulmalıdır.
// Değişiklik yapılırsa her iki dosya da güncellenmelidir.

const FLOW_DEFAULTS = {
  LABEL_HEIGHT: 14,  // CSS .flow-label { height: 14px } ve line-height: 14px
  FLOW_UNIT: 17,     // CSS .audio-flow { --flow-unit: 17px }
  FLOW_GAP: 3        // CSS .audio-flow { --flow-gap: 3px }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CSS SELECTOR SABİTLERİ (Regresyon Koruması)
// ═══════════════════════════════════════════════════════════════════════════════
// Bu sabitler CSS (audio-flow.css) ile senkron tutulmalıdır.
// Class ismi değişikliği hem CSS hem JS tarafında yapılmalıdır.

const FLOW_SELECTORS = {
  CONTAINER: '.audio-flow',
  NODE_WITH_OUTPUTS: '.flow-node.has-outputs',
  LABEL: '.flow-label',
  LABEL_TEXT: '.flow-label-text',
  OUTPUTS: '.flow-outputs',
  DIRECT_OUTPUT_NODES: ':scope > .flow-node'
};

// CSS Class isimleri (renderNode'da kullanılır)
const FLOW_CLASSES = {
  CONTAINER: 'audio-flow',
  NODE: 'flow-node',
  ROOT: 'flow-root',
  HAS_OUTPUTS: 'has-outputs',
  SPLIT: 'is-split',  // Birden fazla output (dallanma noktası)
  MONITOR: 'flow-monitor',
  ENCODING_NODE: 'encoding-node',  // Node-level encoding indicator
  LABEL: 'flow-label',
  LABEL_TEXT: 'flow-label-text',
  PARAM: 'flow-param',
  OUTPUTS: 'flow-outputs'
};

// ═══════════════════════════════════════════════════════════════════════════════
// TERMINAL NODE LABELS (Encoding Durumuna Göre)
// ═══════════════════════════════════════════════════════════════════════════════
// Terminal node (destination) label'ları:
// - Encoding aktifse (PCM/WAV, MediaRecorder) → ENCODING label
// - Yoksa → DEFAULT label (speakers output)

const TERMINAL_NODE_LABELS = {
  DEFAULT: 'Speakers',   // Normal playback destination
  ENCODING: 'Encoder'    // When terminal node is doing encoding (PCM/WAV, MediaRecorder)
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO NODE DISPLAY MAPPING (Merkezi Config)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Bu map tüm Audio Node bilgilerini içerir:
// - connectionType: early-inject.js'den gelen PascalCase isim (getNodeTypeName sonucu)
// - category: Node kategorisi (aşağıdaki typedef'e bakın)
// - label: UI'da gösterilecek isim
// - tooltip: Hover bilgisi
// - getParam/getLabel: Dinamik değerler için fonksiyonlar (opsiyonel)
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {'source' | 'effect' | 'analysis' | 'channel' | 'processor' | 'destination'} NodeCategory
 */

/**
 * @typedef {Object} NodeDisplayConfig
 * @property {string} connectionType - early-inject.js'den gelen PascalCase isim
 * @property {NodeCategory} category - Node kategorisi
 * @property {string} label - UI'da gösterilecek varsayılan isim
 * @property {string} tooltip - Hover bilgisi
 * @property {function(Object): string|null} [getParam] - Dinamik parametre değeri
 * @property {function(Object): string} [getLabel] - Dinamik label değeri
 */

/** @type {Object.<string, NodeDisplayConfig>} */
export const AUDIO_NODE_DISPLAY_MAP = {
  // SOURCE NODES
  mediaStreamSource: {
    connectionType: 'MediaStreamAudioSource',
    category: 'source',
    label: 'Microphone',
    tooltip: 'MediaStreamAudioSourceNode'
  },
  mediaElementSource: {
    connectionType: 'MediaElementAudioSource',
    category: 'source',
    label: 'Media Player',
    tooltip: 'MediaElementAudioSourceNode',
    getParam: (proc) => proc.mediaType || null
  },
  bufferSource: {
    connectionType: 'AudioBufferSource',
    category: 'source',
    label: 'Audio Buffer',
    tooltip: 'AudioBufferSourceNode',
    getParam: (proc) => proc.loop ? 'loop' : null
  },
  oscillator: {
    connectionType: 'Oscillator',
    category: 'source',
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
    connectionType: 'ConstantSource',
    category: 'source',
    label: 'DC Offset',
    tooltip: 'ConstantSourceNode'
  },

  // EFFECT / PROCESSING NODES
  gain: {
    connectionType: 'Gain',
    category: 'effect',
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
    connectionType: 'BiquadFilter',
    category: 'effect',
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
    connectionType: 'DynamicsCompressor',
    category: 'effect',
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
    connectionType: 'Convolver',
    category: 'effect',
    label: 'Reverb',
    tooltip: 'ConvolverNode',
    getParam: (proc) => proc.normalize === false ? 'raw' : null
  },
  delay: {
    connectionType: 'Delay',
    category: 'effect',
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
    connectionType: 'WaveShaper',
    category: 'effect',
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
    connectionType: 'StereoPanner',
    category: 'effect',
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
    connectionType: 'Panner',
    category: 'effect',
    label: '3D Panner',
    tooltip: 'PannerNode',
    getParam: (proc) => {
      const modelMap = { 'equalpower': 'EQ', 'HRTF': 'HRTF' };
      return modelMap[proc.panningModel] || null;
    }
  },
  iirFilter: {
    connectionType: 'IIRFilter',
    category: 'effect',
    label: 'IIR Filter',
    tooltip: 'IIRFilterNode'
  },

  // ANALYSIS NODES
  analyser: {
    connectionType: 'Analyser',
    category: 'analysis',
    // Dynamic label based on usageType
    getLabel: (proc) => {
      // usageType: 'spectrum' | 'waveform' | null
      const usageLabels = {
        'spectrum': 'Spectrum',
        'waveform': 'VU Meter'
      };
      return usageLabels[proc.usageType] || 'Analyzer';
    },
    label: 'Analyzer', // Default fallback
    tooltip: 'AnalyserNode',
    getParam: (proc) => {
      // fftSize only meaningful for spectrum analysis
      // VU Meter and Waveform use time domain data, fftSize is irrelevant
      if (proc.usageType === 'spectrum' && proc.fftSize) {
        return `${proc.fftSize}pt`;
      }
      return null;
    }
  },

  // CHANNEL NODES
  channelSplitter: {
    connectionType: 'ChannelSplitter',
    category: 'channel',
    label: 'Splitter',
    tooltip: 'ChannelSplitterNode',
    getParam: (proc) => proc.numberOfOutputs ? `${proc.numberOfOutputs}ch` : null
  },
  channelMerger: {
    connectionType: 'ChannelMerger',
    category: 'channel',
    label: 'Merger',
    tooltip: 'ChannelMergerNode',
    getParam: (proc) => proc.numberOfInputs ? `${proc.numberOfInputs}ch` : null
  },

  // WORKLET / SCRIPT NODES
  audioWorkletNode: {
    connectionType: 'AudioWorklet',
    category: 'processor',
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
    connectionType: 'ScriptProcessor',
    category: 'processor',
    label: 'Processor',
    tooltip: 'ScriptProcessorNode(deprecated)',
    getParam: (proc) => {
      if (proc.bufferSize) {
        return `buffer:${proc.bufferSize}`;
      }
      return null;
    }
  },

  // DESTINATION NODES
  mediaStreamDestination: {
    connectionType: 'MediaStreamAudioDestination',
    category: 'destination',
    label: 'Stream Output',
    tooltip: 'MediaStreamAudioDestinationNode'
  },
  destination: {
    connectionType: 'AudioDestination',
    category: 'destination',
    label: 'Speakers',
    tooltip: 'AudioDestinationNode'
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FONKSIYONLAR (Merkezi Config'den Türetilmiş)
// ═══════════════════════════════════════════════════════════════════════════════

// connectionType → processorType lookup cache (lazy init)
let _connectionTypeMap = null;

function getConnectionTypeMap() {
  if (!_connectionTypeMap) {
    _connectionTypeMap = new Map();
    for (const [processorType, config] of Object.entries(AUDIO_NODE_DISPLAY_MAP)) {
      if (config.connectionType) {
        _connectionTypeMap.set(config.connectionType, processorType);
      }
    }
  }
  return _connectionTypeMap;
}

/**
 * Cache'i invalidate et (runtime'da yeni node türü eklenirse)
 */
export function invalidateConnectionTypeCache() {
  _connectionTypeMap = null;
}

/**
 * Connection type (PascalCase) → Processor type (camelCase) dönüşümü
 * Örnek: 'AudioWorklet' → 'audioWorkletNode'
 */
export function mapNodeTypeToProcessorType(nodeType) {
  if (!nodeType || typeof nodeType !== 'string') return null;

  const map = getConnectionTypeMap();
  const mapped = map.get(nodeType);
  if (mapped) return mapped;

  // Fallback: PascalCase → camelCase dönüşümü
  return nodeType.charAt(0).toLowerCase() + nodeType.slice(1);
}

/**
 * Node type'ın destination olup olmadığını kontrol eder
 * Hem connectionType hem processorType destekler
 */
export function isDestinationNodeType(nodeType) {
  if (!nodeType || typeof nodeType !== 'string') return false;

  // processorType olarak kontrol
  const config = AUDIO_NODE_DISPLAY_MAP[nodeType];
  if (config?.category === 'destination') return true;

  // connectionType olarak kontrol
  const processorType = mapNodeTypeToProcessorType(nodeType);
  const mappedConfig = AUDIO_NODE_DISPLAY_MAP[processorType];
  return mappedConfig?.category === 'destination';
}

/**
 * Belirli kategorideki node type'larını döndürür
 * Örnek: getNodeTypesByCategory('effect') → ['gain', 'biquadFilter', ...]
 */
export function getNodeTypesByCategory(category) {
  return Object.entries(AUDIO_NODE_DISPLAY_MAP)
    .filter(([, config]) => config.category === category)
    .map(([type]) => type);
}

/**
 * Effect kategorisindeki node type'larını döndürür (lazy evaluation)
 * OCP: Runtime'da yeni node eklenirse güncel liste döner
 */
export function getEffectNodeTypes() {
  return getNodeTypesByCategory('effect');
}

/**
 * Input source → Root tooltip mapping (OCP: yeni source türleri buraya eklenir)
 * @type {Object.<string, string>}
 */
const INPUT_SOURCE_TOOLTIPS = {
  microphone: 'MediaStreamAudioSourceNode',
  remote: 'MediaStreamAudioSourceNode (remote)',
  element: 'MediaElementAudioSourceNode',
  buffer: 'AudioBufferSourceNode',
  oscillator: 'OscillatorNode'
};

/**
 * Input source için tooltip döndürür
 * @param {string|null|undefined} inputSource
 * @returns {string}
 */
function getInputSourceTooltip(inputSource) {
  if (!inputSource) return 'AudioSourceNode';
  return INPUT_SOURCE_TOOLTIPS[inputSource] || 'AudioSourceNode';
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLOW FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format processor for flow display
 */
export function formatProcessorForFlow(proc) {
  const mapping = AUDIO_NODE_DISPLAY_MAP[proc.type];

  if (mapping) {
    // Use dynamic getLabel if available, otherwise fallback to static label
    const label = mapping.getLabel ? mapping.getLabel(proc) : mapping.label;
    const param = mapping.getParam ? mapping.getParam(proc) : null;
    return {
      label,
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

// Backward compatibility alias
export const formatProcessorForTree = formatProcessorForFlow;

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO PATH FLOW RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ProcessorTreeNode yapısından display flow node'u oluştur
 * @param {Object} treeNode - deriveProcessorTreeFromConnections() çıktısı
 * @param {Set} nodeIdsSeen - Merge point detection için
 * @param {string|null} encodingNodeId - Node-level encoding indicator
 * @param {string|null} encoderCodec - Encoder codec type for param display
 * @param {boolean} isMediaRecorderEncoding - MediaRecorder terminal encoding flag
 * @returns {Object|null} - Display flow node
 */
function convertProcessorTreeToDisplayFlow(treeNode, nodeIdsSeen, encodingNodeId = null, encoderCodec = null, isMediaRecorderEncoding = false) {
  if (!treeNode) return null;

  // Merge point: Bu nodeId daha önce işlendi
  if (treeNode.nodeId && nodeIdsSeen.has(treeNode.nodeId)) {
    return null;
  }
  if (treeNode.nodeId) {
    nodeIdsSeen.add(treeNode.nodeId);
  }

  // Terminal node (destination)
  if (treeNode.terminalType) {
    // ═══════════════════════════════════════════════════════════════════════
    // DYNAMIC TERMINAL LABEL (Strategy Pattern ile belirlenir)
    // - MediaRecorder encoding: Terminal = "Encoder" (API-level encoding)
    // - Diğer durumlar: Terminal = "Speakers" (connection graph'tan)
    // ═══════════════════════════════════════════════════════════════════════
    const isEncodingAtTerminal = isMediaRecorderEncoding;
    const terminalLabel = isEncodingAtTerminal
      ? TERMINAL_NODE_LABELS.ENCODING
      : TERMINAL_NODE_LABELS.DEFAULT;

    // Debug log: terminal node label seçimi
    console.log('[Audio Flow] Terminal node created:', {
      terminalType: treeNode.terminalType,
      isMediaRecorderEncoding,
      isEncodingAtTerminal,
      terminalLabel
    });

    return {
      label: terminalLabel,
      param: 'output',
      tooltip: treeNode.terminalType === 'encoder'
        ? 'MediaStreamAudioDestinationNode'
        : 'AudioDestinationNode',
      outputs: [],
      isEncodingNode: isEncodingAtTerminal  // CSS styling için
    };
  }

  // Virtual root (processor: null, children var)
  if (!treeNode.processor && treeNode.children && treeNode.children.length > 0) {
    // Output'ları direkt döndür (virtual root'u atla)
    const convertedOutputs = [];
    for (const child of treeNode.children) {
      const converted = convertProcessorTreeToDisplayFlow(child, nodeIdsSeen, encodingNodeId, encoderCodec, isMediaRecorderEncoding);
      if (converted) convertedOutputs.push(converted);
    }
    if (convertedOutputs.length === 0) return null;
    if (convertedOutputs.length === 1) return convertedOutputs[0];

    // Birden fazla output - virtual node olarak döndür
    return { label: null, outputs: convertedOutputs, isVirtual: true };
  }

  // Normal processor node
  if (treeNode.processor) {
    const formatted = formatProcessorForFlow(treeNode.processor);
    const isMonitor = treeNode.processor.type === 'analyser';

    // ═══════════════════════════════════════════════════════════════════════
    // ENCODING NODE DETECTION (Dinamik - Strategy Pattern ile belirlenir)
    // encodingNodeId → encoding-location.js tarafından hesaplanır
    // ═══════════════════════════════════════════════════════════════════════
    const isEncodingNode = encodingNodeId && treeNode.nodeId === encodingNodeId;

    // Encoder codec is shown in Encoder terminal node, not in processor param
    const finalParam = formatted.param;

    const displayNode = {
      label: formatted.label,
      param: finalParam,
      tooltip: formatted.tooltip,
      outputs: [],
      isMonitor,
      isEncodingNode,  // Node-level encoding indicator (for CSS styling)
      nodeId: treeNode.nodeId  // Preserve for debugging
    };

    // Output'ları işle
    if (treeNode.children && treeNode.children.length > 0) {
      for (const child of treeNode.children) {
        const converted = convertProcessorTreeToDisplayFlow(child, nodeIdsSeen, encodingNodeId, encoderCodec, isMediaRecorderEncoding);
        if (converted) {
          // Virtual node ise output'larını ekle
          if (converted.isVirtual && converted.outputs) {
            displayNode.outputs.push(...converted.outputs);
          } else {
            displayNode.outputs.push(converted);
          }
        }
      }
    }

    return displayNode;
  }

  return null;
}

/**
 * Render Audio Path as workflow pipeline with arrow connectors
 *
 * İki input formatını destekler:
 * 1. Array (backward compat): mainProcessors = [{type, nodeId, ...}, ...]
 * 2. ProcessorTreeNode: mainProcessors = {processor, children, terminalType}
 *
 * @param {Array|Object} mainProcessors - Linear array veya ProcessorTreeNode
 * @param {Array} monitors - Analyser node'ları (sadece array mode'da kullanılır)
 * @param {string} inputSource - 'microphone' | 'remote' | etc.
 * @param {Object} options - Rendering options
 * @param {string|null} options.encodingNodeId - Node ID that is doing encoding (highlighted in flow)
 * @param {string|null} options.encoderCodec - Encoder codec type (e.g., 'opus', 'mp3', 'pcm')
 * @param {boolean} options.isMediaRecorderEncoding - MediaRecorder terminal encoding flag
 * @param {Object|null} options.virtualTerminal - Virtual terminal node config (for PCM/WAV)
 * @param {string} options.virtualTerminal.codec - Codec name
 * @param {string} options.virtualTerminal.container - Container format
 */
export function renderAudioFlow(mainProcessors, monitors, inputSource, options = {}) {
  const {
    encodingNodeId = null,
    encoderCodec = null,
    isMediaRecorderEncoding = false,
    virtualTerminal = null
  } = options;

  // Debug log: terminal node label mantığı için
  console.log('[Audio Flow] renderAudioFlow options:', {
    isMediaRecorderEncoding,
    encodingNodeId,
    encoderCodec,
    virtualTerminal,
    inputSource,
    expectedTerminal: isMediaRecorderEncoding ? 'Encoder' : (virtualTerminal ? 'Virtual Encoder' : 'Speakers')
  });

  // Empty check
  const isArray = Array.isArray(mainProcessors);
  const isEmpty = isArray
    ? (!mainProcessors || mainProcessors.length === 0)
    : !mainProcessors;

  if (isEmpty && !inputSource) {
    return '<div class="no-data">No audio path</div>';
  }

  /**
   * ProcessorTreeNode yapısından flow oluştur (yeni mod)
   */
  const buildFromProcessorTree = (processorTree) => {
    const rootLabel = inputSource ? capitalizeFirst(inputSource) : 'Source';
    const rootTooltip = getInputSourceTooltip(inputSource);
    const root = { label: rootLabel, tooltip: rootTooltip, outputs: [], isRoot: true };

    if (!processorTree) return root;

    const nodeIdsSeen = new Set();
    const converted = convertProcessorTreeToDisplayFlow(processorTree, nodeIdsSeen, encodingNodeId, encoderCodec, isMediaRecorderEncoding);

    if (converted) {
      // Virtual node ise output'larını root'a ekle
      if (converted.isVirtual && converted.outputs) {
        root.outputs.push(...converted.outputs);
      } else {
        root.outputs.push(converted);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIRTUAL TERMINAL NODE (PCM/WAV - connection graph'ta destination yok)
    // Strategy pattern ile belirlenen virtualTerminal varsa → sanal Encoder node ekle
    // ═══════════════════════════════════════════════════════════════════════
    if (virtualTerminal && !hasTerminalNode(root)) {
      const lastNode = findLastFlowNode(root);
      if (lastNode) {
        const codecLabel = virtualTerminal.container?.toUpperCase() || virtualTerminal.codec?.toUpperCase() || 'PCM';
        lastNode.outputs.push({
          label: TERMINAL_NODE_LABELS.ENCODING,
          param: codecLabel,
          tooltip: 'Audio encoding output (PCM/WAV)',
          outputs: [],
          isEncodingNode: true,
          isVirtualTerminal: true
        });
        console.log('[Audio Flow] Virtual terminal added:', codecLabel);
      }
    }

    return root;
  };

  /**
   * Flow tree'de terminal node var mı kontrol et
   */
  const hasTerminalNode = (node) => {
    if (!node) return false;
    if (node.outputs && node.outputs.length === 0 && !node.isRoot && !node.isMonitor) {
      // Leaf node (output yok) ve monitor değil → potential terminal
      return true;
    }
    if (node.outputs) {
      return node.outputs.some(child => hasTerminalNode(child));
    }
    return false;
  };

  /**
   * Flow tree'nin son (leaf) node'unu bul
   * Virtual terminal eklemek için kullanılır (monitor dahil tüm node'lar)
   */
  const findLastFlowNode = (node) => {
    if (!node) return null;

    const allOutputs = node.outputs || [];

    if (allOutputs.length === 0) {
      // Bu node'un output'u yok → bu son node (leaf)
      return node.isRoot ? null : node;
    }

    // İlk output'u takip et (sıralama render sırasında yapılır)
    return findLastFlowNode(allOutputs[0]);
  };

  /**
   * Linear array'den flow oluştur (eski mod - backward compat)
   */
  const buildFromLinearArray = () => {
    const rootLabel = inputSource ? capitalizeFirst(inputSource) : 'Source';
    const rootTooltip = getInputSourceTooltip(inputSource);
    const root = { label: rootLabel, tooltip: rootTooltip, outputs: [], isRoot: true };

    const chainProcessors = (mainProcessors || []).filter(p => p.type !== 'mediaStreamSource');

    let currentParent = root;
    let lastProcessorNode = root;

    chainProcessors.forEach((proc) => {
      const formatted = formatProcessorForFlow(proc);
      const node = {
        label: formatted.label,
        param: formatted.param,
        tooltip: formatted.tooltip,
        outputs: []
      };

      currentParent.outputs.push(node);
      lastProcessorNode = node;
      currentParent = node;
    });

    const encoderNode = {
      label: 'Encoder',
      param: 'output',
      tooltip: null,  // Self-explanatory, no tooltip needed
      outputs: []
    };

    const analyzerNodes = (monitors || []).map((mon) => {
      const formatted = formatProcessorForFlow(mon);
      return {
        label: formatted.label,
        param: formatted.param,
        tooltip: formatted.tooltip,
        outputs: [],
        isMonitor: true
      };
    });

    lastProcessorNode.outputs.push(encoderNode);
    analyzerNodes.forEach(an => lastProcessorNode.outputs.push(an));

    return root;
  };

  // Input tipine göre flow oluştur
  const flow = isArray
    ? buildFromLinearArray()
    : buildFromProcessorTree(mainProcessors);

  const renderNode = (node, isRoot = false) => {
    const hasOutputs = node.outputs && node.outputs.length > 0;
    const isSplitPoint = hasOutputs && node.outputs.length > 1;

    // CSS class'ları sabitlerden al (regresyon koruması)
    const classes = [FLOW_CLASSES.NODE];
    if (isRoot) classes.push(FLOW_CLASSES.ROOT);
    if (hasOutputs) classes.push(FLOW_CLASSES.HAS_OUTPUTS);
    if (isSplitPoint) classes.push(FLOW_CLASSES.SPLIT);
    if (node.isMonitor) classes.push(FLOW_CLASSES.MONITOR);
    if (node.isEncodingNode) classes.push(FLOW_CLASSES.ENCODING_NODE);

    // Label ve param ayrı elementler - JS ölçümü için gerekli
    // Guard: Virtual node'larda label null olabilir
    const labelHtml = node.label
      ? `<span class="${FLOW_CLASSES.LABEL_TEXT}">${escapeHtml(node.label)}</span>`
      : '';
    const paramHtml = node.param
      ? `<span class="${FLOW_CLASSES.PARAM}">(${escapeHtml(node.param)})</span>`
      : '';
    // Encoding badge: encoding yapan node'un yanına ← Encoder göster
    // Badge sadece label "Encoder" olmayan node'lar için
    // (Terminal node label="Encoder" olduğunda badge gereksiz - çift gösterim önlenir)
    const showEncoderBadge = node.isEncodingNode && node.label !== TERMINAL_NODE_LABELS.ENCODING;
    const encoderBadgeHtml = showEncoderBadge
      ? '<span class="encoder-badge">Encoder</span>'
      : '';

    const hasValidTooltip = node.tooltip && String(node.tooltip).trim().length > 0;
    const labelClass = hasValidTooltip ? `${FLOW_CLASSES.LABEL} flow-tooltip` : FLOW_CLASSES.LABEL;
    const tooltipAttr = hasValidTooltip ? ` data-tooltip="${escapeHtml(node.tooltip)}"` : '';

    let html = `<div class="${classes.join(' ')}">`;
    html += `<span class="${labelClass}"${tooltipAttr}>${labelHtml}${paramHtml}${encoderBadgeHtml}</span>`;

    if (hasOutputs) {
      // Outputs sıralaması: ana akış önce, monitorlar sona
      // Bu sayede split point'te dikey akış doğru dalı takip eder
      const sortedOutputs = [...node.outputs].sort((a, b) => {
        // 1. Monitor node'lar (VU Meter, Spectrum) HER ZAMAN sona
        // Bu check önce yapılmalı - monitor node'lar yan dal olarak gösterilmeli
        if (a.isMonitor && !b.isMonitor) return 1;
        if (!a.isMonitor && b.isMonitor) return -1;

        // 2. hasOutputs olanlar önce (destination'a giden yol)
        const aHasOutputs = a.outputs && a.outputs.length > 0;
        const bHasOutputs = b.outputs && b.outputs.length > 0;
        if (aHasOutputs && !bHasOutputs) return -1;
        if (!aHasOutputs && bHasOutputs) return 1;

        return 0; // Aynı öncelik - orijinal sıra korunur
      });

      html += `<div class="${FLOW_CLASSES.OUTPUTS}">`;
      sortedOutputs.forEach(output => {
        html += renderNode(output, false);
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  };

  return `<div class="${FLOW_CLASSES.CONTAINER}">${renderNode(flow, true)}</div>`;
}

// Backward compatibility alias
export const renderAudioPathTree = renderAudioFlow;

// ═══════════════════════════════════════════════════════════════════════════════
// FLOW LABEL MEASUREMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Root node'un label merkez pozisyonunu ölçer ve container'a CSS variable olarak set eder.
 * Tüm dikey oklar bu değeri kullanarak aynı dikey hizada kalır.
 *
 * Called after DOM render via requestAnimationFrame in popup.js
 *
 * Formül:
 * - mainArrowLeft = Math.floor(labelText center) → Tüm okların X pozisyonu
 *
 * ⚠️ Math.floor: Tutarlılık için HEP Math.floor kullan
 */
export function measureFlowLabels() {
  const container = document.querySelector(FLOW_SELECTORS.CONTAINER);
  if (!container) return;

  // DPI bilgisi (debug için korundu)
  console.log('[Audio Flow] devicePixelRatio:', window.devicePixelRatio);

  // Root node'u bul (.flow-root class'ı olan)
  const rootNode = container.querySelector('.flow-node.flow-root');
  if (!rootNode) return;

  const rootLabelText = rootNode.querySelector(FLOW_SELECTORS.LABEL_TEXT);
  if (!rootLabelText) return;

  // Root label-text merkez pozisyonunu hesapla
  const labelTextRect = rootLabelText.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // Container'a göre relatif pozisyon
  const labelTextLeft = labelTextRect.left - containerRect.left;
  const labelTextWidth = labelTextRect.width;

  // Ok pozisyonu = root label-text merkezi (tam piksel)
  const center = labelTextLeft + (labelTextWidth / 2);
  const mainArrowLeft = Math.floor(center);

  // Container'a set et - tüm child node'lar bu değeri inherit eder
  container.style.setProperty('--main-arrow-left', `${mainArrowLeft}px`);
}

// Backward compatibility alias
export const measureTreeLabels = measureFlowLabels;
