# MangaDex Injected Translate

**English** | [Türkçe](#türkçe)

---

## English

Firefox (MV2) extension: translates manga pages in the MangaDex reader to Turkish with Google Image Translate. The translation is painted directly onto the page image; one click toggles between original and translation.

### How it works

- **3-tab Google pool:** translations run through `translate.google.com/?op=images` automation (3 parallel, background tabs). The tabs are part of the engine; they close themselves when idle.
- **Windowed queue:** visible page first (±3), then one page per cycle forward. When a chapter finishes, the **next chapter is pre-translated** in the background.
- **Byte-hash identity:** every page is recognized by SHA-256, so the translation lands on the right page even when the reader renders out of order.
- **Chapter isolation:** each chapter has its own cache (LRU, 3 chapters). A previous chapter's result can never be painted onto the new chapter (chapter gate + idx/chapter guard).
- **Click-to-zoom:** clicking a translated image opens an enlarged overlay.
- **OCR fallback:** Tesseract runs in the background (CSP requires background execution).

### Install (development)

1. `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `manifest.json`.
2. On a MangaDex chapter page, press `▶` (manual start required on first run).
3. Note: temporary add-ons are removed when Firefox closes; reload on each start.

### Packaging the XPI

```bash
python3 -c "
import zipfile, os
root='.'
out='mangadex-injected-translate.xpi'
skip_dirs={'tools','src_orig','.git','__pycache__'}
skip_files={'mangadex-injected-translate.xpi'}
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for dp,dn,fn in os.walk(root):
        dn[:] = [d for d in dn if d not in skip_dirs]
        for f in fn:
            if f in skip_files or f.endswith('.pyc'): continue
            p=os.path.join(dp,f)
            z.write(p, os.path.relpath(p,root))
"
```

### File layout

```
manifest.json   # MV2, v2.8.x
src/content.js  # reader side: queue, identity, restore, zoom
src/background.js # Google pool (3 tabs), push guarantee
src/translate_google.js # pool-tab automation
src/content.css # badge/button/overlay styles
icons/          # extension icons
tools/          # fxconsole.py (headless test), fxmeasure.py, logserver.py
```

### License

MIT — see `LICENSE`.

---

## Türkçe

Firefox (MV2) eklentisi: MangaDex okuyucuda manga sayfalarını Google Görsel Çeviri ile Türkçeye çevirir. Çeviri doğrudan sayfadaki resmin üstüne basılır, orijinal↔çeviri geçişi tek tıkla yapılır.

### Nasıl çalışır?

- **3 sekmelik Google havuzu:** çeviriler `translate.google.com/?op=images` otomasyonuyla yapılır (3 paralel, pasif sekme). Sekmeler motorun parçasıdır; iş bitince kendiliğinden kapanır.
- **Pencere kuyruk:** önce görünen sayfa (±3), sonra ileri doğru tur başına 1 sayfa. Chapter bitince **sonraki chapter önden** çevrilir.
- **Bayt-hash kimlik:** her sayfa SHA-256 ile tanınır; okuyucu karışık sırada render etse bile çeviri doğru sayfaya basılır.
- **Chapter izolasyonu:** her chapter'ın önbelleği ayrı (LRU 3 chapter). Eski chapter sonucu yeni chapter'a basılamaz (chapter kapısı + idx/chapter bekçisi).
- **Tıklayınca zoom:** çevrilmiş resme tıklayınca büyütülmüş overlay açılır.
- **OCR yedeği:** Tesseract arka planda (CSP nedeniyle background'da koşar).

### Kurulum (geliştirme)

1. `about:debugging` → **Bu Firefox** → **Geçici eklenti yükle** → `manifest.json` dosyasını seç.
2. MangaDex chapter sayfasında `▶` düğmesine bas (ilk çalıştırmada manuel başlatma gerekir).
3. Not: geçici eklentiler Firefox kapatılınca silinir; her açılışta yeniden yüklenir.

### XPI paketleme

```bash
python3 -c "
import zipfile, os
root='.'
out='mangadex-injected-translate.xpi'
skip_dirs={'tools','src_orig','.git','__pycache__'}
skip_files={'mangadex-injected-translate.xpi'}
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for dp,dn,fn in os.walk(root):
        dn[:] = [d for d in dn if d not in skip_dirs]
        for f in fn:
            if f in skip_files or f.endswith('.pyc'): continue
            p=os.path.join(dp,f)
            z.write(p, os.path.relpath(p,root))
"
```

### Dosya yapısı

```
manifest.json   # MV2, v2.8.x
src/content.js  # okuyucu tarafı: kuyruk, kimlik, restore, zoom
src/background.js # Google havuzu (3 sekme), push garantisi
src/translate_google.js # havuz sekmesi otomasyonu
src/content.css # rozet/buton/overlay stilleri
icons/          # eklenti ikonları
tools/          # fxconsole.py (headless test), fxmeasure.py, logserver.py
```

### Lisans

MIT — bkz. `LICENSE`.
