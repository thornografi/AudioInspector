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

## Console Drawer

### Yapı

```
drawer-overlay (slide-up panel, %40 height)
├── drawer-header
│   ├── drawer-tabs (Console | Extension)
│   └── console-actions (Copy All | Clear)
├── console-toolbar
│   ├── console-filters (All | Errors | Warnings | Info)
│   └── Copy butonu (copyVisibleLogsBtn)
├── drawer-tab-content#consoleLogsContent
└── drawer-tab-content#extensionLogsContent
```

### Copy Butonları

| Buton | ID | Konum | Davranış |
|-------|-----|-------|----------|
| **Copy All** | `copyAllLogsBtn` | drawer-header | TÜM loglar (Console + Extension, tüm level'lar) |
| **Copy** | `copyVisibleLogsBtn` | console-toolbar | Görünen loglar (aktif tab + aktif filter) |

### İlgili Fonksiyonlar (`popup.js`)

```javascript
// Tüm logları kopyalar (no filtering)
async function copyAllLogs() {
  const result = await chrome.storage.local.get('debug_logs');
  const logs = result.debug_logs || [];
  // Format ALL logs as plain text
  const text = logs.map(log => `${time} [${log.prefix}] ${log.message}`).join('\n');
  await navigator.clipboard.writeText(text);
}

// Filtrelenmiş logları kopyalar (respects tab + level)
async function copyVisibleLogs() {
  // Filter based on active tab (currentDrawerTab)
  // Apply level filter (currentLogFilter)
}

// Tab'a göre log ayırma
function renderDrawerLogs(logs, badgeCallback) {
  const consoleLogs = logs.filter(l => l.prefix === 'Console');
  const extensionLogs = logs.filter(l => l.prefix !== 'Console');
  // ...
}

// Level filter uygulama
function renderLogList(container, logs, emptyMessage) {
  const filtered = currentLogFilter === 'all'
    ? logs
    : logs.filter(l => l.level === currentLogFilter);
  // ...
}
```

### Log Filtreleme State

```javascript
let currentLogFilter = 'all';       // 'all' | 'error' | 'warn' | 'info'
let currentDrawerTab = 'console';   // 'console' | 'extension'
let cachedLogs = [];                // Re-render için cache
```

### CSS Layout

```css
/* console-toolbar: filters sol, copy sağ */
.console-toolbar {
  display: flex;
  justify-content: space-between;  /* Sol: filters, Sağ: copy */
  align-items: center;
}
```

## Encoding Section

OCP-compliant `ENCODER_DETECTORS` array pattern.

### DETECTION_LABELS Mapping

Pattern değerlerini UI metne çevirir.

**Tam liste:** `collectors/references/encoder-priority.md` → UI DETECTION_LABELS bölümü

**Kaynak dosya:** `scripts/modules/encoding-ui.js`

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

## Encoding Location Strategy

### Mimari (OCP Pattern)

Encoding badge lokasyonunu belirlemek için strategy pattern kullanılır.

**Dosya:** `scripts/modules/encoding-location.js`

```javascript
ENCODING_LOCATION_STRATEGIES = [
  { name: 'WasmEncoder', priority: 10, ... },
  { name: 'MediaRecorderSynthesized', priority: 8, ... },
  { name: 'PcmPassthrough', priority: 5, ... }
];
```

### Strategy Priority & Davranış

| Priority | Strategy | Detect Koşulu | Badge Lokasyonu |
|----------|----------|---------------|-----------------|
| 10 | `WasmEncoder` | encodingNodeId var + codec ≠ pcm/wav | Processor node |
| 8 | `MediaRecorderSynthesized` | audioSource = 'synthesized' | Terminal node |
| 5 | `PcmPassthrough` | codec = pcm/wav | Virtual terminal |

### Veri Akışı

```
AudioContextCollector (blob oluşturulduğunda)
    ↓
detectedEncoder = { codec, container, ... }
    ↓
deriveEncodingOutput(data, connections, tree)
    ↓
PcmPassthrough.getLocation() → { location: 'virtual-terminal', codec, container }
    ↓
toRenderOptions() → { virtualTerminal: { codec, container } }
    ↓
renderAudioFlow(options.virtualTerminal)
    ↓
codecLabel = virtualTerminal.container.toUpperCase()  // "WAV"
```

### Virtual Terminal Ekleme

PCM/WAV için connection graph'ta destination olmayabilir. Bu durumda sanal `Encoder(WAV)` node eklenir.

```javascript
// audio-flow.js
if (virtualTerminal && !hasTerminalNode(root)) {
  const lastNode = findLastFlowNode(root);  // Gerçek leaf node (monitor dahil)
  const codecLabel = virtualTerminal.container?.toUpperCase() || 'PCM';
  lastNode.outputs.push({
    label: 'Encoder',
    param: codecLabel,  // Dinamik: WAV, PCM, vb.
    isVirtualTerminal: true
  });
}
```

### findLastFlowNode Davranışı

**Kritik:** Monitor node'lar dahil TÜM node'ları takip eder.

```javascript
const findLastFlowNode = (node) => {
  const allOutputs = node.outputs || [];  // Monitor filtresi YOK
  if (allOutputs.length === 0) return node;
  return findLastFlowNode(allOutputs[0]);
};
```

**Neden?** Monitor (VU Meter) filtrelenirse virtual terminal yanlış yere eklenir:

```
❌ Monitor filtrelendi:
Processor → [Encoder, VU Meter]  (split point)

✅ Monitor dahil:
Processor → VU Meter → Encoder   (seri bağlantı)
```

### Case Coverage

| Case | Kayıt Esnasında | Kayıt Sonrası |
|------|-----------------|---------------|
| WASM (Opus, MP3) | `← Encoder` badge processor'da | Aynı |
| MediaRecorder | - | Badge terminal'de |
| PCM/WAV | Badge YOK | Virtual terminal en altta |

### Edge Case'ler

| Edge Case | Davranış | Risk |
|-----------|----------|------|
| Destination olan PCM/WAV | `location: 'processor'` | Düşük |
| VU Meter olmadan PCM/WAV | Terminal = Processor | Doğru |
| Split point | İlk dal takip edilir | Düşük |

## AudioContext Latency

İki bileşenden hesaplanır:

```javascript
const baseLatency = ctx.static?.baseLatency || 0;      // ~10ms
const outputLatency = ctx.static?.outputLatency || 0;  // ~42ms
const totalLatency = baseLatency + outputLatency;      // ~52ms
```

**Tooltip:** "Total output latency (baseLatency: 10.0ms + outputLatency: 42.0ms)"

## Pipeline Rendering

### Audio Path Flow (Workflow/Pipeline)

Ok işaretli workflow/pipeline görselleştirmesi:

```
[Microphone]
     ↓
[Volume (+6dB)]
     ↓
[Encoder] → [Spectrum]
     ↓
[Speakers]
```

**Dosyalar:**
- `scripts/modules/audio-flow.js` - Flow rendering ve ölçüm fonksiyonları
- `views/audio-flow.css` - Flow stilleri (CSS variables kullanır)

**Rendering Flow:**
1. `renderAudioFlow()` - Ana fonksiyon (audio-flow.js)
2. `convertProcessorTreeToDisplayFlow()` - ProcessorTree'den display flow oluşturur
3. `renderNode()` - Recursive HTML render (split detection dahil)
4. `measureFlowLabels()` - JS ile label genişliklerini ölçer (audio-flow.js, popup.js'den import edilir)

### HTML Yapısı

```html
<div class="audio-flow">
  <div class="flow-node flow-root has-outputs">
    <span class="flow-label flow-tooltip" data-tooltip="...">
      <span class="flow-label-text">Microphone</span>
    </span>
    <div class="flow-outputs">
      <div class="flow-node has-outputs">
        <span class="flow-label flow-tooltip" data-tooltip="...">
          <span class="flow-label-text">Volume</span>
          <span class="flow-param">(pass)</span>
        </span>
        <!-- outputs... -->
      </div>
    </div>
  </div>
</div>
```

### JavaScript Ölçüm

`measureFlowLabels()` fonksiyonu **sadece root node'un** label merkez pozisyonunu ölçüp container'a CSS variable olarak set eder. Tüm dikey oklar bu değeri kullanarak aynı dikey hizada kalır.

```javascript
function measureFlowLabels() {
  const container = document.querySelector('.audio-flow');
  const rootNode = container?.querySelector('.flow-node.flow-root');
  const rootLabelText = rootNode?.querySelector('.flow-label-text');
  if (!rootLabelText) return;

  const labelTextRect = rootLabelText.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const labelTextLeft = labelTextRect.left - containerRect.left;
  const center = labelTextLeft + (labelTextRect.width / 2);

  // Container'a set et - tüm child'lar inherit eder
  container.style.setProperty('--main-arrow-left', `${Math.floor(center)}px`);
}
```

**Çağrı:** `updateUI()` sonunda `requestAnimationFrame(() => measureFlowLabels())`

### CSS Classes

| Class | Amaç |
|-------|------|
| `.audio-flow` | Ana container, CSS variables tanımlar |
| `.flow-node` | Her node wrapper |
| `.flow-node.has-outputs` | Output'u olan node (dikey ok için) |
| `.flow-node.flow-root` | Kök node |
| `.flow-node.is-split` | Dallanma noktası (birden fazla output) |
| `.flow-node.flow-monitor` | Monitor/analyzer node (muted stil) |
| `.flow-label` | Label wrapper (tooltip için) |
| `.flow-label-text` | Sadece label metni (JS ölçümü için) |
| `.flow-param` | Parantez içi parametre (muted stil) |
| `.flow-outputs` | Output node'lar container |

### CSS Variables

```css
.audio-flow {
  /* Spacing System (merkezi) */
  --spacing-unit: 4px;
  --spacing-xs: 4px;   /* arrow-gap */
  --spacing-sm: 8px;
  --spacing-md: 12px;  /* container padding */
  --spacing-lg: 16px;  /* row height */
  --spacing-xl: 20px;  /* split gap */

  /* Semantic Aliases */
  --flow-row-height: var(--spacing-lg);
  --arrow-gap: var(--spacing-xs);
  --split-gap: var(--spacing-xl);
  --container-padding: var(--spacing-md);

  /* Flow Core */
  --flow-unit: 17px;
  --flow-gap: 3px;
  --main-arrow-left: 40px;  /* JS tarafından set edilir */

  /* Arrow SVG */
  --arrow-svg: url("data:image/svg+xml,...");  /* Aşağı bakan ok */
  --arrow-icon-size: 12px;

  /* Deep nesting koruması */
  max-width: 100%;
  overflow-x: auto;
}
```

### Ok Render Yöntemi (SVG)

Tek SVG tasarımı, `rotate()` ile yön değişir:

```css
/* Base - tüm oklar için ortak */
.flow-node.has-outputs::after,
.flow-node.is-split > .flow-outputs > .flow-node:not(:first-child)::before {
  content: '';
  width: var(--arrow-icon-size);
  height: var(--arrow-icon-size);
  background: var(--arrow-svg) no-repeat center;
}

/* Dikey ok (↓) - output'u olan node'un altında */
.flow-node.has-outputs::after {
  left: var(--main-arrow-left, 40px);  /* JS'ten gelir */
  transform: translateX(-50%);
  /* SVG zaten aşağı bakıyor - rotate yok */
}

/* Yatay ok (→) - split'te yan output'lara */
.flow-node.is-split > ... ::before {
  transform: rotate(-90deg);  /* Aşağı → Sağa */
}

/* Encoder ok (←) */
.encoder-badge::before {
  transform: rotate(90deg);   /* Aşağı → Sola */
}
```

### Split Detection

Birden fazla output varsa `is-split` class eklenir:

```javascript
const isSplitPoint = hasOutputs && node.outputs.length > 1;
if (isSplitPoint) classes.push('is-split');
```

**Split Layout:**
- İlk output dikey akışta kalır (ana dal)
- Sonraki output'lar yatay olarak sağa dizilir
- Her yan dal için `→` ok gösterilir

### formatProcessorForFlow() Return

```javascript
// audio-flow.js
return {
  label: "Volume",       // AUDIO_NODE_DISPLAY_MAP'ten (veya getLabel() varsa dinamik)
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
| `.flow-label` | max-width: 200px | max-width: 120px |
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

### Flow Label Truncation

Audio flow label'ları için genişlik sınırı:

```css
/* audio-flow.css */
.flow-label {
  max-width: 200px;  /* Normal genişlik */
  overflow: visible;  /* Ok (::after) görünmesi için */
  white-space: nowrap;
}

.flow-label-text {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* popup.css - dar panel */
@media (max-width: 400px) {
  .flow-label {
    max-width: 120px;
  }
}
```
