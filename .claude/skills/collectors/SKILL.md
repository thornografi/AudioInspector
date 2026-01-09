---
name: collectors
description: "Collector yazma rehberi. API hooking, veri toplama, event emission. Anahtar kelimeler: collector, hook, rtcpeerconnection, getusermedia, audiocontext, mediarecorder, polling, getstats, emit, yeni collector"
---

# Collector Yazma Rehberi

WebRTC/Audio API'lerini hook edip veri toplayan modüller.

## Mevcut Collector'lar

| Collector | Hook Edilen API | Dosya |
|-----------|-----------------|-------|
| RTCPeerConnectionCollector | `new RTCPeerConnection()` | `src/collectors/RTCPeerConnectionCollector.js` |
| GetUserMediaCollector | `navigator.mediaDevices.getUserMedia()` | `src/collectors/GetUserMediaCollector.js` |
| AudioContextCollector | `new AudioContext()`, `createScriptProcessor` | `src/collectors/AudioContextCollector.js` |
| MediaRecorderCollector | `new MediaRecorder()` | `src/collectors/MediaRecorderCollector.js` |

## Base Class'lar

| Class | Amaç | Dosya |
|-------|------|-------|
| BaseCollector | Temel collector (event emit, lifecycle) | `src/collectors/BaseCollector.js` |
| PollingCollector | Periyodik veri toplama (getStats) | `src/collectors/PollingCollector.js` |

**PollingCollector:** `BaseCollector`'dan türer, `startPolling()`/`stopPolling()` metodları sağlar. RTCPeerConnectionCollector bunu kullanır.

## Yeni Collector Ekleme

### 1. BaseCollector'dan Türet

```javascript
// src/collectors/MyCollector.js
import BaseCollector from './BaseCollector.js';
import { hookConstructor, hookAsyncMethod, hookMethod } from '../core/utils/ApiHook.js';

class MyCollector extends BaseCollector {
  constructor(options = {}) {
    super('my-collector', options);
  }

  async initialize() {
    // API'leri hook et
  }

  async start() {
    this.active = true;
    // Polling başlat (gerekirse)
  }

  async stop() {
    this.active = false;
    // Cleanup
  }

  getData() {
    return this.collectedData;
  }
}
```

### 2. PageInspector'a Ekle

```javascript
// src/page/PageInspector.js
import MyCollector from '../collectors/MyCollector.js';

this.collectors = [
  // ... mevcut collector'lar
  new MyCollector()
];
```

## ApiHook Fonksiyonları

`src/core/utils/ApiHook.js` modülünü kullan:

| Fonksiyon | Ne Zaman | Örnek |
|-----------|----------|-------|
| `hookConstructor(target, prop, onInstance, shouldHook)` | `new X()` çağrıları | RTCPeerConnection, AudioContext |
| `hookAsyncMethod(target, prop, onResult, shouldHook)` | Promise dönen metodlar | getUserMedia |
| `hookMethod(target, prop, onCall, shouldHook)` | Senkron metodlar | createScriptProcessor |

### Hook Örneği

```javascript
// Constructor hook
hookConstructor(window, 'RTCPeerConnection', (pc, args) => {
  this.peerConnections.add(pc);
  this.emit('data', { type: 'pc_created', config: args[0] });
}, () => this.active);

// Async method hook
hookAsyncMethod(navigator.mediaDevices, 'getUserMedia', (stream, args) => {
  this.emit('data', { type: 'stream_acquired', constraints: args[0] });
}, () => this.active);
```

## Lifecycle

```
initialize() → start() → [collecting...] → stop()
     ↓            ↓            ↓
  Hook API    active=true   emit('data')
```

## Veri Emit Etme

```javascript
this.emit('data', {
  type: 'my_data_type',
  timestamp: Date.now(),
  // ... payload
});
```

PageInspector bu event'i yakalar ve `postMessage` ile iletir.

## Kurallar

1. **ApiHook kullan** - Manuel Proxy/monkey-patch yapma
2. **Error handling** - Hook içinde `try-catch` kullan
3. **Constants** - `src/core/constants.js` sabitlerini kullan
4. **Cleanup** - `stop()` metodunda kaynakları temizle

---

## Early Hook System (Timing Race Condition Fix)

### Problem

API'ler PageInspector initialize'dan **ÖNCE** yaratılabiliyor:

```
T=0ms    → Page loads → AudioContext/RTCPeerConnection created
T=50ms   → content.js loads
T=70ms   → page.js injected
T=100ms  → PageInspector.initialize() → hookConstructor() installed
```

**Sonuç:** Hooks too late, APIs missed.

### Çözüm: Early Hook Installation

`scripts/page.js` yüklenirken **hemen** hook'ları install et:

```javascript
// scripts/page.js
import { installEarlyHooks } from './src/core/utils/EarlyHook.js';

// Install hooks IMMEDIATELY (before PageInspector loads)
installEarlyHooks();

// Then initialize PageInspector
import(entryPoint).then(module => module.autoRun());
```

### Factory Pattern (src/core/utils/EarlyHook.js)

Hook oluşturma DRY violation'ı düzeltildi - factory function kullan:

