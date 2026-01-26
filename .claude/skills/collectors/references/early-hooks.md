# Early Hook System

API'ler PageInspector başlamadan ÖNCE kullanılabilir. İki aşamalı hook sistemi bu sorunu çözer.

## Yükleme Sırası

```
1. manifest.json → early-inject.js (MAIN world, document_start)
   └── EN ERKEN: Constructor Proxy'leri
   └── AudioNode.connect(), Worker.postMessage hook'ları
   └── window.__earlyCaptures registry

2. content.js → INJECT_PAGE_SCRIPT → background.js
3. background.js → chrome.scripting.executeScript(page.js)
4. page.js yüklenir:
   a. installEarlyHooks()     ← Fallback Proxy'leri
   b. new PageInspector()
   c. inspector.initialize()  ← Collector handler'ları
   d. inspector.start()       ← __earlyCaptures sync
```

## Constructor Hooks (EarlyHook.js)

Proxy pattern ile constructor intercept:

```javascript
// EarlyHook.js - createConstructorHook()
createConstructorHook({
  globalName: 'AudioContext',
  registryKey: 'audioContexts',
  handlerName: '__audioContextCollectorHandler',
  extractMetadata: (ctx) => ({ instance: ctx, sampleRate: ctx.sampleRate })
});
```

## Method Hooks (early-inject.js)

Instance-level hook'lar, sayfa yüklenmeden ÖNCE:

```javascript
// METHOD_TYPE_MAP - AudioContextCollector handler'larıyla sync
const METHOD_TYPE_MAP = {
  'createMediaStreamSource': 'mediaStreamSource',
  'createMediaStreamDestination': 'mediaStreamDestination',
  'createScriptProcessor': 'scriptProcessor',
  'createAnalyser': 'analyser'
};

// Her AudioContext instance için hook
METHODS_TO_HOOK.forEach(methodName => {
  instance[methodName] = function(...args) {
    capture.methodCalls.push({
      type: METHOD_TYPE_MAP[methodName],
      ...extractMethodArgs(methodName, args),
      timestamp: Date.now()
    });
    return original.apply(this, args);
  };
});
```

## Hook Timing ve Race Condition

**İki katmanlı hook:**

| Katman | Dosya | Kapsam | Ne Zaman |
|--------|-------|--------|----------|
| Instance-level | early-inject.js | Her instance | Sayfa yüklenmeden ÖNCE |
| Prototype-level | EarlyHook.js | Prototype | Sayfa yüklendikten SONRA |

**Her iki katman GEREKLİ:**
- `early-inject.js` sadece kendinden önce oluşturulanları yakalar
- `EarlyHook.js` sonradan oluşturulanlar için fallback
- Stop/start döngüsünde early captures temizlenir, prototype hook'lar kalıcı

**Race Condition Çözümü:**
- `AudioContextCollector.start()` içinde `processedInstances` WeakSet
- Duplicate prevention - aynı instance bir kez işlenir

## Late Capture Sync

`syncEarlyCaptures()` methodCalls array'ini pipeline'a sync eder:

```javascript
// Factory pattern - DRY: Yeni DSP node tek satırla eklenir
const createProcessorHandler = (type, fieldMap = {}) => (data, pipeline) => {
  if (pipeline.processors.some(p => p.type === type && p.timestamp === data.timestamp)) return;
  const entry = { type, timestamp: data.timestamp };
  for (const [field, defaultVal] of Object.entries(fieldMap)) {
    entry[field] = data[field] ?? defaultVal;
  }
  pipeline.processors.push(entry);
};

const METHOD_CALL_SYNC_HANDLERS = {
  // Special handlers (non-processor)
  mediaStreamSource: (data, pipeline) => { pipeline.inputSource = 'microphone'; },
  mediaStreamDestination: (data, pipeline) => { pipeline.destinationType = DESTINATION_TYPES.MEDIA_STREAM; },

  // Processor handlers - OCP: Add new DSP node with single line
  scriptProcessor: createProcessorHandler('scriptProcessor', { bufferSize: 4096, inputChannels: 2, outputChannels: 2 }),
  analyser: createProcessorHandler('analyser'),
  gain: createProcessorHandler('gain'),
  biquadFilter: createProcessorHandler('biquadFilter', { filterType: 'lowpass' }),
  // ... diğer DSP node'lar
};

// start() içinde sync
methodCalls.forEach((call) => {
  const handler = METHOD_CALL_SYNC_HANDLERS[call.type];
  if (handler) handler(call, ctxData.pipeline);
});
```

**OCP:** Yeni method hook için:
1. `METHOD_HOOK_CONFIGS`'a config ekle (EarlyHook.js)
2. `METHOD_CALL_SYNC_HANDLERS`'a tek satır ekle: `myNode: createProcessorHandler('myNode', { field: 'default' })`

## METHOD_HOOK_CONFIGS (EarlyHook.js)

Mevcut hook'lu metodlar:

