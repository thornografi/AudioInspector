/**
 * encoding-location.js - Encoding Badge Location Strategy Module
 *
 * OCP (Open-Closed Principle) uyumlu strategy pattern ile encoding badge
 * lokasyonunu belirler. Yeni encoding tipi eklemek için sadece array'e ekleme yeterli.
 *
 * Prensip:
 * - Connection graph = terminal node belirleme (gerçek bağlantılar)
 * - Encoding info = encoding badge belirleme (ayrı kaynak)
 * - İkisi ayrı, birbirini varsaymıyor
 *
 * Dependencies: None (pure logic module)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ENCODING LOCATION STRATEGIES (OCP: Yeni tip = sadece array'e ekle)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} EncodingLocationResult
 * @property {'processor' | 'terminal' | 'virtual-terminal'} location - Badge nerede gösterilecek
 * @property {string|null} nodeId - Processor node ID (location='processor' için)
 * @property {string|null} codec - Codec/format bilgisi
 * @property {string|null} container - Container format
 */

/**
 * @typedef {Object} EncodingLocationStrategy
 * @property {string} name - Strategy adı (debug için)
 * @property {number} priority - Öncelik (yüksek = önce kontrol edilir)
 * @property {function(Object): boolean} detect - Bu strategy uygulanır mı?
 * @property {function(Object, Array, Object): EncodingLocationResult} getLocation - Lokasyon hesapla
 */

/** @type {EncodingLocationStrategy[]} */
export const ENCODING_LOCATION_STRATEGIES = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Priority 10: WASM Encoder (encodingNodeId var)
  // AudioWorklet içinde WASM-based encoding (Opus, MP3, vb.)
  // Badge → processor node'da
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'WasmEncoder',
    priority: 10,
    detect: (data) => {
      if (!data.detectedEncoder?.encodingNodeId) return false;
      // PCM/WAV ise bu strategy değil, PcmPassthrough kullanılmalı
      const codec = (data.detectedEncoder?.codec || '').toLowerCase();
      return codec !== 'pcm' && codec !== 'wav';
    },
    getLocation: (data) => ({
      location: 'processor',
      nodeId: data.detectedEncoder.encodingNodeId,
      codec: data.detectedEncoder?.codec || data.detectedEncoder?.type || null,
      container: data.detectedEncoder?.container || null
    })
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Priority 8: MediaRecorder (synthesized audio source)
  // MediaRecorder API üzerinden encoding
  // Badge → terminal node'da (MediaStreamAudioDestination)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'MediaRecorderSynthesized',
    priority: 8,
    detect: (data) => data.mediaRecorder?.audioSource === 'synthesized',
    getLocation: (data, connections) => ({
      location: 'terminal',
      nodeId: findDestinationNodeId(connections),
      codec: data.mediaRecorder?.mimeType || null,
      container: null
    })
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Priority 5: PCM/WAV Passthrough
  // AudioWorklet buffer toplama → Blob'a yazma
  // Connection graph'ta destination olmayabilir → sanal Encoder node
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'PcmPassthrough',
    priority: 5,
    detect: (data) => {
      const codec = (data.detectedEncoder?.codec || data.detectedEncoder?.type || '').toLowerCase();
      return codec === 'pcm' || codec === 'wav';
    },
    getLocation: (data, connections, tree) => {
      // Graph'ta destination var mı kontrol et
      const hasDestination = hasDestinationInTree(tree);

      return {
        location: hasDestination ? 'processor' : 'virtual-terminal',
        nodeId: hasDestination ? findEncodingProcessorId(tree) : null,
        codec: data.detectedEncoder?.codec || data.detectedEncoder?.type || 'PCM',
        container: data.detectedEncoder?.container || 'WAV'
      };
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Connection array'den destination node ID'sini bul
 * @param {Array} connections - Audio connections
 * @returns {string|null}
 */
function findDestinationNodeId(connections) {
  if (!connections || !Array.isArray(connections)) return null;

  const destConn = connections.find(c =>
    c?.destType === 'MediaStreamAudioDestination' ||
    c?.destType === 'AudioDestination'
  );

  return destConn?.destId || null;
}

/**
 * ProcessorTree'de destination node var mı?
 * @param {Object} tree - ProcessorTreeNode
 * @returns {boolean}
 */
function hasDestinationInTree(tree) {
  if (!tree) return false;

  const checkNode = (node) => {
    if (!node) return false;
    if (node.terminalType) return true; // Terminal found

    if (node.children && node.children.length > 0) {
      return node.children.some(child => checkNode(child));
    }
    return false;
  };

  return checkNode(tree);
}

/**
 * ProcessorTree'den encoding yapan processor'ın ID'sini bul
 * AudioWorklet veya ScriptProcessor tercih edilir
 * @param {Object} tree - ProcessorTreeNode
 * @returns {string|null}
 */
function findEncodingProcessorId(tree) {
  if (!tree) return null;

  let encodingNodeId = null;

  const findProcessor = (node) => {
    if (!node || encodingNodeId) return;

    if (node.processor) {
      const type = (node.processor.type || '').toLowerCase();
      if (type === 'audioworkletnode' || type === 'scriptprocessor' || type === 'audioworklet') {
        encodingNodeId = node.nodeId;
        return;
      }
    }

    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        findProcessor(child);
        if (encodingNodeId) return;
      }
    }
  };

  findProcessor(tree);
  return encodingNodeId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Encoding badge lokasyonunu belirle (Strategy Pattern)
 *
 * @param {Object} data - Tüm gerekli veriler
 * @param {Object|null} data.detectedEncoder - Detected encoder bilgisi
 * @param {Object|null} data.mediaRecorder - MediaRecorder bilgisi
 * @param {Object|null} data.recordingActive - Recording state
 * @param {Object|null} data.ctx - AudioContext verisi
 * @param {Array} connections - Audio node connections
 * @param {Object} tree - ProcessorTreeNode (renderlenmiş ağaç)
 * @returns {EncodingLocationResult|null} - Encoding lokasyonu veya null
 */
