# WASM Encoder Detection

WASM encoder'ları tespit mekanizması.

## Terminoloji

| Field | Açıklama | Örnek Değerler |
|-------|----------|----------------|
| **encoder** | Process tipi (generic) | `opus-wasm`, `mp3-wasm`, `pcm` |
| **library** | Underlying C library | `libopus`, `LAME`, `FDK AAC` |
| **codec** | Ses formatı | `opus`, `mp3`, `aac`, `pcm` |
| **container** | Dosya formatı | `ogg`, `webm`, `wav`, `mp3` |

## Desteklenen Codec'ler ve Kütüphaneler

| Codec | Encoder | Library | Container |
|-------|---------|---------|-----------|
| Opus | opus-wasm | libopus | OGG, WebM |
| MP3 | mp3-wasm | LAME | MP3 |
| AAC | aac-wasm | FDK AAC | AAC, MP4 |
| Vorbis | vorbis-wasm | libvorbis | OGG |
| FLAC | flac-wasm | libFLAC | FLAC |
| PCM | pcm | - | WAV |

## ENCODER_KEYWORDS

Worker URL'lerinde encoder tespiti için aranan keyword'ler. **Single source of truth:** `src/core/constants.js`

```javascript
export const ENCODER_KEYWORDS = [
  'encoder', 'opus', 'ogg', 'mp3', 'aac', 'vorbis', 'flac',
  'lame', 'audio', 'media', 'wasm', 'codec', 'voice', 'recorder'
];
```

**Kullanım:** `scripts/early-inject.js` ve `src/core/utils/EarlyHook.js` - Worker oluşturulduğunda URL kontrol edilir.

> **⚠️ Sync:** early-inject.js ES module olmadığı için inline kopya içerir. constants.js değiştiğinde güncelle!

## Worker.postMessage Hook

`EarlyHook.js` ve `early-inject.js` içinde Worker.postMessage intercept:

```javascript
Worker.prototype.postMessage = function(message, ...args) {
  let encoderInfo = null;

  // Pattern 1: Direct (opus-recorder)
  if (message.command === 'init' && message.encoderSampleRate) {
    encoderInfo = {
      type: 'opus',
      sampleRate: message.encoderSampleRate,
      bitRate: message.encoderBitRate || 0,
      channels: message.numberOfChannels || 1,
      pattern: 'direct',
      status: 'initialized'
    };
  }

  // Pattern 2: Nested (WhatsApp, Discord)
  else if (message.type === 'message' &&
           message.message?.command === 'encode-init' &&
           message.message?.config) {
    const config = message.message.config;
    encoderInfo = {
      type: 'opus',
      sampleRate: config.encoderSampleRate,
      pattern: 'nested',
      ...
    };
  }

  // Handler'a bildir (collector aktifse)
  if (encoderInfo && window.__detectedEncoderHandler) {
    window.__detectedEncoderData = encoderInfo;
    window.__detectedEncoderHandler(encoderInfo);
  }

  return originalPostMessage.apply(this, [message, ...args]);
};
```

## AudioWorklet.port.postMessage Hook

AudioWorklet üzerinden encoder tespiti:

```javascript
// Pattern: audioworklet-config
if (message.type === 'config' && message.config?.opus) {
  encoderInfo = {
    type: 'opus',
    pattern: 'audioworklet-config',
    ...message.config.opus
  };
}
```

## Detection Patterns

| Pattern | Kaynak | Bilgiler | Güvenilirlik |
|---------|--------|----------|--------------|
| `audioworklet-config` | AudioWorklet.port | bitrate, frameSize, app | ★★★★★ |
| `audioworklet-init` | AudioWorklet.port | sampleRate, channels | ★★★★☆ |
| `audioworklet-deferred` | Deferred match | Gecikmeli eşleştirme | ★★★☆☆ |
| `direct` | Worker.postMessage | bitrate, channels, app | ★★★★★ |
| `nested` | Worker (nested) | Tüm config | ★★★★★ |
| `worker-init` | Worker (basit) | sampleRate, channels | ★★★☆☆ |
| `worker-audio-init` | Worker (audio) | sampleRate + bufferSize (heuristic) | ★★★☆☆ |
| `audio-blob` | Blob creation | Post-hoc, blobSize, calculatedBitRate | ★★☆☆☆ |

**worker-audio-init:** `{ type: 'init', sampleRate, bufferSize }` pattern - explicit encoder fields yokken audio işleme sinyali.

