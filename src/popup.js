// Popup JS
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') var browser = chrome;
const $ = id => document.getElementById(id);

async function init() {
  const settings = await browser.storage.local.get({
    targetLang: 'tr',
    ocrLang: 'eng',
    autoTranslate: false,
    translateMode: 'google_direct'
  });
  $('targetLang').value = settings.targetLang;
  $('ocrLang').value = settings.ocrLang;
  $('autoTranslate').checked = settings.autoTranslate;
  $('translateMode').value = settings.translateMode || 'google_direct';
  updateModeHint();
  $('targetLang').addEventListener('change', e => browser.storage.local.set({ targetLang: e.target.value }));
  $('ocrLang').addEventListener('change', e => browser.storage.local.set({ ocrLang: e.target.value }));
  $('autoTranslate').addEventListener('change', e => browser.storage.local.set({ autoTranslate: e.target.checked }));
  $('translateMode').addEventListener('change', e => {
    browser.storage.local.set({ translateMode: e.target.value });
    updateModeHint();
  });
  function updateModeHint(){
    const h=$('modeHint');
    if(!h) return;
    if($('translateMode').value==='google_direct'){
      h.textContent='Google Görsel: translate.google.com/?op=images doğrudan kullanılır (en doğru, önerilen). Görsel jpeg/png/webp yapılır.';
    } else {
      h.textContent='Yerel OCR: Cihazdaki Tesseract ile okunur, sonra Google metin çeviri. Google görsel kadar iyi değil ama çevrimdışı OCR sağlar.';
    }
  }

  $('translateAll').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    if (!tabs[0].url.includes('mangadex.org')) {
      showStatus('Bu eklenti sadece mangadex.org üzerinde çalışır', 'err');
      return;
    }
    browser.tabs.sendMessage(tabs[0].id, { action: 'translateAll' }).catch(()=>{});
    showStatus('Çevirme başlatıldı - sayfadaki G Çevir butonlarına bak', 'ok');
    setTimeout(()=>window.close(), 1200);
  });

  $('clearAll').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      browser.tabs.sendMessage(tabs[0].id, { action: 'clearAll' }).catch(()=>{
        browser.tabs.executeScript(tabs[0].id, {
          code: `document.querySelectorAll('canvas.mgc-canvas-overlay, img.mgc-image-overlay, .mgc-badge, .mgc-toggle-original').forEach(e=>e.remove());
                 document.querySelectorAll('.mgc-translate-btn').forEach(b=>{b.classList.remove('translated');b.disabled=false;b.dataset.busy='0';b.innerHTML='<span style="font-weight:700">G</span> Çevir';});`
        }).catch(()=>{});
      });
    }
    showStatus('Temizlendi', 'ok');
  });

  $('openOptions').addEventListener('click', e => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });

  // Durum: aktif sekme mangadex mi?
  browser.tabs.query({ active:true, currentWindow:true }).then(tabs=>{
    if (!tabs[0]?.url?.includes('mangadex.org')) {
      $('translateAll').disabled = true;
      $('translateAll').style.opacity = 0.5;
      $('translateAll').textContent = 'Sadece MangaDex\'te çalışır';
    }
  });
}

function showStatus(msg, cls) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + cls;
}

document.addEventListener('DOMContentLoaded', init);
