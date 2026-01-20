# Lifecycle & Cleanup

Extension yaşam döngüsü olayları ve temizlik mekanizmaları.

## Temizleme Tetikleyicileri

| Event | Listener | Temizlenen |
|-------|----------|------------|
| Extension yüklenme/güncelleme | `onInstalled` | Tüm state + data + logs |
| Chrome başlatılma | `onStartup` | Tüm state + data + logs |
| Kilitli tab kapatılma | `tabs.onRemoved` | Tüm state + data + logs |
| Kilitli tab'ın penceresi kapatılma | `windows.onRemoved` | Tüm state + data + logs |
| Cross-origin navigation | `tabs.onUpdated` | Tüm state + data + logs |
| Tab switch (monitoring sırasında) | `tabs.onActivated` | Sadece `inspectorEnabled` |
| Window switch (monitoring sırasında) | `windows.onFocusChanged` | Sadece `inspectorEnabled` |

## clearInspectorData() Helper'ları

Üç farklı dosyada tanımlı, **kasıtlı farklar** var:

```javascript
// background.js - TAM TEMİZLİK (lifecycle events için)
function clearInspectorData(options = {}) {
  const keys = ['inspectorEnabled', 'lockedTab', 'debug_logs', 'pendingAutoStart', ...DATA_STORAGE_KEYS];
  if (options.includeAutoStopReason) {
    keys.push('autoStoppedReason');
  }
  return chrome.storage.local.remove(keys);
}

// content.js & popup.js - LOGLAR KORUNUR
function clearInspectorData(callback) {
  chrome.storage.local.remove(['inspectorEnabled', 'lockedTab', 'pendingAutoStart', ...DATA_STORAGE_KEYS], callback);
}
```

| Helper | Dosya | debug_logs | Kullanım |
|--------|-------|------------|----------|
| `clearInspectorData()` | background.js | ✅ Siler | Tab close, navigation |
| `clearInspectorData()` | content.js | ❌ Korur | User actions |
| `clearInspectorData()` | popup.js | ❌ Korur | UI actions |
| `clearMeasurementData()` | Tümü | ❌ Korur | Sadece DATA_STORAGE_KEYS |

## windows.onRemoved Pattern

Sadece kilitli tab'ın penceresi kapatılınca temizlik:

```javascript
// background.js
chrome.windows.onRemoved.addListener(async (windowId) => {
  const result = await chrome.storage.local.get(['lockedTab']);
  if (!result.lockedTab) return;

  try {
    await chrome.tabs.get(result.lockedTab.id);
    // Tab hala var → farklı pencere kapatılmış, hiçbir şey yapma
  } catch (e) {
    // Tab artık yok → kilitli tab'ın penceresi kapatıldı
    await clearInspectorData();
    updateBadge(false);
  }
});
```

## Auto-Stop Mekanizması

Inspector aktifken başka tab/window'a geçişte otomatik durdurma.

**Tetikleyiciler:**
- `tabs.onActivated` - Tab değişimi
- `windows.onFocusChanged` - Window değişimi
- `tabs.onUpdated` - Cross-origin navigation

**autoStoppedReason Değerleri:**

| Değer | Açıklama |
|-------|----------|
| `'tab_switch'` | Başka tab'a geçildi |
| `'window_switch'` | Farklı pencereye geçildi |
| `'navigation'` | Cross-origin navigation |
| `'origin_change'` | Origin değişikliği (content.js) |
| `'injection_failed'` | Script enjeksiyonu başarısız |

**Akış:**
```
Tab switch → background.js auto-stop
    ↓
storage.set({ autoStoppedReason: 'tab_switch' })
storage.remove('inspectorEnabled')
    ↓
storage.onChanged tetiklenir
    ↓
popup.js checkTabLock() → showAutoStopBanner(reason)
```

## Data Reset Flow (MediaRecorder.start)

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