export function deriveEncodingOutput(data, connections, tree) {
  // Strategy'leri priority'ye göre sırala (yüksek önce)
  const sortedStrategies = [...ENCODING_LOCATION_STRATEGIES].sort(
    (a, b) => b.priority - a.priority
  );

  // İlk eşleşen strategy'yi bul
  for (const strategy of sortedStrategies) {
    if (strategy.detect(data)) {
      const result = strategy.getLocation(data, connections, tree);
      console.log(`[Encoding Location] Strategy matched: ${strategy.name}`, result);
      return {
        ...result,
        strategyName: strategy.name
      };
    }
  }

  // Hiçbir strategy eşleşmedi
  console.log('[Encoding Location] No strategy matched');
  return null;
}

/**
 * Encoding info'yu renderAudioFlow options formatına dönüştür
 * @param {EncodingLocationResult|null} encodingOutput
 * @returns {Object} - renderAudioFlow options
 */
export function toRenderOptions(encodingOutput) {
  if (!encodingOutput) {
    return {
      encodingNodeId: null,
      encoderCodec: null,
      isMediaRecorderEncoding: false,
      isPcmEncoding: false,
      virtualTerminal: null
    };
  }

  return {
    encodingNodeId: encodingOutput.location === 'processor' ? encodingOutput.nodeId : null,
    encoderCodec: encodingOutput.codec,
    isMediaRecorderEncoding: encodingOutput.strategyName === 'MediaRecorderSynthesized',
    isPcmEncoding: encodingOutput.strategyName === 'PcmPassthrough',
    virtualTerminal: encodingOutput.location === 'virtual-terminal' ? {
      codec: encodingOutput.codec,
      container: encodingOutput.container
    } : null
  };
}
