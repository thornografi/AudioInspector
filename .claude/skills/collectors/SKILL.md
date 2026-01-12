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
| AudioContextCollector | `new AudioContext()`, `createScriptProcessor()`, `createMediaStreamDestination()`, `createAnalyser()`, `AudioWorklet.addModule()`, Worker.postMessage (WASM) | `src/collectors/AudioContextCollector.js` |
| MediaRecorderCollector | `new MediaRecorder()` | `src/collectors/MediaRecorderCollector.js` |

## Base Class'lar

| Class | Amaç | Dosya |
|-------|------|-------|
| BaseCollector | Event emit, lifecycle | `src/collectors/BaseCollector.js` |
| PollingCollector | Periyodik veri toplama | `src/collectors/PollingCollector.js` |

## Yeni Collector Ekleme

### 1. BaseCollector'dan Türet

```javascript
// src/collectors/MyCollector.js
import BaseCollector from './BaseCollector.js';
import { hookConstructor } from '../core/utils/ApiHook.js';

class MyCollector extends BaseCollector {
  constructor(options = {}) {
    super('my-collector', options);
  }

  async initialize() {
    // API'leri hook et
  }

  async start() {
    this.active = true;
  }

  async stop() {
    this.active = false;
  }
}
```

### 2. PageInspector'a Ekle

```javascript
// src/page/PageInspector.js
this.collectors = [..., new MyCollector()];
```

## ApiHook Fonksiyonları

`src/core/utils/ApiHook.js`:

| Fonksiyon | Ne Zaman |
|-----------|----------|
| `hookConstructor(target, prop, onInstance, shouldHook)` | `new X()` çağrıları |
| `hookAsyncMethod(target, prop, onResult, shouldHook)` | Promise dönen metodlar |
| `hookMethod(target, prop, onCall, shouldHook)` | Senkron metodlar |

### Örnek

```javascript
hookConstructor(window, 'RTCPeerConnection', (pc, args) => {
  this.emit('data', { type: 'pc_created', config: args[0] });
}, () => this.active);
```

## DATA_TYPES Sabitleri

`src/core/constants.js` dosyasında tanımlı sabitler. Emit ederken **magic string yerine sabit kullan**:

| Sabit | Değer | Açıklama |
|-------|-------|----------|
| `DATA_TYPES.RTC_STATS` | `'rtc_stats'` | WebRTC istatistikleri |
| `DATA_TYPES.USER_MEDIA` | `'userMedia'` | getUserMedia sonuçları |
| `DATA_TYPES.AUDIO_CONTEXT` | `'audioContext'` | AudioContext metadata |
| `DATA_TYPES.AUDIO_WORKLET` | `'audioWorklet'` | AudioWorklet module bilgisi |
| `DATA_TYPES.MEDIA_RECORDER` | `'mediaRecorder'` | MediaRecorder bilgisi |
| `DATA_TYPES.PLATFORM_DETECTED` | `'platform_detected'` | Platform tespiti |

## DESTINATION_TYPES Sabitleri

AudioContext output hedefleri için:

| Sabit | Değer | Açıklama |
|-------|-------|----------|
| `DESTINATION_TYPES.SPEAKERS` | `'speakers'` | Default ctx.destination |
| `DESTINATION_TYPES.MEDIA_STREAM` | `'MediaStreamDestination'` | MediaRecorder'a yönlendirme |

## UI_LIMITS Sabitleri

UI görüntüleme limitleri:

| Sabit | Değer | Açıklama |
|-------|-------|----------|
| `UI_LIMITS.MAX_AUDIO_CONTEXTS` | `4` | Aynı anda gösterilecek max AudioContext |

### Kullanım

```javascript
import { EVENTS, DATA_TYPES } from '../core/constants.js';

// ✅ Doğru - sabit kullan
this.emit(EVENTS.DATA, {
  type: DATA_TYPES.AUDIO_WORKLET,
  timestamp: Date.now(),
  moduleUrl: url
});

// ❌ Yanlış - magic string
this.emit(EVENTS.DATA, {
  type: 'audioWorklet',  // Değişirse 3 dosyayı kırar
  ...
});
```

