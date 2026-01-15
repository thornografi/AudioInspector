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
  chrome.storage.onChanged → updateUI()
```

### Storage Listener Pattern (popup.js)

Polling yerine storage.onChanged listener kullanılır:

```javascript
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    // Sadece ilgili key'ler değiştiyse UI güncelle
    const relevantKeys = ['rtc_stats', 'user_media', 'audio_contexts',
                          'audio_worklet', 'media_recorder', 'wasm_encoder'];
    if (Object.keys(changes).some(key => relevantKeys.includes(key))) {
      updateUI();
    }
    // lockedTab değiştiyse banner güncelle
    if (changes.lockedTab) {
      checkTabLock();
    }
  }
});
```

**Dikkat:** Storage set eden fonksiyonlarda manuel `checkTabLock()` veya `updateUI()` çağırmayın - listener zaten handle eder (duplicate tetikleme riski).

### Data Reset Flow (MediaRecorder.start())

Yeni kayıt başladığında tüm veriler temizlenip yeniden emit edilir:

```
MediaRecorder.start() → resetData=true
         ↓
content.js: storage.remove(DATA_STORAGE_KEYS)
         ↓
content.js: storage.set(media_recorder)
         ↓
content.js → page.js: RE_EMIT_ALL
         ↓
PageInspector._reEmitAllCollectors()
         ↓
Collectors.reEmit() → storage.set()
         ↓
popup.js: storage.onChanged → updateUI()
```

## Tab Kilitleme

Inspector başlatıldığında sadece o tab'da çalışır.

### Storage Keys
- `lockedTab: { id, url, title }` - Kilitli tab bilgisi
- `inspectorEnabled: boolean` - Inspector durumu

### Data Storage Keys
Toplanan veriler için kullanılan key'ler (**DRY principle**: background.js, content.js & popup.js'de aynı array):
- `rtc_stats` - WebRTC istatistikleri
- `user_media` - getUserMedia sonuçları
- `audio_contexts` - AudioContext metadata (array)
- `audio_worklet` - AudioWorklet module bilgisi (audio_contexts'e merge edilir)
- `media_recorder` - MediaRecorder bilgisi
- `wasm_encoder` - WASM encoder (opus) bilgisi - **bağımsız sinyal**

> **Not:** `wasm_encoder` AudioContext'e bağlanmaz - sampleRate eşleştirme güvenilir değildir.

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

### Banner Display States

Popup'ta locked tab info banner 3 durumu gösterir:

| State | Tab | Inspector | Banner Renk | Metin |
|-------|-----|-----------|-------------|-------|
| **Inspecting** | Same tab | Running | Kırmızı (same-tab) | `Inspecting: domain.com` |
| **Stopped** | Same tab | Stopped | Yeşil (same-tab) | `Stopped - Data from: domain.com` |
| **Different tab** | Different tab | Any | Turuncu (different-tab) | `Different tab - data from: domain.com` |

```javascript
// popup.js
showLockedTabInfo(lockedTab, isSameTab, isRunning);
```

**Helper functions (SRP):**
- `extractDomain(lockedTab)` - Domain extraction
- `getBannerStatusText(isSameTab, isRunning)` - Status text determination
- `updateBannerStyle(banner, isSameTab)` - CSS class manipulation

### Tab Switch Auto-Stop

Inspecting aktifken başka tab'a geçilirse otomatik durdurulur:

```javascript
// background.js
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const result = await chrome.storage.local.get(['inspectorEnabled', 'lockedTab']);

  // Dinleme aktif değilse hiçbir şey yapma
  if (!result.inspectorEnabled || !result.lockedTab) {
    return;
  }

  // Aktif tab değişti mi kontrol et
  const newActiveTabId = activeInfo.tabId;
  const lockedTabId = result.lockedTab.id;

  if (newActiveTabId !== lockedTabId) {
    // Farklı tab'a geçildi, otomatik durdur
    console.log('[Background] Tab switched during inspecting - auto-stopping');

    // Auto-stop reason set et
    await chrome.storage.local.set({ autoStoppedReason: 'tab_switch' });

    // Inspector'ı durdur (lockedTab kalsın - review için)
    await chrome.storage.local.remove(['inspectorEnabled']);

    // Badge'i güncelle
    updateBadge(false);

    // Locked tab'e mesaj gönder (page script'i durdur)
    try {
      await chrome.tabs.sendMessage(lockedTabId, {
        type: 'SET_ENABLED',
        enabled: false
      });
    } catch (e) {
      // Tab erişilemez olabilir (arka planda, suspended, vb.)
      console.log('[Background] Could not send stop message to locked tab:', e.message);
    }
  }
});
```

**autoStoppedReason değerleri:**
- `'tab_switch'` - Başka tab'a geçildi
- `'origin_change'` - Aynı tab'da farklı siteye gidildi
- `'injection_failed'` - Script enjeksiyonu başarısız

**Akış:**
```
User switches to different tab
       ↓
