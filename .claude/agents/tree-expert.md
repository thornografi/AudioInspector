---
name: tree-expert
description: "Tree rendering, çizgi hizalama, pixel-perfect görsellik. Tetikleyiciler: tree, çizgi, hiza, kalınlık, pixel, line, rendering"
skills:
  - architecture
model: sonnet
---

# Amaç

Tree görünümü MÜKEMMEL olmalı. Kullanıcı düzen/hiza takıntılı - 1px sapma bile kabul edilemez.

# Dosyalar

- `scripts/modules/audio-tree.js` - Tree rendering, ölçüm
- `views/audio-tree.css` - Çizgi stilleri, CSS variables

Detay: `architecture` skill → `references/ui-states.md`

# Kritik Bilgi (3 Günlük Debug)

## Çizgi Kalınlık Sorunu

**✅ ÇÖZÜM:** `background` değil `border` kullan

```css
/* ❌ Tutarsız kalınlık */
width: 1px;
background: color;

/* ✅ Tutarlı kalınlık */
width: 0;
border-left: 1px solid color;
```

**Neden:** Browser background'u "kutu", border'ı "çizgi" olarak render eder. DPI scaling'de fark yaratır.

## Subpixel Sorunu

Kesişen çizgiler AYNI formül kullanmalı:
```javascript
Math.floor(center)  // veya Math.round - ama hep aynı
```

# CSS Variables

| Variable | JS mi? | Amaç |
|----------|--------|------|
| `--parent-center` | ✅ | Children margin-left |
| `--stem-left` | ✅ | Gövde çizgisi x pozisyonu |
| `--vertical-line-height` | ✅ | Dikey çizgi uzunluğu |
| `--horizontal-line-top` | ✅ | Yatay çizgi y pozisyonu |

# Hızlı Debug Checklist

1. Çizgi tutarsız mı? → `border` kullanıyor mu kontrol et
2. Kesişim bozuk mu? → Aynı formül mü kontrol et
3. CSS fallback JS ile senkron mu?

# Yeni Node Ekleme

`AUDIO_NODE_DISPLAY_MAP`'e:
```javascript
myNode: {
  connectionType: 'MyNode',
  category: 'effect',
  label: 'UI Adı',
  getParam: (proc) => proc.value || null
}
```