## Lifecycle

```
initialize() → start() → [emit('data')] → stop()
```

## Early Hook System

API'ler PageInspector'dan önce yaratılabilir. Bu durumda `src/core/utils/EarlyHook.js` kullanılır.

### Constructor Hooks (Proxy)

```javascript
// EarlyHook.js - createConstructorHook() factory
createConstructorHook({
  globalName: 'AudioContext',
  registryKey: 'audioContexts',
  handlerName: '__audioContextCollectorHandler',
  extractMetadata: (ctx) => ({ instance: ctx, sampleRate: ctx.sampleRate })
});
```

### Worker.postMessage Hook (WASM Encoder)

opus-recorder ve benzeri WASM encoder'ları tespit eder. İki farklı message pattern'i desteklenir:

```javascript
// EarlyHook.js - installEarlyHooks() içinde
Worker.prototype.postMessage = function(message, ...args) {
  let encoderInfo = null;

  // Pattern 1: Direct format (opus-recorder)
  // { command: 'init', encoderSampleRate: 48000, encoderBitRate: 128000, ... }
  if (message.command === 'init' && message.encoderSampleRate) {
    encoderInfo = {
      type: 'opus',
      sampleRate: message.encoderSampleRate,
      bitRate: message.encoderBitRate || 0,
      channels: message.numberOfChannels || 1,
      application: message.encoderApplication,
      timestamp: Date.now(),
      pattern: 'direct'
    };
  }

  // Pattern 2: Nested config format (örn: WhatsApp, Discord)
  // { type: "message", message: { command: "encode-init", config: { ... } } }
  else if (message.type === 'message' &&
           message.message?.command === 'encode-init' &&
           message.message?.config) {
    const config = message.message.config;
    encoderInfo = {
      type: 'opus',
      sampleRate: config.encoderSampleRate || config.sampleRate || 0,
      bitRate: config.bitRate || config.encoderBitRate || 0,
      channels: config.numberOfChannels || 1,
      application: config.encoderApplication || 2048,
      originalSampleRate: config.originalSampleRate,
      frameSize: config.encoderFrameSize,
      bufferLength: config.bufferLength,
      timestamp: Date.now(),
      pattern: 'nested'
    };
  }

  if (encoderInfo) {
    window.__wasmEncoderDetected = encoderInfo;
    window.__wasmEncoderHandler?.(encoderInfo);
  }
  return originalPostMessage.apply(this, [message, ...args]);
};
```

**Pattern'ler:**
- **Direct:** opus-recorder library standart formatı
- **Nested:** WhatsApp, Discord gibi platformların özel formatı

### Late-Discovery Pattern

Hook, collector initialize olmadan ÖNCE tetiklenebilir. Bu durumda:

1. **EarlyHook.js:** Veriyi global değişkene kaydet (`window.__*Detected`)
2. **Collector.initialize():** Handler kaydet + mevcut veriyi kontrol et

```javascript
// AudioContextCollector.js - initialize() sonunda
window.__wasmEncoderHandler = (info) => this._handleWasmEncoder(info);

// Late-discovery: handler'dan önce tespit edilmişse
if (window.__wasmEncoderDetected) {
  this._handleWasmEncoder(window.__wasmEncoderDetected);
}
```

### Global Handler Pattern

| Global | Collector | Amaç |
|--------|-----------|------|
| `__audioContextCollectorHandler` | AudioContextCollector | Yeni AudioContext |
| `__rtcPeerConnectionCollectorHandler` | RTCPeerConnectionCollector | Yeni PeerConnection |
| `__mediaRecorderCollectorHandler` | MediaRecorderCollector | Yeni MediaRecorder |
| `__wasmEncoderHandler` | AudioContextCollector | WASM encoder tespiti |
