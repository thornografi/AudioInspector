# Stream Registry

Mikrofon (giden) ve remote (gelen) stream'lerini ayırt etmek için collector'lar arası koordinasyon.

## Registry Yapısı

```javascript
// src/core/constants.js
export const streamRegistry = {
  microphone: new Set(),  // getUserMedia stream ID'leri
  remote: new Set()       // RTCPeerConnection remote stream ID'leri
};
```

## Veri Akışı

```
getUserMedia() → streamRegistry.microphone.add(stream.id)
                      ↓
RTCPeerConnection.ontrack → streamRegistry.remote.add(stream.id)
                      ↓
createMediaStreamSource() → registry lookup → inputSource
                      ↓
popup.js → filterOutgoingContexts() → sadece 'microphone' göster
```

## GetUserMediaCollector Kullanımı

```javascript
// Stream kaydet
streamRegistry.microphone.add(stream.id);

// Cleanup (memory leak önleme)
audioTrack.addEventListener('ended', () => {
  streamRegistry.microphone.delete(stream.id);
});
```

## RTCPeerConnectionCollector Kullanımı

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

## AudioContextCollector - inputSource Belirleme

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

## inputSource Değerleri

| Değer | Açıklama | UI'da |
|-------|----------|-------|
| `'microphone'` | getUserMedia stream | ✅ Göster (giden) |
| `'remote'` | RTCPeerConnection stream | ❌ Gizle (gelen) |
| `'unknown'` | Fallback kullanıldı | Fallback sonucuna göre |

## UI Filtreleme (popup.js)

**filterOutgoingContexts(contexts):**
- Mic Input + Stream Output → her zaman göster
- VU Meter, Page Audio → sadece running veya son 5sn içinde oluşturulmuş

**getContextPurpose(ctx):**

| Koşul | Label | Icon |
|-------|-------|------|
| microphone + MediaStreamDestination | Audio Capture | 🎙️ |
| microphone | Mic Input | 🎤 |
| MediaStreamDestination | Stream Output | 📡 |
| pipeline'da analyser | VU Meter | 📊 |
| Hiçbiri | Page Audio | 🎵 |

## Stop'ta Registry Temizleme

```javascript
// GetUserMediaCollector.stop()
async stop() {
  this.active = false;
  this.activeStreams.clear();
  streamRegistry.microphone.clear();
}

// RTCPeerConnectionCollector.stop()
async stop() {
  await this.stopPolling();
  this.peerConnections.clear();
  this.previousStats.clear();
  streamRegistry.remote.clear();
}
```
