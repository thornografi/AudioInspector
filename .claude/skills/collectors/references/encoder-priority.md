# Encoder Priority

UI'da Encoding bölümünde tek encoder gösterilir. Priority sistemi.

## ENCODER_DETECTORS Priority

| Priority | Detector | Kaynak | Güvenilirlik |
|----------|----------|--------|--------------|
| 1 (En yüksek) | WASM Encoder | Worker.postMessage hook | ★★★★★ Kesin |
| 2 | WebRTC | RTCPeerConnection.getStats() | ★★★★☆ Stats API |
| 3 | MediaRecorder | MediaRecorder.mimeType | ★★★★☆ API |
| 4 (En düşük) | ScriptProcessor | AudioContext pipeline | ★★☆☆☆ Heuristic |

**Not:** ScriptProcessor sadece diğer encoder'lar yoksa gösterilir (fallback heuristic).

## ScriptProcessor Encoder Fallback

popup.js'deki `ENCODER_DETECTORS` array'inde ScriptProcessor en sonda. **Tasarım gereği:**
- ScriptProcessor varlığı encoding'i **garanti etmez**
- WAV/MP3'e dönüştürüyor OLABİLİR
- WASM, WebRTC, MediaRecorder kesin tespit yöntemleri öncelikli

## Platform Encoder Kullanımları (2024+)

| Platform | Encoder Yöntemi | ScriptProcessor? |
|----------|-----------------|------------------|
| WhatsApp Web | WASM Worker (Opus) | ❌ Hayır |
| Telegram Web | AudioWorklet + WASM | ❌ Hayır |
| Discord | WebRTC native | ❌ Hayır |
| Eski kayıt siteleri | ScriptProcessor → WAV/MP3 | ✅ Evet |

**Modern platformlar ScriptProcessor kullanmıyor** - deprecated olduğu için yeni projeler AudioWorklet veya WASM Worker tercih ediyor.

## UI DETECTION_LABELS

```javascript
// popup.js - Pattern → UI mapping
// ⚠️ SYNC: EarlyHook.js'de yeni pattern → buraya ekle
const DETECTION_LABELS = {
  'audioworklet-config': { text: 'AudioWorklet (full)', icon: '✓', tooltip: '...' },
  'audioworklet-init': { text: 'AudioWorklet (basic)', icon: '○', tooltip: '...' },
  'audioworklet-deferred': { text: 'AudioWorklet (late)', icon: '◐', tooltip: '...' },
  'direct': { text: 'Worker Hook (full)', icon: '✓', tooltip: '...' },
  'nested': { text: 'Worker Hook (full)', icon: '✓', tooltip: '...' },
  'worker-init': { text: 'Worker Hook (basic)', icon: '○', tooltip: '...' },
  'worker-audio-init': { text: 'Worker (real-time)', icon: '◐', tooltip: '...' },
  'audio-blob': { text: 'Blob (post-hoc)', icon: '◑', tooltip: '...' },
  'unknown': { text: 'Detected', icon: '?', tooltip: '...' }
};
```

## Detection Row Format

UI'da Detection satırı:
- `✓ Full config (via encoder-worklet)` - processorName varsa
- `✓ Direct config (via encoderWorker.min.js)` - encoderPath varsa
- `○ Basic init` - via info yoksa

## Neden Farklı Bilgi Miktarları

- **Full config:** Encoder kütüphanesi zengin config göndermiş (opus-recorder)
- **Basic init:** Sadece temel parametreler
- Kullanıcı "Frame size neden yok?" → tooltip açıklama sağlar
