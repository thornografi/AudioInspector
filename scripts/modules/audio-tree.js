/**
 * audio-tree.js - Audio Path Tree Rendering Module
 *
 * Self-contained audio tree visualization component.
 * Dependencies: helpers.js (escapeHtml, capitalizeFirst, formatWorkletName)
 * CSS: audio-tree.css
 *
 * Contains:
 * - AUDIO_NODE_DISPLAY_MAP: Node type to display mapping
 * - formatProcessorForTree(): Format processor for tree display
 * - renderAudioPathTree(): Render audio path as nested ASCII tree
 * - measureTreeLabels(): Measure label widths for vertical line positioning
 */

import {
  escapeHtml,
  capitalizeFirst,
  formatWorkletName
} from './helpers.js';

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

    const classes = ['tree-node'];
    if (isRoot) classes.push('tree-root');
    if (hasChildren) classes.push('has-children');
    if (node.isMonitor) classes.push('tree-monitor');

    // Label ve param ayri elementler - JS olcumu icin gerekli
    const labelHtml = `<span class="tree-label-text">${escapeHtml(node.label)}</span>`;
    const paramHtml = node.param
      ? `<span class="tree-param">(${escapeHtml(node.param)})</span>`
      : '';

    const hasValidTooltip = node.tooltip && String(node.tooltip).trim().length > 0;
    const labelClass = hasValidTooltip ? 'tree-label has-tooltip' : 'tree-label';
    const tooltipAttr = hasValidTooltip ? ` data-tooltip="${escapeHtml(node.tooltip)}"` : '';

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
// TREE LABEL MEASUREMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tree node'larinin label genisliklerini olcer ve CSS variable olarak set eder.
 * Dikey cizginin label ortasindan cikmasi icin gerekli.
 *
 * Called after DOM render via requestAnimationFrame in popup.js
 */
export function measureTreeLabels() {
  const treeNodes = document.querySelectorAll('.tree-node.has-children');

  treeNodes.forEach(node => {
    const label = node.querySelector('.tree-label');
    const labelText = node.querySelector('.tree-label-text');
    const children = node.querySelector('.tree-children');

    if (labelText && children && label) {
      // 1. Label-text genisligini olc
      const labelTextWidth = labelText.getBoundingClientRect().width;
      const labelTextLeft = labelText.offsetLeft; // Label icindeki pozisyon

      // 2. Govde cizgisi pozisyonu = label-text merkezi
      const stemLeft = labelTextLeft + (labelTextWidth / 2);
      label.style.setProperty('--stem-left', `${stemLeft}px`);

      // 3. Children margin = label-text merkezi
      const center = labelTextWidth / 2;
      children.style.setProperty('--parent-center', `${center}px`);

      // 4. Dikey cizgi height hesapla (son child'in yatay dal seviyesine kadar)
      const childNodes = children.querySelectorAll(':scope > .tree-node');
      if (childNodes.length > 0) {
        const lastChild = childNodes[childNodes.length - 1];
        const treeUnit = 16; // --tree-unit CSS degeri
        // Son child'in offsetTop + yatay dal seviyesi (tree-unit / 2)
        const lineHeight = lastChild.offsetTop + (treeUnit / 2);
        children.style.setProperty('--vertical-line-height', `${lineHeight}px`);
      }
    }
  });
}
