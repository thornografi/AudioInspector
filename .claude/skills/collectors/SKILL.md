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
| AudioContextCollector | `new AudioContext()`, node creation, AudioWorklet | `src/collectors/AudioContextCollector.js` |
| MediaRecorderCollector | `new MediaRecorder()` | `src/collectors/MediaRecorderCollector.js` |

## Base Class'lar

| Class | Amaç | Dosya |
|-------|------|-------|
| BaseCollector | Event emit, lifecycle, global handler | `src/collectors/BaseCollector.js` |
| PollingCollector | Periyodik veri toplama (getStats) | `src/collectors/PollingCollector.js` |

## Yeni Collector Ekleme

### 1. BaseCollector'dan Türet

```javascript
// src/collectors/MyCollector.js
import BaseCollector from './BaseCollector.js';
import { EVENTS, DATA_TYPES } from '../core/constants.js';

class MyCollector extends BaseCollector {
  constructor(options = {}) {
    super('my-collector', options);
    this.activeItems = new Map();
  }

  async initialize() {
    // Method hook'ları kur (ApiHook.js)
    // Constructor hook'lar EarlyHook.js'de
  }

  async start() {
    this.active = true;
    // Global handler kaydet
    this.registerGlobalHandler('__myCollectorHandler', (instance) => {
      this._handleNewInstance(instance);
    });
  }

  reEmit() {
    if (!this.active) return;
    for (const [item, metadata] of this.activeItems.entries()) {
      if (item.state === 'closed') continue;
      this.emit(EVENTS.DATA, metadata);
    }
  }

  async stop() {
    this.active = false;
    window.__myCollectorHandler = null;
    this.activeItems.clear();
  }
}
```

### 2. PageInspector'a Ekle

```javascript
// src/page/PageInspector.js
this.collectors = [..., new MyCollector()];
```

## DATA_TYPES Sabitleri

`src/core/constants.js` - **magic string yerine sabit kullan:**

| Sabit | Değer | Açıklama |
|-------|-------|----------|
| `DATA_TYPES.RTC_STATS` | `'rtc_stats'` | WebRTC istatistikleri |
| `DATA_TYPES.USER_MEDIA` | `'userMedia'` | getUserMedia sonuçları |
| `DATA_TYPES.AUDIO_CONTEXT` | `'audioContext'` | AudioContext metadata |
| `DATA_TYPES.AUDIO_WORKLET` | `'audioWorklet'` | AudioWorklet module |
| `DATA_TYPES.MEDIA_RECORDER` | `'mediaRecorder'` | MediaRecorder bilgisi |
| `DATA_TYPES.DETECTED_ENCODER` | `'detectedEncoder'` | Encoder tespiti (WASM, PCM, native) |
| `DATA_TYPES.AUDIO_CONNECTION` | `'audioConnection'` | Audio graph bağlantıları |
| `DATA_TYPES.PLATFORM_DETECTED` | `'platform_detected'` | Platform algılama |

```javascript
// ✅ Doğru
this.emit(EVENTS.DATA, { type: DATA_TYPES.AUDIO_CONTEXT, ... });

// ❌ Yanlış - magic string
this.emit(EVENTS.DATA, { type: 'audioContext', ... });
```

## ApiHook Fonksiyonları

`src/core/utils/ApiHook.js` - **Sadece method hook'ları:**

| Fonksiyon | Signature | Kullanım |
|-----------|-----------|----------|
| `hookAsyncMethod(target, prop, onResult, shouldHook)` | `onResult(result, args, thisArg)` | Promise dönen metodlar |
| `hookMethod(target, prop, onCall, shouldHook)` | `onCall(result, args, thisArg)` | Senkron metodlar |

```javascript
// Prototype method hook - thisArg = instance
hookAsyncMethod(AudioWorklet.prototype, 'addModule', (result, args, thisArg) => {
  const moduleUrl = args[0];
  this._handleWorkletModule(moduleUrl, thisArg);
}, () => this.active);
```

> **Not:** Constructor hook'ları `EarlyHook.js`'de Proxy pattern ile yapılır.

## Lifecycle

```
initialize() → start() → [emit('data')] → reEmit() → stop()
```

## reEmit() Pattern

UI yenileme için mevcut verileri tekrar emit et:

```javascript
reEmit() {
  if (!this.active) return;
  let count = 0;
  for (const [item, metadata] of this.activeItems.entries()) {
    if (item.state === 'closed') continue;
    metadata.state = item.state;
    this.emit(EVENTS.DATA, metadata);
    count++;
  }
  if (count > 0) logger.info(this.logPrefix, `Re-emitted ${count} item(s)`);
}
```

**Tetikleyici:** `RE_EMIT_ALL` mesajı (content.js → page.js)

## registerGlobalHandler (BaseCollector)

```javascript
// ✅ Doğru - helper kullan
this.registerGlobalHandler('__myHandler', (instance) => {
  this._handleNewInstance(instance);
});

// ❌ Eski - direkt atama
window.__myHandler = (instance) => { ... };
```

**Avantajlar:** Merkezi hata yönetimi, loglama, DRY.

## Detaylı Referanslar

- **Early Hook System:** [references/early-hooks.md](references/early-hooks.md)
  - Constructor Proxy pattern
  - Method hook'ları (early-inject.js)
  - Late capture sync
  - Global handler pattern

- **WASM Encoder Detection:** [references/wasm-detection.md](references/wasm-detection.md)
  - Worker.postMessage hook
  - AudioWorklet.port.postMessage hook
  - Pattern priority system
  - Recording duration tracking

- **Stream Registry:** [references/stream-registry.md](references/stream-registry.md)
  - Microphone vs remote stream ayrımı
  - inputSource belirleme
  - UI filtreleme

- **Encoder Priority:** [references/encoder-priority.md](references/encoder-priority.md)
  - UI encoding section priority
  - ENCODER_DETECTORS array
  - Platform encoder kullanımları

- **Audio Graph:** [references/audio-graph.md](references/audio-graph.md)
  - AudioNode.connect hook
  - Connection tracking
  - Graph topology
