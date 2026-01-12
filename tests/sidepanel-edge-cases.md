# Side Panel Toggle - Edge Case Tests

Extension'ı reload ettikten sonra aşağıdaki testleri sırayla uygula.

## Test 1: Temel Toggle
- [ ] Icon'a tıkla → Panel açılmalı
- [ ] Tekrar tıkla → Panel kapanmalı
- [ ] Tekrar tıkla → Panel açılmalı (tek tıklama)

## Test 2: X Butonu ile Kapatma
- [ ] Panel açıkken X butonuna tıkla → Panel kapanmalı
- [ ] Icon'a tıkla → Panel açılmalı (TEK tıklama yeterli olmalı)

## Test 3: Tab Kapatma
- [ ] Panel açıkken tab'ı kapat
- [ ] Yeni tab aç, aynı sayfaya git
- [ ] Icon'a tıkla → Panel açılmalı (tek tıklama)

## Test 4: Tab Değiştirme
- [ ] Tab A'da panel aç
- [ ] Tab B'ye geç
- [ ] Tab B'de icon'a tıkla → Panel açılmalı
- [ ] Tab A'ya geri dön → Panel hala açık olmalı (veya state'e bağlı)
- [ ] Tab A'da icon'a tıkla → Panel kapanmalı

## Test 5: Sayfa Yenileme
- [ ] Panel açıkken sayfayı yenile (F5)
- [ ] Icon'a tıkla → Beklenen davranış: toggle çalışmalı

## Test 6: Birden Fazla Tab
- [ ] Tab 1'de panel aç
- [ ] Tab 2'de panel aç
- [ ] Tab 1'de icon'a tıkla → Tab 1 paneli kapanmalı
- [ ] Tab 2'de icon'a tıkla → Tab 2 paneli kapanmalı

## Test 7: Hızlı Tıklama (Rapid Click)
- [ ] Icon'a hızlıca 3-4 kez tıkla
- [ ] Panel stabil olmalı (açık veya kapalı, race condition olmamalı)

## Test 8: Browser Restart
- [ ] Panel açıkken Chrome'u kapat
- [ ] Chrome'u tekrar aç
- [ ] Icon'a tıkla → Panel açılmalı (tek tıklama)

---

## Sonuç

| Test | Durum | Not |
|------|-------|-----|
| Test 1 |  |  |
| Test 2 |  |  |
| Test 3 |  |  |
| Test 4 |  |  |
| Test 5 |  |  |
| Test 6 |  |  |
| Test 7 |  |  |
| Test 8 |  |  |

## Debug

Sorun olursa:
1. `chrome://extensions/` → AudioInspector → "Service worker" linkine tıkla
2. Console'da hataları kontrol et
3. `panelOpenTabs` state'ini görmek için: console'da extension context yok ama log mesajları görünür
