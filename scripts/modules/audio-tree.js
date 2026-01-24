/**
 * audio-tree.js - Audio Path Tree Rendering Module
 *
 * Self-contained audio tree visualization component.
 * Dependencies: helpers.js (escapeHtml, capitalizeFirst, formatWorkletName)
 * CSS: audio-tree.css
 *
 * Contains:
 * - AUDIO_NODE_DISPLAY_MAP: Merkezi node config (connectionType, category, label, tooltip)
 * - mapNodeTypeToProcessorType(): ConnectionType → ProcessorType dönüşümü
 * - isDestinationNodeType(): Destination node kontrolü
 * - getNodeTypesByCategory(): Kategori bazlı node listesi
 * - EFFECT_NODE_TYPES: Effect kategorisindeki node'lar
 * - formatProcessorForTree(): Format processor for tree display
 * - renderAudioPathTree(): Render audio path as nested ASCII tree
 * - measureTreeLabels(): Measure label widths for vertical line positioning
 *
 * CSS Selectors (TREE_SELECTORS, TREE_CLASSES): Regresyon koruması için sabitler
 */

import {
  escapeHtml,
  capitalizeFirst,
  formatWorkletName
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CSS SELECTOR SABİTLERİ (Regresyon Koruması)
// ═══════════════════════════════════════════════════════════════════════════════
// Bu sabitler CSS (audio-tree.css) ile senkron tutulmalıdır.
// Class ismi değişikliği hem CSS hem JS tarafında yapılmalıdır.

const TREE_SELECTORS = {
  TREE_CONTAINER: '.audio-tree',
  NODE_WITH_CHILDREN: '.tree-node.has-children',
  LABEL: '.tree-label',
  LABEL_TEXT: '.tree-label-text',
  CHILDREN: '.tree-children',
  DIRECT_CHILD_NODES: ':scope > .tree-node'
};

// CSS Class isimleri (renderNode'da kullanılır)
const TREE_CLASSES = {
  TREE_CONTAINER: 'audio-tree',
  NODE: 'tree-node',
  ROOT: 'tree-root',
  HAS_CHILDREN: 'has-children',
  MONITOR: 'tree-monitor',
  LABEL: 'tree-label',
  LABEL_TEXT: 'tree-label-text',
  PARAM: 'tree-param',
  CHILDREN: 'tree-children'
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
 * Effect kategorisindeki node type'ları (extractProcessingInfo için)
 */
export const EFFECT_NODE_TYPES = getNodeTypesByCategory('effect');

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
// TREE FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format processor for tree display
 */
export function formatProcessorForTree(proc) {
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
    const rootLabel = inputSource ? capitalizeFirst(inputSource) : 'Source';
    const rootTooltip = getInputSourceTooltip(inputSource);
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
      tooltip: null,  // Self-explanatory, no tooltip needed
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

    // CSS class'ları sabitlerden al (regresyon koruması)
    const classes = [TREE_CLASSES.NODE];
    if (isRoot) classes.push(TREE_CLASSES.ROOT);
    if (hasChildren) classes.push(TREE_CLASSES.HAS_CHILDREN);
    if (node.isMonitor) classes.push(TREE_CLASSES.MONITOR);

    // Label ve param ayri elementler - JS olcumu icin gerekli
    const labelHtml = `<span class="${TREE_CLASSES.LABEL_TEXT}">${escapeHtml(node.label)}</span>`;
    const paramHtml = node.param
      ? `<span class="${TREE_CLASSES.PARAM}">(${escapeHtml(node.param)})</span>`
      : '';

    const hasValidTooltip = node.tooltip && String(node.tooltip).trim().length > 0;
    const labelClass = hasValidTooltip ? `${TREE_CLASSES.LABEL} has-tooltip` : TREE_CLASSES.LABEL;
    const tooltipAttr = hasValidTooltip ? ` data-tooltip="${escapeHtml(node.tooltip)}"` : '';

    let html = `<div class="${classes.join(' ')}">`;
    html += `<span class="${labelClass}"${tooltipAttr}>${labelHtml}${paramHtml}</span>`;

    if (hasChildren) {
      html += `<div class="${TREE_CLASSES.CHILDREN}" style="--parent-chars: ${charCount}">`;
      node.children.forEach(child => {
        html += renderNode(child, false);
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  };

  return `<div class="${TREE_CLASSES.TREE_CONTAINER}">${renderNode(tree, true)}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TREE LABEL MEASUREMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tree node'larinin label genisliklerini olcer ve CSS variable olarak set eder.
 * Dikey cizginin label ortasindan cikmasi icin gerekli.
 *
 * Called after DOM render via requestAnimationFrame in popup.js
 */
export function measureTreeLabels() {
  // --tree-unit degerini CSS'den oku (DRY: audio-tree.css ile senkron)
  const audioTree = document.querySelector(TREE_SELECTORS.TREE_CONTAINER);
  const treeUnit = audioTree
    ? parseFloat(getComputedStyle(audioTree).getPropertyValue('--tree-unit')) || 16
    : 16;

  // Selector sabitleri kullan (regresyon koruması)
  const treeNodes = document.querySelectorAll(TREE_SELECTORS.NODE_WITH_CHILDREN);

  treeNodes.forEach(node => {
    const label = node.querySelector(TREE_SELECTORS.LABEL);
    const labelText = node.querySelector(TREE_SELECTORS.LABEL_TEXT);
    const children = node.querySelector(TREE_SELECTORS.CHILDREN);

    if (labelText && children && label) {
      // 1. Label-text genisligini olc
      const labelTextWidth = labelText.getBoundingClientRect().width;
      const labelTextLeft = labelText.offsetLeft; // Label icindeki pozisyon

      // 2. Govde cizgisi pozisyonu = label-text merkezi (Math.round: subpixel önleme)
      const stemLeft = labelTextLeft + (labelTextWidth / 2);
      label.style.setProperty('--stem-left', `${Math.round(stemLeft)}px`);

      // 3. Children margin = label-text merkezi (Math.round: subpixel önleme)
      const center = labelTextWidth / 2;
      children.style.setProperty('--parent-center', `${Math.round(center)}px`);

      // 4. Dikey cizgi height hesapla (son child'in yatay dal seviyesine kadar)
      const childNodes = children.querySelectorAll(TREE_SELECTORS.DIRECT_CHILD_NODES);
      if (childNodes.length > 0) {
        const lastChild = childNodes[childNodes.length - 1];
        // Son child'in offsetTop + yatay dal seviyesi (tree-unit / 2)
        const lineHeight = lastChild.offsetTop + (treeUnit / 2);
        children.style.setProperty('--vertical-line-height', `${lineHeight}px`);
      }
    }
  });
}
