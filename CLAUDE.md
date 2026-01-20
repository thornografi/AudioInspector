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
│   │   └── MediaRecorderCollector.js
│   └── page/PageInspector.js # Ana orkestratör
│
├── scripts/                  # Extension script'leri
│   ├── background.js         # Service Worker
│   ├── content.js            # ISOLATED world
│   ├── early-inject.js       # MAIN world (document_start)
│   ├── page.js               # MAIN world (PageInspector)
│   └── popup.js              # UI
│
├── views/popup.html          # Popup arayüzü
├── images/                   # İkonlar
├── tests/                    # Test dosyaları
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
  - CSS: `popup.html` → `.has-tooltip`, `.chain-*`, CSS değişkenleri
  - JS: `ApiHook.js`, `constants.js`, `popup.js` → `formatProcessor()`, `renderChain()`
- Tekrar eden değerler → `constants.js` veya CSS değişkeni

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
- HTML şablonları → `/views`
- Modüler kod → `/src`
- Test dosyaları → `/tests`

## Test

```
1. chrome://extensions/ → Yeniden yükle
2. DevTools Console → [AudioInspector] hataları kontrol et
3. WhatsApp Web, Teams, Discord üzerinde test et
4. Başlat/Durdur çalışıyor mu?
```

## Browser Testing (Claude Code)

> **KRİTİK:** Test için DAIMA `http://localhost:8081` kullan!

| Tray Icon | Durum | Port |
|-----------|-------|------|
| 🟢 Yeşil | Çalışıyor | 8081 |
| 🟠 Turuncu | Kapalı | - |

**Test akışı:**
```
1. tabs_context_mcp(createIfEmpty: true)
2. navigate(tabId, "http://localhost:8081/tests/test.html")
3. Audio API butonlarına tıkla
4. read_console_messages ile kontrol et
```

| Bileşen | Claude Code ile | Not |
|---------|-----------------|-----|
| test.html UI | ✅ | Butonlar tıklanabilir |
| Audio API tetikleme | ✅ | getUserMedia, AudioContext |
| Console logları | ✅ | read_console_messages |
| Side panel / Popup | ❌ | Manuel açılmalı |
