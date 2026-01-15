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
| AudioContextCollector | `new AudioContext()`, `createScriptProcessor()`, `createMediaStreamSource()`, `createMediaStreamDestination()`, `createAnalyser()`, `AudioWorklet.addModule()`, Worker.postMessage (WASM) | `src/collectors/AudioContextCollector.js` |
| MediaRecorderCollector | `new MediaRecorder()` | `src/collectors/MediaRecorderCollector.js` |

## UI Encoding Section Priority

Popup'ta Encoding bölümünde tek bir encoder gösterilir. Priority:

```
WASM Encoder > WebRTC Codec > MediaRecorder
```

- **WASM:** opus-recorder, Discord/WhatsApp WASM encoder
- **WebRTC:** RTCPeerConnection send codec (audio/opus vb.)
- **MediaRecorder:** Fallback - WASM/WebRTC yoksa gösterilir

> **Not:** MediaRecorder ayrı section değil, Encoding section'da fallback olarak gösterilir.

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

| Fonksiyon | Callback Signature | Ne Zaman |
|-----------|-------------------|----------|
| `hookConstructor(target, prop, onInstance, shouldHook)` | `onInstance(instance, args)` | `new X()` çağrıları |
| `hookAsyncMethod(target, prop, onResult, shouldHook)` | `onResult(result, args, thisArg)` | Promise dönen metodlar |
| `hookMethod(target, prop, onCall, shouldHook)` | `onCall(result, args, thisArg)` | Senkron metodlar |

> **Not:** `thisArg` parametresi prototype method'larda (örn: `AudioWorklet.prototype.addModule`) çağrıyı yapan instance'a erişim sağlar. Bu sayede hangi context'e ait olduğu belirlenebilir.

### Örnek

```javascript
// Constructor hook
hookConstructor(window, 'RTCPeerConnection', (pc, args) => {
  this.emit('data', { type: 'pc_created', config: args[0] });
}, () => this.active);

// Method hook with thisArg (prototype methods)
hookAsyncMethod(AudioWorklet.prototype, 'addModule', (result, args, thisArg) => {
  // thisArg = AudioWorklet instance, thisArg ile parent AudioContext bulunabilir
  const moduleUrl = args[0];
  this._handleWorkletModule(moduleUrl, thisArg);
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
| `DATA_TYPES.WASM_ENCODER` | `'wasmEncoder'` | WASM encoder (opus) bilgisi - bağımsız sinyal |
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

## streamRegistry (Collector Koordinasyonu)

Stream kaynağını (mikrofon vs remote) ayırt etmek için collector'lar arası koordinasyon sağlar.

```javascript
import { streamRegistry } from '../core/constants.js';

export const streamRegistry = {
  microphone: new Set(),  // getUserMedia stream ID'leri
  remote: new Set()       // RTCPeerConnection remote stream ID'leri
};
```

### Veri Akışı

```
getUserMedia() → streamRegistry.microphone.add(stream.id)
RTCPeerConnection.ontrack → streamRegistry.remote.add(stream.id)
createMediaStreamSource() → registry lookup → inputSource = 'microphone' | 'remote'
```

### Kullanım (GetUserMediaCollector)

```javascript
// Stream kaydet
streamRegistry.microphone.add(stream.id);

// Cleanup (memory leak önleme)
audioTrack.addEventListener('ended', () => {
  streamRegistry.microphone.delete(stream.id);
});
```

### Kullanım (RTCPeerConnectionCollector)

```javascript
pc.addEventListener('track', (event) => {
  if (event.track.kind === 'audio') {
    for (const stream of event.streams) {
      streamRegistry.remote.add(stream.id);
    }

    // Cleanup
    event.track.addEventListener('ended', () => {
      for (const stream of event.streams) {
        streamRegistry.remote.delete(stream.id);
      }
    });
  }
});
```

### Kullanım (AudioContextCollector)

```javascript
_handleMediaStreamSource(node, args) {
  const stream = args[0];

  let inputSource = 'unknown';
  if (streamRegistry.microphone.has(stream.id)) {
    inputSource = 'microphone';
  } else if (streamRegistry.remote.has(stream.id)) {
    inputSource = 'remote';
  } else {
    // Fallback: deviceId kontrolü
    const track = stream.getAudioTracks()[0];
    const deviceId = track?.getSettings?.()?.deviceId;
    inputSource = deviceId ? 'microphone' : 'remote';
  }

  ctxData.inputSource = inputSource;
}
```

### inputSource Değerleri

| Değer | Açıklama | UI'da |
|-------|----------|-------|
| `'microphone'` | getUserMedia'dan gelen stream | ✅ Göster (giden ses) |
| `'remote'` | RTCPeerConnection'dan gelen stream | ❌ Gizle (gelen ses) |
| `'unknown'` | Registry'de bulunamadı, fallback kullanıldı | Fallback sonucuna göre |

### Kullanım (constants import)

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
initialize() → start() → [emit('data')] → reEmit() → stop()
```

