---
name: architecture
description: "Extension mimarisi. Manifest V3, MAIN world injection, script türleri, veri akışı. Anahtar kelimeler: mimari, architecture, manifest, content script, background, page script, main world, isolated world, postMessage, veri akışı"
---

# Extension Mimarisi

Chrome Extension (Manifest V3) yapısı ve çalışma prensibi.

## Script Türleri ve Context'ler

| Script | Context | Erişim | Dosya |
|--------|---------|--------|-------|
| **content.js** | ISOLATED world | DOM, mesajlaşma | `scripts/content.js` |
| **page.js** | MAIN world | WebRTC API'leri | `scripts/page.js` |
| **background.js** | Service Worker | chrome.* API | `scripts/background.js` |
| **popup.js** | Extension UI | chrome.storage | `scripts/popup.js` |

## MAIN World Injection (KRİTİK)

**Problem:** Content scripts ISOLATED world'de çalışır → `window.RTCPeerConnection`'a erişemez.

**Çözüm:** `chrome.scripting.executeScript` ile MAIN world'e inject:

```javascript
// background.js - handleInjection()
await chrome.scripting.executeScript({
  target: { tabId, frameIds: [frameId] },
  world: 'MAIN',
  files: ['scripts/page.js']
});
```

Content script, injection isteğini background'a iletir:
```javascript
// content.js
chrome.runtime.sendMessage({ type: 'INJECT_PAGE_SCRIPT' });
```

## Veri Akışı

```
[MAIN World - page.js]
RTCPeerConnection, getUserMedia hook'ları
         ↓ emit('data')
PageInspector._report()
         ↓ window.postMessage()

[ISOLATED World - content.js]
message listener
         ↓ chrome.storage.local.set()

[Popup - popup.js]
chrome.storage.local.get()
         ↓
UI gösterimi
```

## PageInspector Coordinator

Ana orkestratör. Collector'ları yönetir, verileri `postMessage` ile iletir.

```javascript
// src/page/PageInspector.js
class PageInspector {
  collectors = [];  // RTCPeerConnection, getUserMedia, AudioContext, MediaRecorder

  async initialize() {
    // 1. Collector'ları oluştur
    // 2. Event'leri bağla: collector.on('data', this._report)
    // 3. Hook'ları aktifleştir: collector.initialize()
    // 4. Setup control listener
    this._setupControlListener();
    // 5. Notify content script we're ready
    this._notifyReady();
  }

  _notifyReady() {
    // Race condition fix: Signal that PageInspector is ready
    // content.js waits for this before attempting state restore
    window.postMessage({
      [MESSAGE_MARKER]: true,
      type: 'INSPECTOR_READY'
    }, '*');
    logger.info(LOG_PREFIX.INSPECTOR, 'Notified content script: READY');
  }

  _report(data) {
    window.postMessage({ __audioPipelineInspector: true, payload: data }, '*');
  }
}
```

## Klasör Yapısı

```
src/
├── collectors/       # Veri toplama (→ collectors skill)
├── detectors/        # Platform algılama (Teams, Discord vb.)
├── core/
│   ├── utils/
│   │   ├── ApiHook.js      # Hook yardımcıları
│   │   └── CodecParser.js  # Opus/mimeType parser
│   ├── Logger.js
│   └── constants.js
└── page/
    └── PageInspector.js   # Coordinator
```

## Default State

Inspector varsayılan olarak **Stop** modunda başlar:

```javascript
// background.js
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ inspectorEnabled: false });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ inspectorEnabled: false });
});
```

**Neden?**
- Performans: Polling ve hook'lar kaynak tüketir
- Gizlilik: Kullanıcı ne zaman izlendiğini bilmeli
- Geliştirici aracı mantığı: İhtiyaç olduğunda açılır

## Control Flow (SET_ENABLED)

### Two-Phase Initialization (Race Condition Fix)