```javascript
/**
 * Factory function to create constructor hooks with common pattern
 * @param {Object} config - Hook configuration
 * @param {string} config.globalName - Global object name (e.g., 'AudioContext')
 * @param {string} config.registryKey - Key in instanceRegistry (e.g., 'audioContexts')
 * @param {string} config.handlerName - Collector handler name (e.g., '__audioContextCollectorHandler')
 * @param {Function} [config.extractMetadata] - Optional function to extract custom metadata from instance
 * @param {Function} [config.getLogMessage] - Optional function to generate custom log message
 * @param {Function} [config.getOriginal] - Optional function to get original constructor (for aliases)
 */
function createConstructorHook(config) {
  const {
    globalName,
    registryKey,
    handlerName,
    extractMetadata = (instance) => ({ instance, timestamp: Date.now() }),
    getLogMessage = () => `📡 Early hook: ${globalName} created`,
    getOriginal = () => window[globalName]
  } = config;

  const OriginalConstructor = getOriginal();
  if (!OriginalConstructor) {
    logger.warn(LOG_PREFIX.INSPECTOR, `${globalName} not available, skipping hook`);
    return;
  }

  window[globalName] = new Proxy(OriginalConstructor, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);

      // Store instance in registry with custom metadata
      const metadata = extractMetadata(instance, args);
      instanceRegistry[registryKey].push(metadata);

      // Log creation with custom message
      const logMessage = getLogMessage(instance, instanceRegistry[registryKey].length);
      logger.info(LOG_PREFIX.INSPECTOR, logMessage);

      // Notify collector handler if registered
      if (window[handlerName]) {
        window[handlerName](instance, args);
      }

      return instance;
    }
  });

  logger.info(LOG_PREFIX.INSPECTOR, `✅ Hooked ${globalName} constructor`);
}
```

### Hook Installation Examples

```javascript
// AudioContext with custom metadata
createConstructorHook({
  globalName: 'AudioContext',
  registryKey: 'audioContexts',
  handlerName: '__audioContextCollectorHandler',
  getOriginal: () => window.AudioContext || window.webkitAudioContext,
  extractMetadata: (ctx) => ({
    instance: ctx,
    timestamp: Date.now(),
    sampleRate: ctx.sampleRate,
    state: ctx.state
  }),
  getLogMessage: (ctx, count) =>
    `📡 Early hook: AudioContext created (${ctx.sampleRate}Hz, ${ctx.state})\n` +
    `📡 Registry now has ${count} AudioContext(s)`
});

// RTCPeerConnection with defaults
createConstructorHook({
  globalName: 'RTCPeerConnection',
  registryKey: 'rtcPeerConnections',
  handlerName: '__rtcPeerConnectionCollectorHandler'
});

// MediaRecorder with defaults
createConstructorHook({
  globalName: 'MediaRecorder',
  registryKey: 'mediaRecorders',
  handlerName: '__mediaRecorderCollectorHandler'
});
```

### Handler Registration Pattern

Collector'lar `initialize()` metodunda global handler'ı register eder:

```javascript
// AudioContextCollector.js
async initialize() {
  logger.info(this.logPrefix, 'Initializing AudioContextCollector');

  // Register global handler IMMEDIATELY (even before start)
  window.__audioContextCollectorHandler = (ctx, args) => {
    logger.info(this.logPrefix, 'AudioContext constructor called via hook');
    this._handleNewContext(ctx);
  };

  // Note: Early hooks already installed constructor hooks in page.js
  // We skip hookConstructor here to avoid overwriting the early Proxy
  logger.info(this.logPrefix, 'Skipping constructor hook (early hook already installed)');
}
```

**Kritik:** Handler registration `initialize()` içinde yapılır (start() değil), böylece early hook'lar collector start olmasa da handler'ı bulabilir.

### Instance Registry

Early hook yakalanan instance'ları registry'de saklar:

```javascript
const instanceRegistry = {
  audioContexts: [],
  rtcPeerConnections: [],
  audioWorklets: [],
  mediaRecorders: []
};

export function getInstanceRegistry() {
  return instanceRegistry;
}
```

Collector `start()` çağrıldığında registry'deki pre-existing instance'ları emit eder:

```javascript
// AudioContextCollector.js
async start() {
  this.active = true;

  // Emit pre-existing instances from early hook registry
  const registry = getInstanceRegistry();
  if (registry.audioContexts && registry.audioContexts.length > 0) {
    logger.info(this.logPrefix, `Found ${registry.audioContexts.length} pre-existing AudioContext(s) from early hook`);

    for (const { instance, timestamp, sampleRate, state } of registry.audioContexts) {
      this._handleNewContext(instance);
    }
  }

  logger.info(this.logPrefix, 'Started');
}
```

### Benefits

1. **Timing Guaranteed**: Hook'lar API'lerden önce install edilir
2. **DRY Compliance**: Factory pattern ile ~70 satır kod eliminasyonu
3. **OCP Compliance**: Yeni API eklemek sadece config object gerektirir
4. **No Race Condition**: Collector start olmasa bile instance'lar yakalanır
