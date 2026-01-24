# Audio Graph Tracking

`early-inject.js` AudioNode.prototype.connect() hook'u ile audio graph topolojisi.

## Hook Flow

```
Page Load
    │
    ▼
early-inject.js (MAIN world, document_start)
    │
    ├─► AudioNode.connect() hook
    │       │
    │       ├─► __earlyCaptures.connections[] (her zaman)
    │       │
    │       └─► __audioConnectionHandler() (inspector aktifse)
    │
    ├─► AudioWorkletNode constructor hook  ←── VU meter/processor detection
    │       │
    │       ├─► __earlyCaptures.audioWorkletNodes[] (her zaman)
    │       │
    │       └─► __audioWorkletNodeHandler() (inspector aktifse)
    │
    ▼
AudioContextCollector.start()
    │
    ├─► _syncEarlyConnections()  ←── Early capture'ları al
    │       │
    │       └─► _handleAudioConnection(conn, false)  ←── Silent mode
    │
    ├─► _syncEarlyAudioWorkletNodes()  ←── VU meter early capture
    │       │
    │       └─► pipeline.processors'a ekle
    │
    └─► __audioConnectionHandler register  ←── Real-time capture
```

## Duplicate Prevention

`_isConnectionDuplicate()` aynı bağlantıyı tekrar eklemeyi önler:

```javascript
_isConnectionDuplicate(connection) {
  return this.audioConnections.some(existing =>
    existing.sourceId === connection.sourceId &&
    existing.destId === connection.destId &&
    existing.outputIndex === connection.outputIndex &&
    existing.inputIndex === connection.inputIndex
  );
}
```

**Neden gerekli:**
1. Early capture + real-time capture aynı `connect()` için tetiklenebilir
2. `reEmit()` sonrası zaten sync edilmiş bağlantılar

## Early Connection Sync

`_syncEarlyConnections()` inspector başlamadan önce yapılan bağlantıları alır:

```javascript
// start() içinde
this.audioConnections = [];  // Temiz başla
this._syncEarlyConnections();
```

**Özellikler:**
- Sadece tracked context'lere ait bağlantıları filtreler
- Silent mode (`shouldEmit=false`) ile batch emit
- Sync sonrası `__earlyCaptures.connections = []` temizlenir

## _handleAudioConnection

```javascript
_handleAudioConnection(connection, shouldEmit = true)
```

| Parametre | Varsayılan | Açıklama |
|-----------|------------|----------|
| `connection` | - | Bağlantı verisi |
| `shouldEmit` | `true` | `false` = silent add (batch için) |

## Emitted Data

```javascript
{
  type: DATA_TYPES.AUDIO_CONNECTION,
  timestamp,
  connection: { sourceType, sourceId, destType, destId, outputIndex, inputIndex, contextId },
  allConnections: [...]  // Full graph for UI rendering
}
```

## UI Rendering

> **Not:** `renderChain()` fonksiyonu kaldırıldı (v2025.01).
> Audio bağlantıları artık nested tree yapısı ile `renderAudioPathTree()` içinde gösteriliyor.

**Audio Path Tree Rendering:**
- `audio-tree.js` → `renderAudioPathTree(mainProcessors, monitors, inputSource)` fonksiyonu
- `deriveMainChainProcessorsFromConnections()` ile graph'tan ana path çıkarılır (renderers.js)
- `AUDIO_NODE_DISPLAY_MAP` ile node türleri kullanıcı dostu isimlere çevrilir (audio-tree.js)
- `audio-tree.js` → `measureTreeLabels()` ile label genişlikleri ölçülüp CSS variable set edilir
- `peak`, `level`, `meter`, `vu` içeren processor isimleri "VU Meter" olarak etiketlenir

**İlgili Referans:** `architecture/references/ui-states.md` → Pipeline Rendering bölümü

## Session Reset (Auto-Stop)

İkinci kayıt başladığında (`MediaRecorder.start()`) inspector **otomatik durur**.

### Neden Bu Yaklaşım?
- Site mevcut AudioNode'ları yeniden kullanıyor (yeni `createGain()` çağrılmıyor)
- Hook'lar tetiklenmediği için veri temizleme çalışmıyor
- Sonuç: Gain(x6), birikmiş connection'lar gibi stale data

### Çözüm: Auto-Stop
Inspector'ı durdurup kullanıcıya temiz başlatma imkanı ver (Refresh Modal).

### Akış ve sessionCount Mekanizması

**`__recordingState.sessionCount`** kaç kez kayıt başlatıldığını takip eder:

```
1. Sayfa yüklendiğinde:
   - Pipeline kurulur (gain, mediaStreamSource, mediaStreamDestination)
   - __recordingState.sessionCount = 0

2. Inspector başlatıldığında:
   - methodCalls sync edilir → Audio Path: gain

3. Kayıt 1 başlar (sessionCount = 1):
   - MediaRecorder.start() event listener tetiklenir
   - sessionCount++ → 1
   - sessionCount < 2 → AUTO_STOP tetiklenmez
   - Veri toplanmaya devam eder

4. Kayıt 1 durur → Ses işleme (efektler eklenir: convolver, delay)

5. Kayıt 2 başlar (sessionCount = 2):
   - MediaRecorder.start() event listener tetiklenir
   - sessionCount++ → 2
   - sessionCount >= 2 → AUTO_STOP tetiklenir:
     - early-inject.js: postMessage({ type: 'AUTO_STOP_NEW_RECORDING' })
     - content.js: inspectorEnabled = false, autoStoppedReason = 'new_recording'
     - PageInspector: collectors durur
     - UI: Stop state, banner "New recording started"

6. Kullanıcı "Start" → Refresh Modal → Sayfa yenilenir:
   - sessionCount = 0 (fresh state)
   - Temiz başlangıç
```

**Neden sessionCount >= 2?**
- İlk kayıt (sessionCount=1): Normal veri toplama
- İkinci kayıt (sessionCount=2): Site aynı node'ları yeniden kullanıyor, hook tetiklenmiyor → stale data riski
- Sayfa yenilenince sessionCount sıfırlanır → temiz slate

### İlgili Dosyalar
| Dosya | Rol |
|-------|-----|
| `early-inject.js` | MediaRecorder.start() → postMessage |
| `content.js` | AUTO_STOP_NEW_RECORDING handler |
| `popup.js` | Banner mesajı: "new_recording" |
| `AudioContextCollector.js` | Encoder state reset |

### Kod (early-inject.js)
```javascript
instance.addEventListener('start', () => {
  // ... recording state setup ...

  // Signal content.js to stop inspector
  window.postMessage({
    __audioPipelineInspector: true,
    type: 'AUTO_STOP_NEW_RECORDING'
  }, '*');
});
```