**Problem:** content.js restore message, PageInspector listener'dan önce gönderiliyordu → message kayboluyordu.

**Çözüm:** INSPECTOR_READY signal pattern ile deterministik initialization.

```
[page.js] page script inject edilir
    ↓ import PageInspector
    ↓ PageInspector.initialize()
    ↓ Collectors başlatıldı, listener hazır
    ↓ _notifyReady() → window.postMessage({ type: 'INSPECTOR_READY' })

[content.js] INSPECTOR_READY handler
    ↓ chrome.storage.local.get(['inspectorEnabled'])
    ↓ if (enabled === true) → window.postMessage({ type: 'SET_ENABLED', enabled: true })
    ↓ else → "not restoring" log

[page.js / PageInspector] _setupControlListener()
    ↓ SET_ENABLED alındı
    ↓ enabled ? startAll() : stopAll()
```

### Manual Toggle Flow

```
[popup.js] toggleInspector() (kullanıcı butona tıkladı)
    ↓ chrome.storage.local.remove([...]) // Storage temizle (Start/Stop her ikisinde de)
    ↓ chrome.storage.local.set({ inspectorEnabled })
    ↓ chrome.tabs.sendMessage({ type: 'SET_ENABLED', enabled })

[content.js] onMessage
    ↓ chrome.storage.local.set({ inspectorEnabled })
    ↓ persistLogs({ message: enabled ? '✅ Inspector started' : '⏸️ Inspector stopped' })
    ↓ window.postMessage({ type: 'SET_ENABLED', enabled })

[page.js / PageInspector] _setupControlListener()
    ↓ enabled ? startAll() : stopAll()
```

## Popup UI State Management

### Status Badge

Header'da inspector durumu gösterilir:

```javascript
// popup.js:32-38
const statusText = enabled ? 'Started' : 'Stopped';
```

| Durum | Badge | UI Efekti |
|-------|-------|-----------|
| **Started** | Yeşil, "Started" | `body.recording` class → kırmızı animasyon, glow |
| **Stopped** | Gri, "Stopped" | Normal görünüm |

**Not:** Eski versiyonda platform bilgisi (Teams, Discord vb.) gösteriliyordu. Artık sadece inspector durumu gösteriliyor.

### Console Log Renklendirme

Log satırları içeriğe göre **satır bazında** otomatik renklendirilir:

```javascript
// popup.js:428-468 - getLogColorClass()
```

| Mesaj İçeriği | CSS Class | Renk | Örnek |
|--------------|-----------|------|-------|
| "initializ", "starting" | `.info` | Mavi | "Starting initialization..." |
| "✅", "started", "ready", "loaded" | `.success` | Yeşil | "✅ Initialized successfully" |
| "error", "failed", "❌" | `.error` | Kırmızı | "Failed to initialize" |
| "waiting", "warning", "⚠️" | `.warn` | Turuncu | "Waiting for extension..." |

**Renklendirme kapsamı:** Timestamp + prefix + mesaj (tüm satır aynı renk).

### Data Persistence

```javascript
// popup.js:516-520
async function clearData() {
  await chrome.storage.local.clear();  // TÜM storage temizlenir
  location.reload();
}
```

**clearData() temizler:**
- RTC stats, getUserMedia, AudioContext verileri
- Debug logs
- **Platform info** (artık korunmuyor)

**toggleInspector()** sadece `inspectorEnabled` state'ini değiştirir, verileri temizlemez.

### Button States

| Durum | Buton | Açıklama |
|-------|-------|----------|
| Inspector kapalı | "Start" butonu | Kullanıcı başlatmak için tıklar |
| Inspector açık | "Stop" butonu | Kullanıcı durdurmak için tıklar |

Buton **eylem** gösterir, durumu değil.

## Debug

```javascript
window.__pageInspector  // Inspector instance'ına erişim
```

Console prefix'leri: `[PageInspector]`, `[rtc-peer-connection]`, `[get-user-media]`
