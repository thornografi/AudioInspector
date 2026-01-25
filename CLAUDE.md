# AudioInspector - Proje Rehberi

## Klasör Yapısı

```
audio-inspector/
├── .claude/skills/           # Özel skill'ler (progressive disclosure)
│   ├── architecture/         # Extension mimarisi
│   │   ├── SKILL.md          # Core (~135 satır)
│   │   └── references/       # Detaylı dokümantasyon
│   └── collectors/           # Collector yazma
│       ├── SKILL.md          # Core (~185 satır)
│       └── references/       # Detaylı dokümantasyon
│
├── src/                      # Modüler uygulama kodu
│   ├── core/                 # Yardımcılar ve sabitler
│   │   ├── utils/
│   │   │   ├── ApiHook.js    # Method hooking
│   │   │   ├── EarlyHook.js  # Constructor Proxy
│   │   │   └── CodecParser.js
│   │   ├── Logger.js
│   │   └── constants.js      # DATA_TYPES, streamRegistry
│   ├── collectors/           # Veri toplama modülleri
│   │   ├── BaseCollector.js
│   │   ├── PollingCollector.js
│   │   ├── RTCPeerConnectionCollector.js
│   │   ├── GetUserMediaCollector.js
│   │   ├── AudioContextCollector.js
│   │   ├── MediaRecorderCollector.js
│   │   └── utils/            # Collector yardımcıları
│   │       ├── encoder-patterns.js  # Pattern priority
│   │       └── processor-handlers.js
│   └── page/PageInspector.js # Ana orkestratör
│
├── scripts/                  # Extension script'leri
│   ├── background.js         # Service Worker
│   ├── content.js            # ISOLATED world
│   ├── early-inject.js       # MAIN world (document_start)
│   ├── page.js               # MAIN world (PageInspector)
│   ├── popup.js              # UI
│   └── modules/              # UI modülleri (popup.js için)
│       ├── helpers.js        # DRY helper fonksiyonlar
│       ├── renderers.js      # UI render fonksiyonları
│       ├── encoder-ui.js     # ENCODING section logic
│       └── audio-tree.js     # Audio path tree rendering
│
├── views/                    # UI dosyaları
│   ├── popup.html            # Popup HTML
│   ├── popup.css             # Popup stil
│   └── audio-tree.css        # Audio tree stilleri
├── images/                   # İkonlar
└── manifest.json             # Manifest V3
```

## Skill Yönlendirme (Router)

| Soru/Görev | Skill | Reference |
|------------|-------|-----------|
| Script türleri, world isolation | architecture | - |
| MAIN world injection, veri akışı | architecture | - |
| Storage keys, kontrol mesajları | architecture | - |
| Log cleanup, lifecycle events | architecture | `references/lifecycle.md` |
| storage.onChanged, async patterns | architecture | `references/patterns.md` |
| Tab kilitleme, refresh modal | architecture | `references/tab-locking.md` |
| Banner states, encoding UI, pipeline | architecture | `references/ui-states.md` |
| Tree rendering, çizgi hizalama | architecture | `references/ui-states.md` |
| CSS variables, pixel-perfect | architecture | - |
| Yeni collector yazma | collectors | - |
| DATA_TYPES, ApiHook kullanımı | collectors | - |
| Early hook, constructor Proxy | collectors | `references/early-hooks.md` |
| WASM encoder detection, patterns | collectors | `references/wasm-detection.md` |
| Stream registry, inputSource | collectors | `references/stream-registry.md` |
| Encoder priority, DETECTION_LABELS | collectors | `references/encoder-priority.md` |
| AudioNode.connect, graph topology | collectors | `references/audio-graph.md` |

## Kod Yazma Kuralları

> **Temel İlke:** Aşırı mühendislikten kaçın. Basitlik ile genişletilebilirlik arasında denge.

### DRY (Don't Repeat Yourself)
- **Yeni kod yazmadan önce mevcut yardımcıları kontrol et**
  - CSS: `popup.css` → `.has-tooltip`, CSS değişkenleri
  - CSS: `audio-tree.css` → `.audio-tree`, tree stilleri
  - JS: `scripts/modules/helpers.js` → `formatWorkletName()`, `capitalizeFirst()`, `extractCodecName()`
  - JS: `scripts/modules/audio-tree.js` → `renderAudioPathTree()`, `measureTreeLabels()`
  - JS: `ApiHook.js`, `constants.js` → API hooking, veri sabitleri
- Tekrar eden değerler → `constants.js` veya CSS değişkeni

#### ⚠️ Duplicate Kod Uyarısı (Known Trade-off)
`early-inject.js` ve `EarlyHook.js` bazı fonksiyonları **kasıtlı olarak** duplicate içerir:

| Fonksiyon | early-inject.js | EarlyHook.js |
|-----------|-----------------|--------------|
| `getAnalyserUsageMap()` | ✓ | ✓ |
| `markAnalyserUsage()` | ✓ | ✓ |
| `getNodeIdMap()` | ✓ | ✓ |
| `getNextNodeId()` | ✓ | ✓ |

**Neden Kaçınılmaz:**
- `early-inject.js` = IIFE, MAIN world, `document_start` timing → ES module import YAPAMAZ
- `EarlyHook.js` = ES module, page.js tarafından import edilir → `document_start`'tan SONRA yüklenir

**Değişiklik yaparken HER İKİ DOSYAYI güncelle!** Dosyalardaki `// ⚠️ SYNC:` comment'lerini takip et.

### OCP (Open-Closed Principle)
- `data-attribute` > sabit içerik
- Config nesnesi > çoklu if-else
- Yeni özellik = yeni kod (mevcut kodu değiştirme)

### Kalıtım
- Collector → `BaseCollector` veya `PollingCollector`'dan türet
- Bileşim > derin kalıtım (max 2 seviye)

### YAGNI
- 3 satır tekrar > 1 gereksiz soyutlama
- Gelecek için değil, şimdi için yaz

### Console Debug Logları
- **ASLA kullanıcıya sormadan console.log silme!**
- Code review, optimizasyon, refactoring sırasında debug logları KORUNMALI
- Silme kararı sadece kullanıcı tarafından verilir

## Geliştirme Rehberi

### Yeni Collector Ekleme
1. `src/collectors/MyCollector.js` oluştur
2. `BaseCollector` veya `PollingCollector`'dan türet
3. `initialize()`, `start()`, `stop()`, `reEmit()` metodlarını uygula
4. `PageInspector.js`'e ekle

**Detaylı rehber:** `collectors` skill'i

### Dosya Yolu Kuralları
- Manifest referansları → `/scripts`
- UI dosyaları (HTML/CSS) → `/views`
- UI modülleri (popup helpers) → `/scripts/modules`
- Modüler collector/core kod → `/src`


