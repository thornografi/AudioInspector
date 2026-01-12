# AudioInspector - UI Test Scenarios

## Test Environment Setup
1. Chrome'da extension yüklü olmalı
2. Test için 2-3 farklı sekme açık (google.com, youtube.com, etc.)
3. DevTools (F12) Console açık olmalı (hata kontrolü için)

---

## 🧪 Test Scenarios

### Scenario 1: Basic Start/Stop Toggle
**Steps:**
1. Extension icon'una tıkla → Sidebar açılsın
2. Start butonuna bas
3. Status'un "Started" olduğunu doğrula
4. Log'da "✅ Inspector started" görünmeli
5. Stop butonuna bas
6. Status'un "Stopped" olduğunu doğrula
7. Log'da "⏸️ Inspector stopped" görünmeli

**Expected Result:**
- ✅ Buton toggle'ı sorunsuz çalışmalı
- ✅ Status label anında güncellenmeli
- ✅ Loglar anında görünmeli
- ✅ Recording animasyonu (kırmızı dot) start'ta başlamalı

**Potential Issues:**
- ❌ Log'lar gecikmeli gelebilir
- ❌ Race condition: Hızlı start-stop toggle

---

### Scenario 2: Tab Switch (Same Window)
**Steps:**
1. Tab A'da sidebar aç, Start'a bas
2. Tab B'ye geç (sidebar açık kalsın)
3. Tab B'de herhangi bir aktivite var mı kontrol et
4. Tab A'ya geri dön
5. Data hala günceleniyor mu kontrol et

**Expected Result:**
- ✅ Tab A'dan Tab B'ye geçerken sidebar kapanmamalı
- ✅ Tab B'de inspector çalışmamalı (targetTabId Tab A)
- ✅ Tab A'ya dönünce data güncellenmeye devam etmeli

**Potential Issues:**
- ❌ `currentWindow: true` query yanlış tab'ı hedefleyebilir
- ❌ Sidebar'ın hangi tab'ı izlediği belirsiz kalabilir

---

### Scenario 3: Page Navigation (Same Tab)
**Steps:**
1. Tab'da google.com aç, sidebar aç, Start'a bas
2. Aynı tab'da youtube.com'a git
3. Sidebar'a bak - data durdu mu?
4. Stop/Start yap
5. Yeni sayfada çalışıyor mu?

