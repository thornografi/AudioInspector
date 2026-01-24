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

### Audio Path Tree (Nested)

Nested tree yapısı ile audio path görselleştirmesi:

```
Microphone
    │
    ├── Processor (passthrough)
    │        │
    │        └── Volume (pass)
    │                │
    │                ├── Encoder (output)
    │                │
    │                └── Analyzer (2048pt)
```

**Rendering Flow:**
1. `renderAudioPathTree()` - Ana fonksiyon (renderers.js)
2. `buildNestedTree()` - Pipeline'dan nested yapı oluşturur
3. `renderNode()` - Recursive HTML render
4. `measureTreeLabels()` - JS ile label genişliklerini ölçer (popup.js)

### HTML Yapısı

```html
<div class="audio-tree">
  <div class="tree-node tree-root has-children">
    <span class="tree-label has-tooltip" data-tooltip="...">
      <span class="tree-label-text">Microphone</span>
    </span>
    <div class="tree-children" style="--parent-center: 45px">
      <div class="tree-node has-children">
        <span class="tree-label has-tooltip" data-tooltip="...">
          <span class="tree-label-text">Volume</span>
          <span class="tree-param">(pass)</span>
        </span>
        <!-- children... -->
      </div>
    </div>
  </div>
</div>
```

### JavaScript Ölçüm

`measureTreeLabels()` fonksiyonu label genişliklerini ölçüp CSS variable olarak set eder:

```javascript
function measureTreeLabels() {
  const treeNodes = document.querySelectorAll('.tree-node.has-children');
  treeNodes.forEach(node => {
    const labelText = node.querySelector('.tree-label-text');
    const children = node.querySelector('.tree-children');
    if (labelText && children) {
      const labelWidth = labelText.getBoundingClientRect().width;
      children.style.setProperty('--parent-center', `${labelWidth / 2}px`);
    }
  });
}
```

**Çağrı:** `updateUI()` sonunda `requestAnimationFrame(() => measureTreeLabels())`

### CSS Classes

| Class | Amaç |
|-------|------|
| `.audio-tree` | Ana container, CSS variables tanımlar |
| `.tree-node` | Her node wrapper |
| `.tree-node.has-children` | Child'ı olan node (dikey çizgi için) |
| `.tree-node.tree-root` | Kök node |
| `.tree-node.tree-monitor` | Monitor/analyzer node (muted stil) |
| `.tree-label` | Label wrapper (tooltip için) |
| `.tree-label-text` | Sadece label metni (JS ölçümü için) |
| `.tree-param` | Parantez içi parametre (muted stil) |
| `.tree-children` | Alt node'lar container |

### CSS Variables

```css
.audio-tree {
  --tree-color: var(--text-muted);
  --tree-unit: 16px;
  --tree-line: 1px;
}

.tree-children {
  /* JS'ten gelen gerçek değer, fallback 40px */
  margin-left: var(--parent-center, 40px);
}
```

### formatProcessorForTree() Return

```javascript
return {
  label: "Volume",       // AUDIO_NODE_DISPLAY_MAP'ten
  param: "pass",         // getParam() fonksiyonundan
  tooltip: "GainNode"    // Teknik isim
};
```

### AUDIO_NODE_DISPLAY_MAP

Node türlerini kullanıcı dostu isimlere çevirir:

| Node Type | Label | Param Örneği |
|-----------|-------|--------------|
| `mediaStreamSource` | Microphone | - |
| `gain` | Volume | pass, muted, -6dB |
| `biquadFilter` | Filter | LP 1000Hz |
| `analyser` | Analyzer | 2048pt |
| `audioWorkletNode` | Processor | Opus, MP3 |
| `mediaStreamDestination` | Stream Output | - |