tabs.onActivated (background.js)
       ↓
Check: inspectorEnabled && newTabId !== lockedTabId
       ↓
Set autoStoppedReason: 'tab_switch'
       ↓
Remove inspectorEnabled (lockedTab kalır)
       ↓
Send SET_ENABLED: false to locked tab
       ↓
popup.js: checkTabLock() → showAutoStopBanner('tab_switch')
```

## Async Storage Clearing (Race Condition Fix)

### Problem: Storage Clear Race Condition

**Önceki Sorun:** `chrome.storage.local.remove()` callback pattern kullanıyordu ama await edilmiyordu. Bu, collectors'ın emit ettiği yeni verinin eski verilerle karışmasına sebep oluyordu.

**Race Condition Flow:**
```
1. User clicks START
       ↓
2. content.js: storage.remove(DATA_STORAGE_KEYS, callback) ← ASYNC, not awaited
       ↓
3. content.js: window.postMessage(SET_ENABLED) ← Immediately, doesn't wait
       ↓
4. Collectors start → emit encoding data → storage.set()
       ↓
5. Popup reads storage → OLD data still present (async clear not completed yet)
```

**User Symptom:** "Biraz bekleyince temizleniyor" - async operation tamamlanınca temizleniyordu.

### Solution: Async Handler with Promise Wrapper

**content.js** (line 385-422):

```javascript
/**
 * Async handler for SET_ENABLED messages
 * Ensures storage operations complete before forwarding to page script
 */
async function handleSetEnabled(message) {
  // Persist state (await to ensure completion)
  await chrome.storage.local.set({ inspectorEnabled: message.enabled });

  // Clear all data storage on start - AWAIT completion to prevent race condition
  if (message.enabled) {
    await new Promise(resolve => {
      chrome.storage.local.remove(DATA_STORAGE_KEYS, () => {
        logContent('🧹 Cleared stale data from storage');
        resolve();
      });
    });
  }

  // Add explicit log to storage
  persistLogs(createLog('Content', message.enabled ? '✅ Inspector started' : '⏸️ Inspector stopped'));

  // NOW forward to page.js (AFTER storage operations complete)
  window.postMessage({
    __audioPipelineInspector: true,
    type: 'SET_ENABLED',
    enabled: message.enabled
  }, '*');
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_ENABLED') {
    // Handle async operations - return true to keep channel open
    handleSetEnabled(message).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      logContent(`❌ Error handling SET_ENABLED: ${error.message}`);
      sendResponse({ success: false, error: error.message });
    });
    return true;  // Keep message channel open for async response
  }
});
```

**Key Points:**
- ✅ Promise wrapper makes storage.remove() awaitable
- ✅ `return true` keeps message channel open for async sendResponse
- ✅ Error handling with try-catch
- ✅ Storage fully cleared BEFORE collectors start emitting

**Benefit:** Eliminates race condition - old encoding data never appears after restart.

## Force Restart Logic (State Sync Fix)

### Problem: Early Return Blocks Restart

**Önceki Sorun:** PageInspector SET_ENABLED handler'da early return vardı. Eğer STOP message kaybolursa, state `enabled=true` kalıyordu ve restart engelleniyordu.

**Bug Flow:**
```
1. Inspector START → this.inspectorEnabled = true
       ↓
2. Inspector STOP → STOP message lost (error suppressed in popup.js)
       ↓
3. this.inspectorEnabled still TRUE (never got stop message)
       ↓
4. User clicks START again → enabled=true, this.inspectorEnabled=true
       ↓
5. Early return: if (this.inspectorEnabled === enabled) return;
       ↓
