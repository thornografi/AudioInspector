---
name: architecture
description: "Chrome Extension mimarisi (Manifest V3). Script türleri (content/page/background), MAIN world injection, veri akışı (postMessage → storage → UI). Kullan: mimari soru, script iletişimi, world isolation, mesaj akışı, storage pattern"
---

# Extension Mimarisi

Chrome Extension (Manifest V3) yapısı. MAIN world injection ile WebRTC/Audio API hook'lama.

## Script Türleri ve Context'ler

| Script | Context | Erişim | Dosya |
|--------|---------|--------|-------|
| **background.js** | Service Worker | chrome.* API, lifecycle events | `scripts/background.js` |
| **content.js** | ISOLATED world | DOM, mesajlaşma, storage | `scripts/content.js` |
| **early-inject.js** | MAIN world | API Proxy (en erken) | `scripts/early-inject.js` |
| **page.js** | MAIN world | WebRTC/Audio API'leri | `scripts/page.js` |
| **popup.js** | Extension UI | chrome.storage, UI | `scripts/popup.js` |

## MAIN World Injection

**Problem:** Content scripts ISOLATED world'de → `window.RTCPeerConnection`'a erişemez.

**Çözüm:** İki aşamalı injection:

```javascript
// manifest.json - En erken hook (document_start)
"content_scripts": [{
  "js": ["scripts/early-inject.js"],
  "world": "MAIN",
  "run_at": "document_start"
}]

// background.js - PageInspector injection
await chrome.scripting.executeScript({
  target: { tabId, frameIds: [frameId] },
  world: 'MAIN',
  files: ['scripts/page.js']
});
```

**Yükleme Sırası:**
1. `early-inject.js` → Constructor Proxy'leri (AudioContext, RTCPeerConnection, vb.)
2. Sayfa script'leri çalışır (API'ler zaten hook'lu)
3. `page.js` → PageInspector başlar, early captures sync edilir

## Temel Veri Akışı

```
[MAIN World]
  Collectors → emit(data) → PageInspector._report()
       ↓ window.postMessage()
[ISOLATED World]
  content.js listener → chrome.storage.local.set()
       ↓ storage.onChanged
[Popup]
  popup.js listener → updateUI()
```

## Storage Keys

**State:**
- `inspectorEnabled` - Inspector aktif mi
- `lockedTab` - `{ id, url, title }` kilitli tab
- `pendingAutoStart` - Refresh sonrası auto-start için tab ID

**Data (DATA_STORAGE_KEYS):**
- `rtc_stats`, `user_media`, `audio_contexts`, `audio_worklet`
- `media_recorder`, `wasm_encoder`, `audio_connections`

**Persistent:**
- `debug_logs` - Merkezi log kayıtları
- `platformInfo` - Platform algılama (temizlenmez)

## Kontrol Mesajları

| Mesaj | Yön | Amaç |
|-------|-----|------|
| `INSPECTOR_READY` | page→content | PageInspector hazır |
| `SET_ENABLED` | popup→content→page | Inspector aç/kapat |
| `RE_EMIT_ALL` | content→page | Collector'lar veriyi yeniden emit etsin |
| `GET_TAB_ID` | content→background | Tab ID öğrenme |
| `ADD_LOG` | content→background | Merkezi log ekleme |

## Detaylı Referanslar

Aşağıdaki konular için ilgili reference dosyasını oku:

- **Lifecycle & Cleanup:** [references/lifecycle.md](references/lifecycle.md)
  - Log cleanup, tab close, window close, navigation
  - clearInspectorData() helper'ları
  - Auto-stop mekanizması

- **Storage & Async Patterns:** [references/patterns.md](references/patterns.md)
  - storage.onChanged listener pattern
  - Async storage clearing (race condition fix)
  - Force restart logic
  - Data reset flow

- **Tab Locking:** [references/tab-locking.md](references/tab-locking.md)
  - Tab kilitleme akışı
  - Farklı tab'dan stop
  - Second start refresh modal
  - pendingAutoStart flow

- **UI States & Rendering:** [references/ui-states.md](references/ui-states.md)
  - Banner display states
  - Popup tab listeners
  - Encoding section rendering
  - Pipeline/chain rendering
  - Constants mirroring (popup.js ↔ constants.js)

## Klasör Yapısı

```
src/
├── collectors/       # API hook modülleri (→ collectors skill)
├── core/
│   ├── utils/
│   │   ├── ApiHook.js      # hookMethod, hookAsyncMethod
│   │   ├── EarlyHook.js    # Constructor Proxy, registry
│   │   └── CodecParser.js  # Codec parsing
│   ├── Logger.js
│   └── constants.js        # DATA_TYPES, EVENTS, streamRegistry
└── page/PageInspector.js   # Ana orkestratör
```

## Debug

```javascript
window.__pageInspector         // Inspector instance
window.__earlyCaptures         // Early hook registry
window.__wasmEncoderDetected   // WASM encoder tespiti
```
