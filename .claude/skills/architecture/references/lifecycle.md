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

## clearInspectorData() - Centralized Pattern

**SINGLE SOURCE OF TRUTH:** `background.js`

Tüm script'ler merkezi fonksiyonu message ile çağırır:

```javascript
// background.js - Merkezi implementasyon
function clearInspectorData(options = {}) {
  const { includeAutoStopReason = false, includeLogs = true, dataOnly = false } = options;
  // dataOnly: sadece ölçüm verileri, state korunur
  // includeLogs: debug_logs dahil mi (background.js default true)
}

// content.js & popup.js - Message ile çağırır
chrome.runtime.sendMessage({
  type: 'CLEAR_INSPECTOR_DATA',
  options: { includeLogs: false }  // veya { dataOnly: true }
}, callback);
```

| Çağıran | Options | debug_logs | Kullanım |
|---------|---------|------------|----------|
| background.js (doğrudan) | `{}` | ✅ Siler | Tab close, navigation |
| content.js (message) | `{ includeLogs: false }` | ❌ Korur | User actions |
| popup.js (message) | `{ includeLogs: false }` | ❌ Korur | UI actions |
| Tümü | `{ dataOnly: true }` | ❌ Korur | Sadece DATA_STORAGE_KEYS |

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
| `'new_recording'` | İkinci kayıt başladı (MediaRecorder.start) |

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
