if (typeof browser === 'undefined' && typeof chrome !== 'undefined') var browser = chrome;
const $ = id => document.getElementById(id);

async function load() {
  const s = await browser.storage.local.get({
    targetLang: 'tr',
    sourceLang: 'auto',
    ocrLang: 'eng',
    autoTranslate: false,
    showLensButton: true,
    translateMode: 'google_direct',
    keepTranslateTab: false
  });
  $('targetLang').value = s.targetLang;
  $('sourceLang').value = s.sourceLang;
  $('ocrLang').value = s.ocrLang;
  $('autoTranslate').checked = s.autoTranslate;
  $('showLensButton').checked = s.showLensButton;
  $('translateMode').value = s.translateMode || 'google_direct';
  $('keepTranslateTab').checked = s.keepTranslateTab || false;
  updateModeHint();
  $('translateMode').addEventListener('change', updateModeHint);
  function updateModeHint(){
    const hint=$('modeHint');
    if (!hint) return;
    if ($('translateMode').value==='google_direct'){
      hint.textContent='Google Görsel: Doğrudan translate.google.com/?op=images kullanılır, en doğru. Görsel otomatik jpeg/png/webp yapılır, 8MB üstü küçültülür.';
      hint.style.color='#1967D2';
    } else {
      hint.textContent='Yerel OCR: Tesseract.js cihazda çalışır, %0\'da takılırsa CDN engeli olabilir. Google moduna geçin.';
      hint.style.color='#5F6368';
    }
  }
}

$('save').addEventListener('click', async () => {
  await browser.storage.local.set({
    targetLang: $('targetLang').value,
    sourceLang: $('sourceLang').value,
    ocrLang: $('ocrLang').value,
    autoTranslate: $('autoTranslate').checked,
    showLensButton: $('showLensButton').checked,
    translateMode: $('translateMode').value,
    keepTranslateTab: $('keepTranslateTab').checked
  });
  const ok = $('ok');
  ok.style.display = 'block';
  setTimeout(()=> ok.style.display='none', 2000);
});

document.addEventListener('DOMContentLoaded', load);