| registryKey | Method | Ek Bilgiler |
|-------------|--------|-------------|
| `scriptProcessor` | createScriptProcessor | bufferSize, inputChannels, outputChannels |
| `analyser` | createAnalyser | - |
| `mediaStreamSource` | createMediaStreamSource | streamId |
| `mediaStreamDestination` | createMediaStreamDestination | - |
| `gain` | createGain | - |
| `biquadFilter` | createBiquadFilter | filterType |
| `dynamicsCompressor` | createDynamicsCompressor | - |
| `oscillator` | createOscillator | oscillatorType |
| `delay` | createDelay | maxDelayTime |
| `convolver` | createConvolver | (reverb) |
| `waveShaper` | createWaveShaper | oversample |
| `panner` | createPanner | panningModel |

## Global Handler Pattern

EarlyHook constructor hook'ları collector'lara bildirim:

| Global | Collector | Amaç |
|--------|-----------|------|
| `__audioContextCollectorHandler` | AudioContextCollector | Yeni AudioContext |
| `__rtcPeerConnectionCollectorHandler` | RTCPeerConnectionCollector | Yeni PeerConnection |
| `__getUserMediaCollectorHandler` | GetUserMediaCollector | Yeni stream |
| `__mediaRecorderCollectorHandler` | MediaRecorderCollector | Yeni MediaRecorder |
| `__detectedEncoderHandler` | AudioContextCollector | Encoder tespiti (WASM, PCM, native) |
| `__audioWorkletNodeHandler` | AudioContextCollector | Yeni AudioWorkletNode |
| `__audioContextMethodCallHandler` | AudioContextCollector | Real-time method call sync |
| `__audioConnectionHandler` | early-inject.js | AudioNode.connect events |
| `__newRecordingSessionHandler` | AudioContextCollector | Yeni kayıt başladığında encoder reset |

## Stop'ta Handler Temizleme

```javascript
async stop() {
  this.active = false;

  // TÜM handler'ları temizle
  window.__audioContextCollectorHandler = null;
  window.__detectedEncoderHandler = null;
  window.__audioWorkletNodeHandler = null;
  window.__newRecordingSessionHandler = null;
  window.__detectedEncoderData = null;
  window.__audioWorkletEncoderDetected = null;

  this.pendingEncoderData = null;

  // Sadece closed olanları temizle
  for (const [ctx] of this.activeContexts.entries()) {
    if (ctx.state === 'closed') this.activeContexts.delete(ctx);
  }
}
```

## EarlyHook.js Yardımcılar

| Fonksiyon | Amaç |
|-----------|------|
| `installEarlyHooks()` | Constructor Proxy + Worker hook kur |
| `getInstanceRegistry()` | Yakalanan instance'ları döndür |
| `cleanupClosedAudioContexts()` | Registry'den closed olanları temizle |
| `clearRegistryKey(key)` | Belirli registry key'ini temizle |
| `getAnalyserUsageType(node)` | AnalyserNode'un usageType'ını döndür |
| `installAnalyserUsageHooks()` | AnalyserNode method hook'larını kur |

## AnalyserNode Usage Detection

AnalyserNode'ların gerçek kullanım amacını tespit eder (spectrum analyzer vs VU meter).

### Hook Mekanizması

```javascript
// EarlyHook.js - installAnalyserUsageHooks()
// ⚠️ SYNC: Duplicate in early-inject.js - keep both in sync

// Spectrum analysis methods (frequency domain)
const spectrumMethods = ['getByteFrequencyData', 'getFloatFrequencyData'];
// Waveform/VU meter methods (time domain)
const waveformMethods = ['getByteTimeDomainData', 'getFloatTimeDomainData'];

// Hook spectrum methods → markAnalyserUsage(this, 'spectrum')
// Hook waveform methods → markAnalyserUsage(this, 'waveform')
```

### Global State

| Global | Tip | Amaç |
|--------|-----|------|
| `window.__audioInspectorAnalyserUsageMap` | WeakMap | AnalyserNode → usageType mapping |
| `window.__analyserUsageHandler` | Function | Real-time UI güncellemesi |

### Handler Lifecycle

```javascript
// AudioContextCollector.js
start() {
  window.__analyserUsageHandler = (node, usageType) => {
    this._handleAnalyserUsageDetected(node, usageType);
  };
}

stop() {
  window.__analyserUsageHandler = null;  // Cleanup
}
```

### UI'da usageType Kullanımı

```javascript
// audio-flow.js → AUDIO_NODE_DISPLAY_MAP.analyser
analyser: {
  getLabel: (proc) => {
    const usageLabels = {
      'spectrum': 'Spectrum',
      'waveform': 'VU Meter'
    };
    return usageLabels[proc.usageType] || 'Analyzer';
  },
  getParam: (proc) => {
    // fftSize sadece spectrum için anlamlı
    if (proc.usageType === 'spectrum' && proc.fftSize) {
      return `${proc.fftSize}pt`;
    }
    return null;  // VU Meter için parametre gösterme
  }
}
```

### Duplicate Fonksiyonlar (Known Trade-off)

Aşağıdaki fonksiyonlar hem `early-inject.js` hem `EarlyHook.js`'de var:

| Fonksiyon | Neden Duplicate |
|-----------|-----------------|
| `getAnalyserUsageMap()` | IIFE vs ES module timing |
| `markAnalyserUsage()` | Both need access to same WeakMap |

**Değişiklik yaparken HER İKİ DOSYAYI güncelle!**