6. Collectors NEVER restart! ❌
```

### Solution: Force Restart on State Mismatch

**PageInspector.js** `_setupControlListener()`:

```javascript
if (event.data.type === 'SET_ENABLED') {
  const enabled = event.data.enabled;

  // If already in the requested state AND trying to enable, force restart
  if (this.inspectorEnabled === enabled && enabled === true) {
    logger.info(LOG_PREFIX.INSPECTOR, `Already enabled, forcing collector restart`);
    await this._stopAllCollectors();  // Clean stop first
  }

  // If trying to disable when already disabled, skip
  if (this.inspectorEnabled === enabled && enabled === false) {
    return;
  }

  this.inspectorEnabled = enabled;

  if (enabled) {
    logger.setEnabled(true);  // Enable logging BEFORE start to capture collector logs
    await this._startAllCollectors();
  } else {
    await this._stopAllCollectors();
    logger.setEnabled(false);  // Disable logging AFTER stop
  }
}
```

**Key Points:**
- ✅ Detects state mismatch (`enabled=true` but `this.inspectorEnabled=true`)
- ✅ Forces clean stop before restart
- ✅ Idempotent: allows legitimate stop when already stopped
- ✅ Collectors have their own `this.active` guards (prevents double-start)

**Benefit:** Handles lost STOP messages gracefully - collectors always restart properly.

## Clean Slate Approach (Stale Data Prevention)

Start'ta TÜM önceki state temizlenir - bu sayede stale data sorunları önlenir:

**AudioContextCollector.js** `start()`:

```javascript
async start() {
  this.active = true;

  // ═══════════════════════════════════════════════════════════════════
  // CLEAN SLATE: Clear ALL previous state on start
  // ═══════════════════════════════════════════════════════════════════

  // 1. Clear activeContexts Map
  this.activeContexts.clear();
  this.contextIdCounter = 0;

  // 2. Clean up closed contexts from EarlyHook registry
  cleanupClosedAudioContexts();

  // 3. Re-register WASM encoder handler
  window.__wasmEncoderHandler = (encoderInfo) => this._handleWasmEncoder(encoderInfo);

  // 4. Clear stale WASM encoder detection
  window.__wasmEncoderDetected = null;

  // 5. Sync ONLY running contexts from registry
  const registry = getInstanceRegistry();
  for (const { instance } of registry.audioContexts) {
    if (instance.state === 'closed') continue;
    this._handleNewContext(instance, true);
  }
}
```

**Neden Gerekli:**
- Tab switch sonrası eski encoding verisi görünmemeli
- Stop sonrası veriler "geçmiş kayıt" olarak kalır (review için)
- Start = sıfırdan başla (fresh start)

**cleanupClosedAudioContexts():** (`EarlyHook.js`)
- Registry'den `state === 'closed'` olan context'leri temizler
- Memory leak ve stale data birikimini önler

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

## Stream Registry (Collector Koordinasyonu)

Mikrofon (giden ses) ve remote (gelen ses) stream'lerini ayırt etmek için collector'lar arası koordinasyon:

```
getUserMedia() → streamRegistry.microphone.add(stream.id)
                      ↓
RTCPeerConnection.ontrack → streamRegistry.remote.add(stream.id)
                      ↓
createMediaStreamSource() → registry lookup → inputSource
                      ↓
popup.js → filterOutgoingContexts() → sadece 'microphone' göster
```

Detaylı bilgi: **collectors** skill'i

## Constants Mirroring (popup.js ↔ constants.js)

popup.js ES module olmadığı için `src/core/constants.js`'den import edemez. Bu yüzden bazı sabitler duplicate edilir:

```javascript
// popup.js - MUST be kept in sync with src/core/constants.js
const DESTINATION_TYPES = {
  SPEAKERS: 'speakers',
  MEDIA_STREAM: 'MediaStreamDestination'
};
const MAX_AUDIO_CONTEXTS = 4; // UI_LIMITS.MAX_AUDIO_CONTEXTS
```

**Senkronizasyon:** constants.js'de değişiklik yapıldığında popup.js'i de güncelle!

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
│   └── constants.js        # streamRegistry, DATA_TYPES, DESTINATION_TYPES
└── page/PageInspector.js   # Ana orkestratör
```

## Debug

```javascript
window.__pageInspector      // Inspector instance
window.__wasmEncoderDetected  // WASM encoder tespit bilgisi
```
