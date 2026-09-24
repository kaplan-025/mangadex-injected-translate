# MangaDex Injected Translate

Firefox (MV2) eklentisi: MangaDex okuyucuda manga sayfalarını Google Görsel Çeviri ile Türkçeye çevirir. Çeviri doğrudan sayfadaki resmin üstüne basılır, orijinal↔çeviri geçişi tek tıkla yapılır.

## Nasıl çalışır?

- **3 sekmelik Google havuzu:** çeviriler `translate.google.com/?op=images` otomasyonuyla yapılır (3 paralel, pasif sekme). Sekmeler motorun parçasıdır; iş bitince kendiliğinden kapanır.
- **Pencere kuyruk:** önce görünen sayfa (±3), sonra ileri doğru tur başına 1 sayfa. Chapter bitince **sonraki chapter önden** çevrilir.
- **Bayt-hash kimlik:** her sayfa SHA-256 ile tanınır; okuyucu karışık sırada render etse bile çeviri doğru sayfaya basılır.
- **Chapter izolasyonu:** her chapter'ın önbelleği ayrı (LRU 3 chapter). Eski chapter sonucu yeni chapter'a basılamaz (chapter kapısı + idx/chapter bekçisi).
- **Tıklayınca zoom:** çevrilmiş resme tıklayınca büyütülmüş overlay açılır.
- **OCR yedeği:** Tesseract arka planda (CSP nedeniyle background'da koşar).

## Kurulum (geliştirme)

1. `about:debugging` → **Bu Firefox** → **Geçici eklenti yükle** → `manifest.json` dosyasını seç.
2. MangaDex chapter sayfasında `▶` düğmesine bas (ilk çalıştırmada manuel başlatma gerekir).
3. Not: geçici eklentiler Firefox kapatılınca silinir; her açılışta yeniden yüklenir.

## XPI paketleme

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

## Dosya yapısı

```
manifest.json   # MV2, v2.8.x
src/content.js  # okuyucu tarafı: kuyruk, kimlik, restore, zoom
src/background.js # Google havuzu (3 sekme), push garantisi
src/translate_google.js # havuz sekmesi otomasyonu
src/content.css # rozet/buton/overlay stilleri
icons/          # eklenti ikonları
tools/          # fxconsole.py (headless test), fxmeasure.py, logserver.py
```

## Lisans

MIT — bkz. `LICENSE`.
