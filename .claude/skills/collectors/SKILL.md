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
| AudioContextCollector | `new AudioContext()`, `createScriptProcessor()`, `createMediaStreamDestination()`, `AudioWorklet.addModule()`, Worker.postMessage (WASM) | `src/collectors/AudioContextCollector.js` |
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

opus-recorder ve benzeri WASM encoder'ları tespit eder:

```javascript
// EarlyHook.js - installEarlyHooks() içinde
Worker.prototype.postMessage = function(message, ...args) {
  if (message?.command === 'init' && message.encoderSampleRate) {
    window.__wasmEncoderDetected = {
      type: 'opus',
      sampleRate: message.encoderSampleRate,
      bitRate: message.encoderBitRate
    };
    window.__wasmEncoderHandler?.(window.__wasmEncoderDetected);
  }
  return originalPostMessage.apply(this, [message, ...args]);
};
```

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