## reEmit() Pattern

Tüm collector'larda UI yenileme için kullanılır (örn: storage reset sonrası yeni kayıt başladığında).

```javascript
reEmit() {
  if (!this.active) return;

  let emittedCount = 0;
  for (const [item, metadata] of this.activeXXX.entries()) {
    // Skip closed/inactive items
    if (item.state === 'closed' || item.state === 'inactive') continue;

    metadata.state = item.state;
    this.emit(EVENTS.DATA, metadata);
    emittedCount++;
  }

  if (emittedCount > 0) {
    logger.info(this.logPrefix, `Re-emitted ${emittedCount} item(s)`);
  }
}
```

**Tetikleyici:** `RE_EMIT_ALL` mesajı (content.js → page.js)

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

### Method Hooks (Factory Pattern - DRY)

Method hook'ları da factory pattern ile yönetilir. Yeni hook eklemek için sadece config ekle:

```javascript
// EarlyHook.js - METHOD_HOOK_CONFIGS array
const METHOD_HOOK_CONFIGS = [
  {
    methodName: 'createScriptProcessor',
    registryKey: 'scriptProcessor',
    extractMetadata: (args) => ({ bufferSize: args[0], timestamp: Date.now() }),
    getLogMessage: (args) => `📡 Early hook: createScriptProcessor(${args[0]}) captured`
  },
  // Yeni hook eklemek için buraya config ekle
];

// Factory fonksiyonu - tüm prototype'lara uygular (webkit dahil)
function createMethodHook(proto, config, protoName) {
  const { methodName, registryKey, extractMetadata, getLogMessage } = config;
  if (!proto[methodName]) return;

  const original = proto[methodName];
  proto[methodName] = function(...args) {
    const node = original.apply(this, args);
    const entry = instanceRegistry.audioContexts.find(e => e.instance === this);
    if (entry) {
      entry.methodCalls = entry.methodCalls || {};
      entry.methodCalls[registryKey] = extractMetadata(args);
    }
    return node;
  };
}

// installMethodHooks() - webkit + AudioContext'e uygular
const prototypes = [
  { proto: AudioContext.prototype, name: 'AudioContext' },
  { proto: window.webkitAudioContext?.prototype, name: 'webkitAudioContext' }
].filter(p => p.proto);

prototypes.forEach(({ proto, name }) =>
  METHOD_HOOK_CONFIGS.forEach(config => createMethodHook(proto, config, name))
);
```

### Method Call Sync Handlers (AudioContextCollector)

Late capture için registry'deki methodCalls'ı pipeline'a sync eden handler'lar:

```javascript
// AudioContextCollector.js - METHOD_CALL_SYNC_HANDLERS
const METHOD_CALL_SYNC_HANDLERS = {
  scriptProcessor: (data, pipeline) => {
    pipeline.processors.push({ type: 'scriptProcessor', ...data });
  },
  analyser: (data, pipeline) => {
    pipeline.processors.push({ type: 'analyser', ...data });
  },
  mediaStreamSource: (data, pipeline) => {
    pipeline.inputSource = 'microphone';
  },
  mediaStreamDestination: (data, pipeline) => {
    pipeline.destinationType = DESTINATION_TYPES.MEDIA_STREAM;
  }
};

// start() içinde data-driven sync:
Object.entries(methodCalls).forEach(([key, data]) => {
  METHOD_CALL_SYNC_HANDLERS[key]?.(data, ctxData.pipeline);
});
```

**OCP Kazanımı:** Yeni method hook eklemek için:
1. `METHOD_HOOK_CONFIGS`'a config ekle (EarlyHook.js)
2. `METHOD_CALL_SYNC_HANDLERS`'a handler ekle (AudioContextCollector.js)

### Worker.postMessage Hook (WASM Encoder)

