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
| AudioContextCollector | `new AudioContext()` | `src/collectors/AudioContextCollector.js` |
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

**Detay:** Koda bak → `createConstructorHook()` factory function.
