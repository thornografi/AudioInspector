---
name: flow-expert
description: "Flow/Pipeline rendering, ok hizalama, split layout, pixel-perfect görsellik. Tetikleyiciler: flow, pipeline, ok, hiza, split, arrow, rendering"
skills:
  - architecture
model: sonnet
---

# Amaç

Flow/Pipeline görünümü MÜKEMMEL olmalı. Kullanıcı düzen/hiza takıntılı - 1px sapma bile kabul edilemez.

# Dosyalar

- `scripts/modules/audio-flow.js` - Flow rendering, ölçüm
- `views/audio-flow.css` - Ok stilleri, split layout, CSS variables

Detay: `architecture` skill → `references/ui-states.md`

# Terminoloji

| Eski (Tree) | Yeni (Flow) | Açıklama |
|-------------|-------------|----------|
| children | outputs | Sonraki node'lar (downstream) |
| parent | input | Önceki node (upstream) |
| tree-children | flow-outputs | Output container |
| has-children | has-outputs | Output var mı |
| fork | split | Dallanma noktası |

# CSS Variables

**Kaynak:** `views/audio-flow.css` → `.audio-flow` bloğu (satır 7-35)

## Spacing Hierarchy
```
--spacing-unit (base)
  ├─ --spacing-xs → --arrow-gap (ok boşlukları)
  ├─ --spacing-lg → --flow-row-height (label yüksekliği)
  └─ --spacing-xl → --split-gap (yan dallar arası)
```

## Dinamik Variables (JS tarafından set edilir)
| Variable | Kaynak | Amaç |
|----------|--------|------|
| `--main-arrow-left` | `measureFlowLabels()` | Dikey ok x pozisyonu (label merkezi) |

# Ok Rendering

**Yöntem:** SVG background-image (tek tasarım, `rotate()` ile yön değişir)

| Ok Yönü | CSS Selector | Transform |
|---------|--------------|-----------|
| Dikey (↓) | `.has-outputs::after` | yok (default) |
| Sağa (→) | `.is-split ... ::before` | `rotate(-90deg)` |
| Sola (←) | `.encoder-badge::before` | `rotate(90deg)` |

**SVG kaynağı:** `--arrow-svg` değişkeni (`audio-flow.css`)

# Split Layout

Birden fazla output varsa yatay layout:

```
[Input]
   ↓
[Splitter] → [Branch B] → [Branch C]
   ↓
[Branch A]
```

CSS class: `.is-split` - JS tarafından eklenir (node.outputs.length > 1)

# Hızlı Debug Checklist

1. Ok görünmüyor mu? → `.has-outputs` class var mı kontrol et
2. Split çalışmıyor mu? → `.is-split` class var mı kontrol et
3. Ok yanlış yerde mi? → `--arrow-left` JS tarafından set ediliyor mu

# Edge Cases

## Null Label Guard
Virtual node'larda (birden fazla root output) `node.label` null olabilir.
`renderNode()` bunu handle ediyor (`audio-flow.js:779-781`):
```javascript
const labelHtml = node.label
  ? `<span class="...">${escapeHtml(node.label)}</span>`
  : '';
```

## Deep Nesting Overflow
`.audio-flow` container'da `overflow-x: auto` aktif (`audio-flow.css:12`).
Çok derin pipeline'larda (5+ seviye) yatay scroll devreye girer.

## Cycle/Merge Detection
- **Cycle:** `visited` Set ile yakalanır → null döner, render edilmez
- **Merge (Diamond):** `globalSeen` ile first-win stratejisi

# Yeni Node Ekleme

`AUDIO_NODE_DISPLAY_MAP`'e:
```javascript
myNode: {
  connectionType: 'MyNode',
  category: 'effect',
  label: 'UI Adı',
  tooltip: 'MyNodeDescription',
  getParam: (proc) => proc.value || null
}
```
