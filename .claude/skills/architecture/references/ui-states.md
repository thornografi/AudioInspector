# UI States & Rendering

Popup UI durumları ve rendering pattern'leri.

## Banner Display States

Locked tab info banner 3 durumu gösterir:

| State | Tab | Inspector | Banner Renk | Metin |
|-------|-----|-----------|-------------|-------|
| **Inspecting** | Same | Running | Kırmızı (same-tab) | `Inspecting: domain.com` |
| **Stopped** | Same | Stopped | Yeşil (same-tab) | `Stopped - Data from: domain.com` |
| **Different** | Different | Any | Turuncu (different-tab) | `Different tab - data from: domain.com` |

```javascript
// popup.js
showLockedTabInfo(lockedTab, isSameTab, isRunning);
```

**Helper Functions (SRP):**
- `extractDomain(lockedTab)` - Domain extraction
- `getBannerStatusText(isSameTab, isRunning)` - Status text
- `updateBannerStyle(banner, isSameTab)` - CSS class

## isSystemPage Helper

```javascript
function isSystemPage(url) {
  if (!url) return true;
  return url.startsWith('chrome://') ||
         url.startsWith('chrome-extension://') ||
         url.startsWith('about:') ||
         url.startsWith('file://');
}
```

## hideLockedTabInfo (Async)

System sayfa kontrolü için async:

```javascript
async function hideLockedTabInfo() {
  const banner = document.getElementById('lockedTabBanner');
  const controls = document.querySelector('.controls');
  banner?.classList.remove('visible', 'same-tab', 'different-tab');

  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isSystemPage(currentTab?.url)) {
    controls?.classList.add('disabled');
  } else {
    controls?.classList.remove('disabled');
  }
}
```

## Encoding Section

OCP-compliant `ENCODER_DETECTORS` array pattern.

### DETECTION_LABELS Mapping

Pattern değerlerini UI metne çevirir:

```javascript
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

### Detection Row Format

- `✓ Full config (via encoder-worklet)` - processorName varsa
- `✓ Direct config (via encoderWorker.min.js)` - encoderPath varsa
- `○ Basic init` - via info yoksa

### Frame Size Smart Unit

```javascript
const msValues = [2.5, 5, 10, 20, 40, 60];
const unit = msValues.includes(enc.frameSize) || enc.frameSize < 100 ? 'ms' : 'samples';
// 20 → "20 ms", 960 → "960 samples"
```

## AudioContext Latency

İki bileşenden hesaplanır:

```javascript
const baseLatency = ctx.static?.baseLatency || 0;      // ~10ms
const outputLatency = ctx.static?.outputLatency || 0;  // ~42ms
const totalLatency = baseLatency + outputLatency;      // ~52ms
```

**Tooltip:** "Total output latency (baseLatency: 10.0ms + outputLatency: 42.0ms)"

## Pipeline Rendering

### Chain Display (Vertical)

Dikey format, sağa hizalı, oklar arasında:

```
      Gain(x3)
         ↓
     Convolver
         ↓
    Filter(x4)
         ↓
        Gain
```

**Gruplama Kuralları** (`getProcessorKey()`):
- Ardışık aynı tür işlemciler `(xN)` olarak gruplanır
- BiquadFilter, Oscillator, Delay: Parametre ayrımı **YAPILMAZ** (tümü gruplanır)
- AudioWorkletNode: `processorName`'e göre ayrı gruplanır

**Buffer Size Satırı:** ScriptProcessor varsa Chain'den sonra ayrı satır:

```
Chain       Gain(x3)
               ↓
            ScriptProcessor
Buffer Size 4096
Output      MediaStreamDestination
```

### formatProcessor() Return

Object döndürür (string değil):

```javascript
return {
  name: "Filter(x4)",    // Gruplanmış: count > 1 ise suffix
  params: "",            // Gruplu node'larda parametre yok
  tooltip: "..."         // Detaylar tooltip'te
};
```

### CSS Classes

| Class | Amaç |
|-------|------|
| `.chain-vertical` | Dikey container, sağa hizalı |
| `.chain-node` | Node wrapper (flex) |
| `.chain-node-name` | Node adı + count |
| `.chain-arrow` | Ok (↓), muted renk |

### Gruplanan Node'lar

| Node | Gruplu | Tooltip |
|------|--------|---------|
| Gain | ✓ | - |
| BiquadFilter | ✓ (tümü) | - |
| Oscillator | ✓ (tümü) | - |
| Delay | ✓ (tümü) | - |
| ScriptProcessor | ✓ | Input/Output channels |
| AudioWorkletNode | Sadece aynı processorName | Worklet options |
