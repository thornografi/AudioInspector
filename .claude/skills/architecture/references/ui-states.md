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

**Dosyalar:**
- `scripts/modules/audio-tree.js` - Tree rendering ve ölçüm fonksiyonları
- `views/audio-tree.css` - Tree stilleri (CSS variables kullanır)

**Rendering Flow:**
1. `renderAudioPathTree()` - Ana fonksiyon (audio-tree.js)
2. `buildNestedTree()` - Pipeline'dan nested yapı oluşturur
3. `renderNode()` - Recursive HTML render
4. `measureTreeLabels()` - JS ile label genişliklerini ölçer (audio-tree.js, popup.js'den import edilir)

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

### Çizgi Kalınlık Tutarlılığı (Subpixel Fix)

**Problem:** Yatay ve dikey çizgiler farklı kalınlıklarda görünüyordu.

**Kök Neden:** Matematiksel senkronizasyon eksikliği:
- Dikey çizgi: `lastChild.offsetTop + 8px` (JS hesaplamalı)
- Yatay çizgi: CSS'te sabit `8px`
- Label yüksekliği: `14px`, gerçek orta: `7px`
- 1px fark → GPU anti-aliasing tutarsızlığı

**Çözüm:** Her iki çizgi de aynı formülle hesaplanmalı:

```javascript
// measureTreeLabels() içinde - audio-tree.js
const labelHeight = label.offsetHeight;  // 14px
const horizontalTop = Math.round(labelHeight / 2);  // 7px
child.style.setProperty('--horizontal-line-top', `${horizontalTop}px`);
```

**CSS Variable:**
```css
/* audio-tree.css - .tree-children > .tree-node::before */
top: var(--horizontal-line-top, 8px);  /* JS'ten gelir */
```

**Kural:** Kesişen çizgiler için AYNI formül kullan = aynı anti-aliasing kararı.

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

## Responsive Layout

### Media Query (400px)

Dar genişlikte (< 400px) UI davranışı:

| Element | Normal | Dar (<400px) |
|---------|--------|--------------|
| `.rtc-columns` | 2 sütun | 1 sütun |
| `.row-2col` | 2 sütun | 1 sütun (stacked) |
| `.tree-label` | max-width: 200px | max-width: 120px |
| `.main-content` | grid-template-rows: 30% 70% | auto 1fr |

### Table Truncation Pattern

Uzun değerlerin taşmasını önlemek için:

```css
/* popup.css */
table {
  table-layout: fixed;  /* Hücre genişliklerini sabitle */
}

td:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 0;  /* table-layout: fixed ile birlikte shrink için */
  white-space: nowrap;
}
```

### Flex Truncation Pattern

Flex container içinde truncation için `min-width: 0` gerekli:

```css
/* popup.css - .detail-value */
.detail-value {
  flex: 1;
  min-width: 0;  /* Flex shrink için gerekli */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### Tree Label Truncation

Audio tree label'ları için genişlik sınırı:

```css
/* audio-tree.css */
.tree-label {
  max-width: 200px;  /* Normal genişlik */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 400px) {
  .tree-label {
    max-width: 120px;  /* Dar panel */
  }
}
```