opus-recorder ve benzeri WASM encoder'ları tespit eder. **WASM encoder bağımsız sinyal olarak emit edilir** - AudioContext'e bağlanmaz (sampleRate eşleşmesi güvenilir değil). İki farklı message pattern'i desteklenir (yüksek doğruluk için sadece Opus):

```javascript
// EarlyHook.js - installEarlyHooks() içinde
Worker.prototype.postMessage = function(message, ...args) {
  let encoderInfo = null;

  // Pattern 1: Direct format (opus-recorder)
  if (message.command === 'init' && message.encoderSampleRate) {
    encoderInfo = {
      type: 'opus',
      sampleRate: message.encoderSampleRate,
      bitRate: message.encoderBitRate || 0,
      channels: message.numberOfChannels || 1,
      status: 'initialized'  // Track init vs encoding
    };
  }

  // Pattern 2: Nested config format (WhatsApp, Discord)
  else if (message.type === 'message' &&
           message.message?.command === 'encode-init' &&
           message.message?.config) {
    const config = message.message.config;
    encoderInfo = { type: 'opus', sampleRate: config.encoderSampleRate, ... };
  }

  // CRITICAL: Only store if handler is registered (collector active)
  // This prevents stale encoder data from appearing after inspector restart
  if (encoderInfo) {
    if (window.__wasmEncoderHandler) {
      window.__wasmEncoderDetected = encoderInfo;
      window.__wasmEncoderHandler(encoderInfo);
    }
    // If handler not registered, don't store - inspector is stopped
  }

  return originalPostMessage.apply(this, [message, ...args]);
};
```

**Pattern'ler (Sadece Opus - Yüksek Doğruluk):**
- **Direct:** opus-recorder library standart formatı (`command: 'init'` + `encoderSampleRate`)
- **Nested:** WhatsApp, Discord gibi platformların özel formatı (`type: 'message'`, `command: 'encode-init'`)

> **Not:** MP3 (lamejs) ve generic encoder pattern'leri yanlış pozitif riski nedeniyle kaldırıldı.

### Clean Slate Approach (AudioContextCollector)

**Problem:** Tab switch sonrası eski WASM encoder verisi görünüyordu.

**Çözüm:** Start'ta TÜM önceki state temizlenir:

```javascript
// AudioContextCollector.js - start()
async start() {
  this.active = true;

  // CLEAN SLATE
  this.activeContexts.clear();
  this.contextIdCounter = 0;
  cleanupClosedAudioContexts();  // EarlyHook registry'den closed olanları temizle

  // Re-register handler
  window.__wasmEncoderHandler = (info) => this._handleWasmEncoder(info);
  window.__wasmEncoderDetected = null;  // Clear stale detection

  // Sync ONLY running contexts
  const registry = getInstanceRegistry();
  for (const { instance } of registry.audioContexts) {
    if (instance.state !== 'closed') {
      this._handleNewContext(instance, true);
    }
  }
}
```

**Davranış:**
- **Stop:** Veriler korunur (geçmiş kayıt olarak review)
- **Start:** Sıfırdan başla (fresh start)

### EarlyHook.js Yardımcı Fonksiyonlar

| Fonksiyon | Amaç |
|-----------|------|
| `installEarlyHooks()` | Constructor Proxy'leri + Worker.postMessage hook kur |
| `getInstanceRegistry()` | Yakalanan instance'ları döndür |
| `cleanupClosedAudioContexts()` | Registry'den `state=closed` olanları temizle |
| `clearRegistryKey(key)` | Belirli registry key'ini temizle |

### Global Handler Pattern

| Global | Collector | Amaç |
|--------|-----------|------|
| `__audioContextCollectorHandler` | AudioContextCollector | Yeni AudioContext |
| `__rtcPeerConnectionCollectorHandler` | RTCPeerConnectionCollector | Yeni PeerConnection |
| `__mediaRecorderCollectorHandler` | MediaRecorderCollector | Yeni MediaRecorder |
| `__wasmEncoderHandler` | AudioContextCollector | WASM encoder tespiti |

### Stop'ta Handler Temizleme

```javascript
// AudioContextCollector.js - stop()
async stop() {
  this.active = false;

  // CRITICAL: Clear handler to prevent stale data
  window.__wasmEncoderHandler = null;
  window.__wasmEncoderDetected = null;

  // Clean up only closed contexts (keep running ones for next start)
  for (const [ctx] of this.activeContexts.entries()) {
    if (ctx.state === 'closed') this.activeContexts.delete(ctx);
  }
}
```