**Expected Result:**
- ✅ Sayfa değişince content script yeniden inject edilmeli
- ✅ Inspector state persist etmeli (storage'da)
- ✅ Stop/Start yapınca yeni sayfada da çalışmalı

**Potential Issues:**
- ❌ Page navigation'da content script inject olmayabilir
- ❌ SPA'larda (Single Page Apps) soft navigation detect edilemeyebilir
- ❌ Inspector state lost olabilir

---

### Scenario 4: Page Refresh (F5)
**Steps:**
1. Tab'da sidebar aç, Start'a bas
2. F5 ile sayfayı yenile
3. Sidebar açık kaldı mı?
4. Inspector state korundu mu?
5. Loglar sıfırlandı mı?

**Expected Result:**
- ✅ Sidebar açık kalmalı (Chrome side panel persist)
- ✅ Inspector state storage'dan restore edilmeli
- ✅ Loglar temizlenmeli (yeni session)

**Potential Issues:**
- ❌ State restore gecikmeli olabilir
- ❌ Eski loglar kalabilir

---

### Scenario 5: Extension Reload
**Steps:**
1. Sidebar açık, inspector started
2. chrome://extensions/ → Extension'ı reload et
3. Sidebar kapandı mı?
4. Tekrar aç, state korunmuş mu?

**Expected Result:**
- ✅ Sidebar kapanmalı (service worker restart)
- ✅ State sıfırlanmalı (background.js onInstalled)
- ✅ Kullanıcı manuel Start yapmalı

**Potential Issues:**
- ❌ State restore gecikmeli olabilir

---

### Scenario 6: Multiple Tabs with Sidebar
**Steps:**
1. Tab A'da sidebar aç, Start'a bas
2. Tab B'de extension icon'una tıkla
3. İkinci bir sidebar açıldı mı?
4. Her iki sidebar farklı tab'ları mı izliyor?

**Expected Result:**
- ✅ Her tab için ayrı sidebar açılabilmeli
- ⚠️ Her sidebar kendi tab'ını izlemeli (targetTabId)
- ⚠️ Start/Stop state global (storage'da tek bir flag)

**Potential Issues:**
- ❌ targetTabId logic karışabilir
- ❌ İki sidebar aynı tab'ı izleyebilir
- ❌ Global state yüzünden conflict

---

### Scenario 7: Data Persistence
**Steps:**
1. Sidebar aç, Start'a bas
2. WhatsApp Web'de sesli arama yap
3. RTC stats görünüyor mu?
4. Stop'a bas
5. Data temizlendi mi?
6. Start'a bas
7. Eski data geri geldi mi?

**Expected Result:**
- ✅ Start'tayken data sürekli güncellenmeli
- ✅ Stop'ta data temizlenmeli
- ✅ Yeniden Start'ta boş başlamalı

**Potential Issues:**
- ❌ Stop'ta data temizlenmeyebilir
- ❌ Eski data cache'de kalabilir

---

### Scenario 8: Clear Data Button
**Steps:**
1. Sidebar'da data varken Clear butonuna bas
2. Sidebar reload oldu mu?
3. Tüm data temizlendi mi?
4. Loglar da temizlendi mi?

**Expected Result:**
- ✅ Storage tamamen temizlenmeli
- ✅ Sayfa reload olmalı
- ✅ Inspector state "Stopped" olmalı

**Potential Issues:**
- ❌ Platform info da silinebilir (istenmeyen)
- ❌ Reload sonrası state inconsistent olabilir

---

### Scenario 9: Export Data
**Steps:**
1. Inspector started, data toplandı
2. Export butonuna bas
3. JSON dosyası indirildi mi?
4. İçeriği doğru mu?

**Expected Result:**
- ✅ JSON formatında dosya indirilmeli
- ✅ Timestamp'li filename olmalı
- ✅ Tüm collector data'sı içinde olmalı

**Potential Issues:**
- ❌ Data null ise alert gösterilmeli
- ❌ Büyük data'da performance sorunu

---

### Scenario 10: Log Console Interactions
**Steps:**
1. Sidebar'da 20+ log biriktir
2. Scroll çalışıyor mu?
3. Copy Logs butonuna bas - clipboard'a kopyalandı mı?
4. Clear Logs butonuna bas - sadece loglar temizlendi mi?

**Expected Result:**
- ✅ Auto-scroll en alta olmalı (yeni log gelince)
- ✅ Copy başarılı olunca "Copied!" feedback
- ✅ Clear sadece logları silmeli (data değil)

**Potential Issues:**
- ❌ 100+ log'da performance düşer
- ❌ Copy büyük data'da fail olabilir

---

### Scenario 11: Rapid Toggle (Stress Test)
**Steps:**
1. Start-Stop-Start-Stop 5 kere hızlıca bas (1 saniyede)
2. UI freeze oldu mu?
3. State tutarlı mı?
4. Loglar duplicate mi?

**Expected Result:**
- ✅ UI responsive kalmalı
- ✅ Final state doğru olmalı
- ✅ Race condition olmamalı

**Potential Issues:**
- ❌ Storage write race condition
- ❌ Multiple collector start/stop conflict
- ❌ Duplicate log entries

---

### Scenario 12: No Content Script (Chrome Pages)
**Steps:**
1. chrome://extensions/ sayfasını aç
2. Extension icon'una tıkla
3. Sidebar açıldı mı?
4. Start'a bas - ne olur?

**Expected Result:**
- ✅ Sidebar açılmalı
- ⚠️ Start yapınca hata olmamalı (graceful fail)
- ⚠️ Log'da "No content script on this page" gibi mesaj olabilir

**Potential Issues:**
- ❌ Uncaught exception
- ❌ UI donabilir

---

### Scenario 13: Network Disconnected
**Steps:**
1. DevTools → Network → Offline yap
2. Sidebar'da Start'a bas
3. Inspector çalışıyor mu?
4. Network'ü aç
5. Data gelmeye devam ediyor mu?

**Expected Result:**
- ✅ Local inspector çalışmalı (network'e ihtiyaç yok)
- ✅ WebRTC stats lokal olarak toplanabilir

**Potential Issues:**
- ❌ WebRTC bağlantı kurulamazsa stats yok

---

## 🔍 Manual Testing Checklist

### Visual Tests
- [ ] Recording animation (pulsing red dot) çalışıyor
- [ ] Status badge rengi değişiyor (gray → red)
- [ ] Buton text toggle oluyor (Start ↔ Stop)
- [ ] Log colors doğru (error=red, success=green, info=blue)
- [ ] Dark theme consistency
- [ ] Grid layout collapse etmiyor
- [ ] Scrollbar görünüyor (loglar çok olunca)

### Functional Tests
- [ ] Storage persistence (refresh sonrası)
- [ ] Tab switch handling
- [ ] Multiple sidebar instances
- [ ] Export/Clear operations
- [ ] Log copy/clear operations
- [ ] Badge icon update (background.js)

### Edge Cases
- [ ] Empty data state (no connections)
- [ ] Very long log messages (overflow)
- [ ] 100+ log entries (performance)
- [ ] Rapid button clicks
- [ ] Extension reload during operation

---

## 🐛 Known Issues & Limitations

### Current Limitations:
1. **Single Global State**: `inspectorEnabled` global - her tab ayrı başlatılamaz
2. **Tab Targeting**: Sidebar hangi tab'ı izlediği belirsiz olabilir
3. **No Visual Feedback**: Start'a basınca mesaj gelmezse kullanıcı beklenir
4. **No Error Handling**: Content script yoksa graceful fail yok

### Potential Bugs:
1. **Race Condition**: Storage write overlap (rapid toggle)
2. **Memory Leak**: 100+ log history sınırı var ama test edilmeli
3. **Stale Data**: Stop-Start arası data clear gecikmeli olabilir

---

## 🛠️ Debug Commands (Browser Console)

```javascript
// Check storage state
chrome.storage.local.get(null, (data) => console.table(data));

// Check inspector state (page context)
window.__pageInspector

// Check log history (page context)
window.__audioPipelineLogs

// Clear all storage
chrome.storage.local.clear()

// Force enable inspector
chrome.storage.local.set({ inspectorEnabled: true })

// Check content script logs
window.__contentScriptLogs
```

---

## 📊 Test Results Template

| Scenario | Status | Notes |
|----------|--------|-------|
| Basic Toggle | ✅ | Works |
| Tab Switch | ⚠️ | Sidebar tracks wrong tab |
| Page Navigation | ✅ | State restored |
| Page Refresh | ✅ | Clean logs |
| Extension Reload | ✅ | State reset OK |
| Multiple Sidebars | ❌ | Bug: same targetTabId |
| Data Persistence | ✅ | Clear on stop |
| Clear Data | ✅ | Full reset |
| Export Data | ✅ | JSON valid |
| Log Console | ✅ | Scroll + copy OK |
| Rapid Toggle | ⚠️ | Occasional lag |
| Chrome Pages | ❌ | No error handling |
| Network Offline | ✅ | Local works |

---

## 🎯 Priority Issues to Fix

### High Priority:
1. **Tab Targeting Bug**: `currentWindow: true` query yanlış tab döndürüyor
   - **Fix**: `chrome.tabs.query({active: true, currentWindow: true})` yerine sidebar'ın açıldığı tab'ı store et

2. **Multiple Sidebar Conflict**: Her sidebar aynı targetTabId kullanıyor
   - **Fix**: Her sidebar instance için unique ID, veya tab-specific state

3. **No Content Script Error**: Chrome pages'da Start'a basınca sessizce fail oluyor
   - **Fix**: Error state göster, "Cannot inspect this page" mesajı

### Medium Priority:
4. **Rapid Toggle Race**: Hızlı start-stop'ta state inconsistent
   - **Fix**: Debounce veya pending state flag

5. **Log Overflow**: 100+ log'da UI yavaşlıyor
   - **Fix**: Virtualized scroll veya pagination

### Low Priority:
6. **Visual Feedback**: Start'a basınca mesaj gelinceye kadar feedback yok
   - **Fix**: Loading spinner veya "Starting..." state

7. **Export Button Disabled**: Data yokken disable olabilir
   - **Fix**: Disabled state + tooltip

---

## 🚀 Next Steps

1. **Manual Test**: Bu senaryoları manuel test et, bug'ları not et
2. **Fix Priority Issues**: Yukarıdaki high priority bug'ları düzelt
3. **Automated Tests**: Playwright/Puppeteer ile otomatik test suite (future)
4. **User Testing**: Gerçek kullanıcılarla test (WhatsApp Web, Teams, Discord)
