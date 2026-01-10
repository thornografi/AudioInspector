---
name: architecture
description: "Extension mimarisi. Manifest V3, MAIN world injection, script türleri, veri akışı. Anahtar kelimeler: mimari, architecture, manifest, content script, background, page script, main world, isolated world, postMessage, veri akışı"
---

# Extension Mimarisi

Chrome Extension (Manifest V3) yapısı.

## Script Türleri

| Script | Context | Erişim | Dosya |
|--------|---------|--------|-------|
| **content.js** | ISOLATED world | DOM, mesajlaşma | `scripts/content.js` |
| **page.js** | MAIN world | WebRTC API'leri | `scripts/page.js` |
| **background.js** | Service Worker | chrome.* API | `scripts/background.js` |
| **popup.js** | Extension UI | chrome.storage | `scripts/popup.js` |

## MAIN World Injection (KRİTİK)

**Problem:** Content scripts ISOLATED world'de → `window.RTCPeerConnection`'a erişemez.

**Çözüm:**
```javascript
// background.js
await chrome.scripting.executeScript({
  target: { tabId, frameIds: [frameId] },
  world: 'MAIN',
  files: ['scripts/page.js']
});
```

## Veri Akışı

```
[MAIN World - page.js]
  Collectors hook API'leri
       ↓ emit('data')
  PageInspector._report()
       ↓ window.postMessage()

[ISOLATED World - content.js]
  message listener → chrome.storage.local.set()

[Popup - popup.js]
  chrome.storage.local.get() → UI
```

## Tab Kilitleme

Inspector başlatıldığında sadece o tab'da çalışır.

### Storage Keys
- `lockedTab: { id, url, title }` - Kilitli tab bilgisi
- `inspectorEnabled: boolean` - Inspector durumu

### Kontrol Akışı
```
[popup.js] Start butonuna basıldı
       ↓
  lockedTab = { id: activeTab.id, url, title }
  chrome.storage.local.set({ inspectorEnabled: true, lockedTab })
       ↓
[content.js] INSPECTOR_READY geldiğinde:
  1. GET_TAB_ID → background.js (kendi tab ID'sini öğren)
  2. Tab ID kontrolü: currentTabId === lockedTab.id?
  3. Origin kontrolü: currentOrigin === lockedOrigin?
  4. Her ikisi de eşleşirse → SET_ENABLED: true
```

### Farklı Tab'dan Stop
```
[popup.js] Farklı tab'dayken Stop basıldı
       ↓
  lockedTab.id'ye mesaj gönder (aktif tab'a değil!)
       ↓
[content.js @ locked tab] SET_ENABLED: false alır
```

## Early Hook System

Sayfa API'leri PageInspector başlamadan ÖNCE kullanabilir. Bu sorunu `EarlyHook.js` çözer.

### Yükleme Sırası

```
1. content.js → INJECT_PAGE_SCRIPT → background.js
2. background.js → chrome.scripting.executeScript(page.js)
3. page.js yüklenir:
   a. installEarlyHooks()     ← Constructor Proxy'leri + Worker.postMessage hook
   b. new PageInspector()
   c. inspector.initialize()  ← Collector handler'ları kaydedilir
   d. inspector.start()
```

### Hook Tipleri

| Hook | Mekanizma | Kaynak |
|------|-----------|--------|
| Constructor | `new Proxy(Original, { construct })` | EarlyHook.js |
| Method | `prototype[method] = wrapper` | ApiHook.js |
| Worker.postMessage | `Worker.prototype.postMessage = wrapper` | EarlyHook.js |

### Veri Akışı (Detaylı)

```
[EarlyHook.js - page load]
  new AudioContext() → Proxy intercept
       ↓
  instanceRegistry.audioContexts.push(ctx)
  window.__audioContextCollectorHandler?.(ctx)
       ↓
[PageInspector.initialize()]
  AudioContextCollector.initialize()
    → window.__audioContextCollectorHandler = handler
    → Late-discovery: check __wasmEncoderDetected
       ↓
[Collector aktif]
  emit(EVENTS.DATA, metadata)
       ↓
  PageInspector._report() → postMessage()
       ↓
[content.js]
  chrome.storage.local.set()
```

## Klasör Yapısı

```
src/
├── collectors/       # API hook modülleri (→ collectors skill)
├── detectors/        # Platform algılama
├── core/
│   ├── utils/
│   │   ├── ApiHook.js      # hookMethod, hookAsyncMethod, hookConstructor
│   │   ├── EarlyHook.js    # installEarlyHooks, getInstanceRegistry
│   │   └── CodecParser.js  # parseMimeType, parseOpusParams
│   ├── Logger.js
│   └── constants.js
└── page/PageInspector.js   # Ana orkestratör
```

## Debug

```javascript
window.__pageInspector      // Inspector instance
window.__wasmEncoderDetected  // WASM encoder tespit bilgisi
```
