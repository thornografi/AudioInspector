---
name: skill-controller
description: "Skill sağlığı ve tutarlılık denetimi. SKILL.md validasyonu, settings.json senkronizasyonu, duplicate tespiti. Anahtar kelimeler: skill audit, skill kontrol, senkronizasyon, duplicate, validation, routing"
---

# Skill Controller

Skill dosyalarının sağlığını ve tutarlılığını denetler.

## Denetim Kapsamı

### 1. Envanter Kontrolü
- `.claude/skills/` altındaki tüm SKILL.md dosyalarını tara
- **Orphan**: Klasör var ama `settings.json`'da kayıtlı değil
- **Missing**: `settings.json`'da var ama klasör/dosya yok

### 2. SKILL.md Validasyonu

```yaml
---
name: klasor-adi-ile-ayni  # ZORUNLU
description: "..."         # ZORUNLU, anahtar kelimeler içermeli
---
```

Kontroller:
- YAML frontmatter geçerli mi?
- `name` klasör adıyla eşleşiyor mu?
- `description` tetikleyici anahtar kelimeler içeriyor mu?

### 3. Duplicate/Hardcode Tespiti
- Tekrarlayan içerikler
- Çakışan anahtar kelimeler
- Hardcoded değerler (constants.js'de olmalı)

### 4. Güncellik Kontrolü
- Referans edilen dosya yolları hâlâ mevcut mu?
- Kod değişiklikleri skill'e yansıtılmış mı?

## Audit Raporu

```
## Skill Audit - [Tarih]

### Özet
- Toplam: X | Sağlıklı: X | Sorunlu: X

### Kritik
- [Sorun + dosya yolu + çözüm]

### Uyarı
- [Sorun açıklaması]

### Manuel Aksiyon
- [Kullanıcı kararı gereken]
```

## Kurallar

1. Silme/değiştirme işlemlerinde kullanıcı onayı al
2. settings.json ve CLAUDE.md'yi senkron tut
3. Türkçe iletişim, teknik terimler İngilizce kalabilir