## Pattern Priority System

Düşük öncelikli pattern'ler yüksek önceliklileri ezemez:

```javascript
const PATTERN_PRIORITY = {
  'audioworklet-config': 5,   // Highest
  'audioworklet-init': 4,
  'audioworklet-deferred': 4,
  'direct': 4,
  'nested': 4,
  'worker-init': 3,
  'worker-audio-init': 3,
  'audio-blob': 2,            // Lowest - post-hoc
  'unknown': 1
};

// Merge logic
if (existingPriority >= newPriority && encoderInfo.pattern === 'audio-blob') {
  // Blob sadece supplementary data ekleyebilir
  if (this.currentEncoderData.codec === 'unknown' && encoderInfo.type) {
    this.currentEncoderData.codec = encoderInfo.type;
  }
  if (encoderInfo.calculatedBitRate && !this.currentEncoderData.bitRate) {
    this.currentEncoderData.bitRate = encoderInfo.calculatedBitRate;
  }
  return; // Overwrite etme
}
```

## Recording Duration Tracking

Bitrate hesabı için kayıt süresi:

```javascript
// early-inject.js
window.__recordingState = {
  startTime: null,
  duration: null
};

instance.addEventListener('start', () => {
  window.__recordingState.startTime = Date.now();
  window.__recordingState.duration = null;

  // Stale encoder data önleme - yeni kayıtta reset
  window.__detectedEncoderData = null;
  if (window.__newRecordingSessionHandler) {
    window.__newRecordingSessionHandler();
  }

  // Recording state'i storage'a bildir (popup için)
  broadcastRecordingState(true);
});

instance.addEventListener('stop', () => {
  if (window.__recordingState.startTime) {
    window.__recordingState.duration = (Date.now() - window.__recordingState.startTime) / 1000;
  }
});
```

## New Recording Session Handler

İkinci kayıt başladığında stale encoder data önleme:

```javascript
// AudioContextCollector.start() içinde kayıt
window.__newRecordingSessionHandler = () => {
  if (this.active) {
    this.currentEncoderData = null;
    logger.info(this.logPrefix, '🔄 New recording session - encoder detection reset');
  }
};

// stop() içinde temizlik
window.__newRecordingSessionHandler = null;
```

**Problem:** Inspector durdurmadan ikinci kayıt başlarsa, eski `currentEncoderData` kalıyordu.
**Çözüm:** MediaRecorder 'start' event'inde collector'a bildirim.

## Blob Bitrate Calculation

```javascript
// Blob hook
const recordingDuration = window.__recordingState?.duration;
if (recordingDuration && recordingDuration > 0) {
  // bitRate = (blobSize * 8) / duration
  calculatedBitRate = Math.round((blobSize * 8) / recordingDuration);
}

encoderInfo = {
  pattern: 'audio-blob',
  blobSize: blobSize,
  recordingDuration: recordingDuration,
  calculatedBitRate: calculatedBitRate
};
```

## EncoderInfo Fields

Tam encoderInfo nesnesi:

```javascript
{
  type: 'opus',              // codec type
  codec: 'opus',             // alias
  encoder: 'opus-wasm',      // process type: opus-wasm, mp3-wasm, pcm, etc.
  library: 'libopus',        // underlying C library: libopus, LAME, FDK AAC, etc.
  container: 'ogg',          // ogg, webm, mp3, aac, flac, wav
  sampleRate: 48000,
  bitRate: 128000,
  channels: 1,
  wavBitDepth: 16,           // PCM/WAV: 16, 24, 32 bit
  frameSize: 20,             // ms (opus-specific)
  application: 2049,         // opus: 2048=VoIP, 2049=Audio, 2051=LowDelay
  applicationName: 'Audio',
  pattern: 'direct',
  source: 'worker-postmessage',
  status: 'initialized',     // initialized | encoding
  timestamp: Date.now(),
  // Worker bilgileri (early-inject.js'den)
  workerFilename: 'encoderWorker.min.js',
  workerUrl: 'https://...',
  workerDomain: 'example.com'
}
```

## Encoder Bağımsızlığı

**ÖNEMLİ:** Encoder (WASM, PCM, native) AudioContext'e **bağlanmaz** - sampleRate eşleştirme güvenilir değil.

- `detected_encoder` ayrı storage key
- UI'da bağımsız sinyal olarak gösterilir
- AudioContext pipeline'ından ayrı
