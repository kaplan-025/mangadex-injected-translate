// MangaDex Google Görsel Çeviri - Google Translate (op=images) otomasyonu
// Bu script translate.google.com.tr/?op=images sayfasında çalışır.
// Arka plandan gelen görseli otomatik yükler, çeviri sonucunu (blob) yakalar ve geri gönderir.

(() => {
  try {
    if (typeof globalThis.browser === 'undefined' && typeof globalThis.chrome !== 'undefined') globalThis.browser = globalThis.chrome;
    if (typeof browser === 'undefined' && typeof chrome !== 'undefined') browser = chrome;
  } catch(e){}

  const LOG = (...a) => { console.log('[MGC-GT]', ...a); console.log('[MGC-GT-VERBOSE]', ...a); };
  // Canlı log köprüsü: background üzerinden yereldeki log sunucusuna (tek yön, sessiz; VERBOSE hariç)
  const mgcLogBuf = [];
  let mgcLogTimer = null;
  function mgcRelay(a){
    try{
      let text;
      try{ text = a.map(x=> typeof x==='string' ? x : JSON.stringify(x)).join(' '); }
      catch(_){ text = String(a); }
      mgcLogBuf.push(text.slice(0, 500));
      if (mgcLogBuf.length > 200) mgcLogBuf.splice(0, mgcLogBuf.length - 200);
      if (!mgcLogTimer){
        mgcLogTimer = setTimeout(()=>{
          mgcLogTimer = null;
          const batch = mgcLogBuf.splice(0, mgcLogBuf.length);
          if (!batch.length) return;
          try{ browser.runtime.sendMessage({action:'mgcLog', lines: batch}).catch(()=>{}); }catch(_){}
        }, 3000);
      }
    }catch(_){}
  }
  // --- v2 injected capture: batchexecute URL/body yakala ---
  try{
    const _origFetch = window.fetch;
    window.fetch = async function(input, init){
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('batchexecute') && url.includes('WqWDPb')){
        console.log('[MGC-GT-CAPTURE] fetch batchexecute', url, init?.body?.slice(0,300));
        window._mgcLastBatchexecute = {url, body: init?.body, headers: init?.headers};
        try{ window.parent.postMessage({action:'mgcBatchexecuteCapture', url, body: init?.body}, '*'); }catch(e){}
        try{ browser.runtime.sendMessage({action:'mgcBatchexecuteCapture', url, body: init?.body}); }catch(e){}
      }
      return _origFetch.apply(this, arguments);
    };
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest){
      this._mgcUrl = url;
      this._mgcMethod = method;
      return _origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(body){
      if (this._mgcUrl && this._mgcUrl.includes('batchexecute') && this._mgcUrl.includes('WqWDPb')){
        console.log('[MGC-GT-CAPTURE] XHR batchexecute', this._mgcUrl, (body||'').slice(0,300));
        window._mgcLastBatchexecute = {url: this._mgcUrl, body};
        try{ window.parent.postMessage({action:'mgcBatchexecuteCapture', url: this._mgcUrl, body}, '*'); }catch(e){}
        try{ browser.runtime.sendMessage({action:'mgcBatchexecuteCapture', url: this._mgcUrl, body}); }catch(e){}
      }
      return _origSend.apply(this, [body]);
    };
    console.log('[MGC-GT] batchexecute interceptor aktif');
  }catch(e){ console.warn('[MGC-GT] interceptor fail', e); }
  try{ document.documentElement.dataset.mgcGt = '1'; }catch(e){}
  // NOT: ses-keepalive KALDIRILDI — autoplay engellinde play rozeti çıkarıyor, faydası yok.
  // Arka-plan kısmasına karşı beklemeler MutationObserver güdümlü (zamanlayıcı kısmasından etkilenmez).
  LOG('translate_google.js yüklendi', location.href);
  console.log('[MGC-GT] href', location.href, 'readyState', document.readyState);

  // Her translate sayfasında aktif ol, op=translate ise Resimler sekmesine geç
  if (!location.href.includes('translate.google')) {
    LOG('translate değil, pasif');
    return;
  }
  // Eğer op=images değilse, Resimler butonuna tıkla
  if (!location.href.includes('op=images')) {
    LOG('op=images değil, Resimler sekmesine geçiliyor', location.href);
    // Birkaç kez dene
    const tryClickImages = () => {
      const btn = document.querySelector('button[aria-label="Resim çevirisi"]') || document.querySelector('[jsname="SHEbFd"]') || Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Resimler'));
      if (btn) {
        LOG('Resimler butonu bulundu, tıklanıyor');
        btn.click();
        // URL'yi op=images yap
        if (!location.href.includes('op=images')) {
          const url = new URL(location.href);
          url.searchParams.set('op', 'images');
          history.replaceState(null, '', url.toString());
          LOG('URL op=images yapıldı', url.toString());
        }
        return true;
      }
      return false;
    };
    // Hemen dene, sonra 1sn sonra tekrar
    if (!tryClickImages()) {
      setTimeout(()=>tryClickImages(), 1000);
      setTimeout(()=>tryClickImages(), 2500);
    }
  }

  let pendingBlobUrl = null;
  let isProcessing = false;

  // Konsol sarmalayıcı: doğrudan console.log('[MGC-GT]...') çağrıları da köprüye aksın (VERBOSE hariç)
  try{
    const _origLog = console.log.bind(console);
    const _origWarn = console.warn.bind(console);
    const _origErr = console.error.bind(console);
    const _mgcRelayable = (a)=>{
      try{
        const f = String(a[0] ?? '');
        if (f.indexOf('[MGC-GT-VERBOSE') === 0) return false;
        return f.indexOf('[MGC') === 0;
      }catch(_){ return false; }
    };
    console.log = (...a)=>{ try{ _origLog(...a); }catch(_){} try{ if (_mgcRelayable(a)) mgcRelay(a); }catch(_){} };
    console.warn = (...a)=>{ try{ _origWarn(...a); }catch(_){} try{ mgcRelay(a); }catch(_){} };
    console.error = (...a)=>{ try{ _origErr(...a); }catch(_){} try{ mgcRelay(a); }catch(_){} };
  }catch(_){}

  // Background'a hazır olduğunu bildir (birkaç kez dene)
  function notifyReady() {
    try {
      browser.runtime.sendMessage({ action: 'translateTabReady', url: location.href });
    } catch(e){}
  }
  // Sayfa yüklenince ve 1-2 sn sonra tekrar bildir
  if (document.readyState === 'complete') notifyReady();
  else window.addEventListener('load', () => setTimeout(notifyReady, 800));
  setTimeout(notifyReady, 1500);
  setTimeout(notifyReady, 3500);

  // Mesaj dinle: background'dan görsel gelir (sekmeli v1)
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'doGoogleTranslate') {
      LOG('doGoogleTranslate alındı', msg.targetLang, msg.sourceLang, 'data len', msg.dataUrl?.length);
      handleUpload(msg.dataUrl, msg.targetLang, msg.sourceLang).then(result => {
        sendResponse(result);
      }).catch(e => {
        sendResponse({ error: e.message || String(e) });
      });
      return true; // async
    }
    if (msg.action === 'ping') {
      let hasInput = false, nImgs = 0, title = '';
      try{ hasInput = !!document.querySelector("input[type='file']"); }catch(e){}
      try{ nImgs = document.querySelectorAll('div.tyW0pd img').length; }catch(e){}
      try{ title = document.title.slice(0,60); }catch(e){}
      sendResponse({ ready: true, url: location.href, hasInput, nImgs, title });
    }
  });

  // v2 injected: parent (mangadex) -> iframe postMessage + el sıkışma teşhisi
  function mgcPostReady(){
    let hasInput = false, title='', nInputs=0, btns=[];
    try{ nInputs = document.querySelectorAll("input[type='file']").length; hasInput = !!document.querySelector("input[type='file'][accept*='image']") || nInputs>0; }catch(e){}
    try{ title = document.title.slice(0,40); }catch(e){}
    try{ btns = Array.from(document.querySelectorAll('button')).map(b=>(b.textContent||'').trim().slice(0,18)).filter(Boolean).slice(0,8); }catch(e){}
    try{ window.parent.postMessage({action:'mgcIframeReady', url: location.href, hasInput, nInputs, title, btns}, '*'); }catch(e){}
  }
  function mgcEnsureInput(){
    // Dar çerçevede Google girdiyi gizliyorsa: göz at düğmesine bas, girdiyi zorla aç
    try{
      if (document.querySelector("input[type='file'][accept*='image']") || document.querySelector("input[type='file']")) return true;
      const cand = document.querySelector('[jsname="DagSrd"]') || Array.from(document.querySelectorAll('button')).find(b=>/göz at|browse|dosya|parcourir|durchsuchen/i.test(b.textContent||''));
      if (cand){ cand.click(); console.log('[MGC-GT] browse düğmesine basıldı'); return 'clicked'; }
    }catch(e){}
    return false;
  }
  try{ mgcPostReady(); }catch(e){}
  setTimeout(()=>{ try{ mgcPostReady(); }catch(e){} }, 2500);
  setTimeout(()=>{ try{ mgcPostReady(); }catch(e){} }, 6000);
  window.addEventListener('message', (event)=>{
    const d = event.data;
    if (!d || d.action !== 'doGoogleTranslateInjected') return;
    // güvenlik: sadece mangadex.org'dan gelenleri kabul et (origin kontrolü gevşek * ile de çalışır)
    LOG('injected doGoogleTranslateInjected alındı', d.mangaUrl, 'idx', d.pageIdx, 'origin', event.origin);
    try{ event.source.postMessage({action:'injectedAck', mangaUrl: d.mangaUrl, pageIdx: d.pageIdx}, event.origin||'*'); }catch(e){ try{ window.parent.postMessage({action:'injectedAck', mangaUrl: d.mangaUrl, pageIdx: d.pageIdx}, '*'); }catch(e2){} }
    handleUpload(d.dataUrl, d.targetLang, d.sourceLang).then(result=>{
      const reply = {action:'injectedResult', mangaUrl: d.mangaUrl, pageIdx: d.pageIdx, dataUrl: result.dataUrl, error: result.error};
      try{ window.parent.postMessage(reply, '*'); }catch(e){}
      try{ window.top.postMessage(reply, '*'); }catch(e){}
      // aynı window içinde de yayınla (content script isolated world için)
      window.postMessage(reply, '*');
      // background üzerinden de yedek gönder (garanti)
      try{ browser.runtime.sendMessage({action:'googleTranslateResult', dataUrl: result.dataUrl, mangaUrl: d.mangaUrl}); }catch(e){}
    }).catch(e=>{
      const reply = {action:'injectedResult', mangaUrl: d.mangaUrl, pageIdx: d.pageIdx, error: e.message||String(e)};
      try{ window.parent.postMessage(reply, '*'); }catch(e){}
      window.postMessage(reply, '*');
    });
  });

  // son çevrilmiş blob - yeniden kullanımda eskiyi beklememek için
  let lastTranslatedBlob = null;

  const uploadQueue = [];
  async function handleUpload(dataUrl, targetLang, sourceLang) {
    console.log('[MGC-GT] handleUpload çağrıldı', 'len', dataUrl?.length, 'target', targetLang, 'source', sourceLang);
    if (isProcessing) {
      console.log('[MGC-GT] meşgul, kuyruğa alındı');
      return new Promise((resolve)=>{
        uploadQueue.push({dataUrl, targetLang, sourceLang, resolve});
      });
    }
    isProcessing = true;
    // önceki blob'u kaydet ve gerekirse temizle (kuyruk yeniden kullanımı için)
    try{
      const before = Array.from(document.querySelectorAll('div.tyW0pd img.Jmlpdc')).map(i=>i.src).filter(s=> s && s.startsWith('blob:'));
      if (before.length) lastTranslatedBlob = before[before.length-1];
      const clearBtn = document.querySelector('button[aria-label="Resmi temizle"]') || document.querySelector('[aria-label="Clear image"]') || Array.from(document.querySelectorAll('button')).find(b=> (b.getAttribute('aria-label')||'').toLowerCase().includes('temizle') || (b.getAttribute('aria-label')||'').toLowerCase().includes('clear'));
      if (clearBtn && before.length){
        LOG('kuyruk için önceki resim temizleniyor', before.length);
        clearBtn.click();
        // ponytail: sabit 900ms YOK — sonucun gerçekten kalktığı görülene kadar beklenir
        // (kısılan sekmede 900ms yetmez, üstüne yükleme yutulur ve her iş timeout'a düşerdi)
        const cStart = Date.now();
        while (Date.now()-cStart < 12000){
          await new Promise(r=>setTimeout(r, 500));
          const still = document.querySelector('div.tyW0pd img.Jmlpdc');
          if (!still || !still.src || !still.src.startsWith('blob:')) break;
        }
      }
    }catch(e){ LOG('clear denemesi hata', e); }
    try {
      // Dili URL'de ayarla (yeniden yüklemeden)
      // Google translate hedef dili URL param ile alıyor, ama zaten doğru sayfadaysak tekrar navigasyon gerekmez
      // Dosyayı inputa yükle
      const blob = await dataUrlToBlob(dataUrl);
      LOG('blob', blob.size, blob.type);
      // Google'ın kabul ettiği formatlar: image/jpeg, image/png, image/webp
      let fileBlob = blob;
      let fileName = 'manga.' + (blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg');
      // Boyut kontrolü: >8MB ise küçült
      if (fileBlob.size > 8 * 1024 * 1024) {
        LOG('blob çok büyük, küçültülüyor', fileBlob.size);
        fileBlob = await compressImage(fileBlob, 0.85, 1600);
      }
      // PNG manga sayfaları şişkindir (1MB+); JPEG'e çevir (metin keskinliği korunur, bayt ~3x azalır)
      if (fileBlob.type === 'image/png' && fileBlob.size > 400 * 1024) {
        const before = fileBlob.size;
        fileBlob = await convertToJpeg(fileBlob);
        fileName = 'manga.jpg';
        LOG('png->jpeg', before, '->', fileBlob.size);
      }
      // Bazı MangaDex görselleri çok uzun (örn 800x3000) -> Google kabul ediyor ama emin olmak için JPEG'e çevir
      if (!['image/jpeg','image/png','image/webp'].includes(fileBlob.type)) {
        LOG('uyumsuz mime', fileBlob.type, '-> jpeg dönüştür');
        fileBlob = await convertToJpeg(fileBlob);
        fileName = 'manga.jpg';
      }

      const file = new File([fileBlob], fileName, { type: fileBlob.type });

      // Input'u bul (ölü sekmeyse kendini yenile)
      let input = await waitForInput();
      if (!input && !window._mgcReloadedOnce){
        window._mgcReloadedOnce = true;
        LOG('input yok, sekme yenileniyor (self-heal)');
        try{ location.reload(); }catch(e){}
        await new Promise(r=>setTimeout(r, 5000));
        input = await waitForInput(15000);
      }
      if (!input) throw new Error('Google dosya inputu bulunamadı');

      LOG('input bulundu', input.accept, input.className);
      console.log('[MGC-GT] input bulundu, dosya atanıyor', file.name, file.size, file.type);
      // DataTransfer ile file ata
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      // change event tetikle (Google jsaction change:bK2emb dinliyor)
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Ayrıca drag & drop simülasyonu için drop event de tetikle parent'a
      const dropZone = document.querySelector('.oBOnKe')?.parentElement || document.body;
      // Bazı durumlarda button click gerekebilir ama input change yeterli
      LOG('dosya atandı, çeviri bekleniyor...');
      // Yükleme teyidi: panele taze blob düşmezse change'i yeniden tetikle (öldürme, tekmele).
      // Yavaş ağda ilk teyit 15sn'yi geçebilir; en fazla 3 tekme, sonra normal beklemeye devam.
      {
        let beforeBlobs = null;
        try{ beforeBlobs = new Set(Array.from(document.querySelectorAll('div.tyW0pd img')).map(i=>i.src).filter(s=>s && s.startsWith('blob:'))); }catch(_){ beforeBlobs = new Set(); }
        const hasFresh = ()=>{
          try{
            const fis = Array.from(document.querySelectorAll('div.tyW0pd img'));
            for (const fi of fis){ if (fi.src && fi.src.startsWith('blob:') && !beforeBlobs.has(fi.src)) return true; }
          }catch(_){}
          return false;
        };
        for (let kick=0; kick<3; kick++){
          const ackStart = Date.now();
          let acked = false;
          while (Date.now()-ackStart < 15000){
            await new Promise(r=>setTimeout(r, 500));
            if (hasFresh()){ acked = true; break; }
          }
          if (acked){ LOG('yükleme teyitli', 'tekme', kick); break; }
          LOG('teyit yok, change yeniden tetikleniyor', 'tekme', kick);
          try{ input.dispatchEvent(new Event('change', { bubbles: true })); input.dispatchEvent(new Event('input', { bubbles: true })); }catch(_){}
          if (kick === 2) LOG('teyit alınamadı, tam bütçeyle bekleniyor (yavaş ağ olabilir)');
        }
      }

      // Çeviri sonucunu bekle: bütçe görsel boyutuna göre (sabit 32sn büyüklerde sahte timeout)
      const budgetMs = Math.min(120000, 30000 + Math.round(fileBlob.size / 1024 / 1024 * 25000));
      LOG('bekleme bütçesi', (budgetMs/1000)+'sn', 'boyut', fileBlob.size);
      const translatedBlobUrl = await waitForTranslatedImage(budgetMs, lastTranslatedBlob);
      LOG('translatedBlobUrl', translatedBlobUrl);
      console.log('[MGC-GT] translatedBlobUrl', translatedBlobUrl);
      if (!translatedBlobUrl) {
        console.error('[MGC-GT] çevrilmiş görsel bulunamadı timeout');
        window._mgcTimeouts = (window._mgcTimeouts||0)+1;
        if (window._mgcTimeouts>=2){
          window._mgcTimeouts = 0;
          LOG('üst üste timeout, sekme yenileniyor (self-heal)');
          try{ location.reload(); }catch(e){}
          await new Promise(r=>setTimeout(r, 4000));
        }
        throw new Error('Çevrilmiş görsel bulunamadı (timeout)');
      } else { window._mgcTimeouts = 0; }

      // Blob URL'yi dataURL'e çevir ve geri gönder
      const dataUrlResult = await blobUrlToDataUrl(translatedBlobUrl);
      LOG('dataUrlResult len', dataUrlResult.length);

      lastTranslatedBlob = translatedBlobUrl;
      LOG('clearBtn bekletiliyor (kuyruk için elde tut)');

      isProcessing = false;
      drainQueue();
      return { dataUrl: dataUrlResult, blobUrl: translatedBlobUrl };
    } catch (e) {
      isProcessing = false;
      drainQueue();
      LOG('handleUpload hata', e);
      throw e;
    }
  }
  function drainQueue(){
    try{
      const nxt = uploadQueue.shift();
      if(!nxt) return;
      console.log('[MGC-GT] kuyruktan sıradaki alınıyor');
      handleUpload(nxt.dataUrl, nxt.targetLang, nxt.sourceLang).then(nxt.resolve).catch((e)=>nxt.resolve({error:String(e&&e.message||e)}));
    }catch(e){ console.warn('[MGC-GT] drain fail', e); }
  }

  function waitForInput(timeout=15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let clicked = false, done = false;
      const finish = (v)=>{ if (done) return; done = true; try{ mo.disconnect(); }catch(_){} resolve(v); };
      const check = () => {
        // SADECE görsel girdisi: docs-modundaki pdf girdisine yükleme yutulur
        const inp = document.querySelector("input[type='file'][accept*='image']");
        if (inp) return finish(inp);
        if (!clicked && Date.now() - start > 2000){ clicked = true; mgcEnsureInput(); }
        if (Date.now() - start > timeout) return finish(null);
      };
      const mo = new MutationObserver(()=>check());
      try{ mo.observe(document.documentElement, {childList:true, subtree:true}); }catch(_){}
      check();
      const backstop = setInterval(()=>{
        if (done){ clearInterval(backstop); return; }
        check();
      }, 3000);
      setTimeout(()=>{ clearInterval(backstop); check(); }, timeout+500);
    });
  }

  function waitForTranslatedImage(timeout=30000, previousBlob=null) {
    return new Promise((resolve) => {
      const start = Date.now();
      const hardCap = 150000;
      let lastBlob = null, lastActivity = Date.now(), settled = false;
      // Google uretiyorsa sonuc paneline img duser; takilmayi bundan anla (sabit kor bekleme yok)
      const scope = document.querySelector('div.tyW0pd')?.parentElement || document.body;
      const done = (v)=>{
        if (settled) return; settled = true;
        try{ mo.disconnect(); }catch(_){}
        resolve(v);
      };
      const findResult = () => {
        // Google sonrasi iki img.Jmlpdc var, ikincisi tyW0pd icinde cevrilmis olan
        const translatedImg = document.querySelector('div.tyW0pd img.Jmlpdc');
        const anyTranslated = translatedImg || document.querySelector('.tyW0pd img') || document.querySelector('div.CMhTbb.tyW0pd img');
        if (anyTranslated && anyTranslated.src && anyTranslated.src.startsWith('blob:')) {
          if ((anyTranslated.width > 10 || anyTranslated.naturalWidth > 10)) {
            // yeniden kullanimda ayni blob'u tekrar dondurmemek icin fark kontrolu
            if (!previousBlob || anyTranslated.src !== previousBlob){
              // ayrica blob'un yeni oldugundan emin olmak icin timestamp farki: en az 800ms sonra kabul
              if (Date.now() - start > 900 || anyTranslated.src !== previousBlob) {
                return anyTranslated.src;
              }
            } else {
              lastBlob = anyTranslated.src;
            }
          } else {
            lastBlob = anyTranslated.src;
          }
        }
        const all = document.querySelectorAll('img.Jmlpdc');
        if (all.length >= 2) {
          const second = all[1];
          if (second.src.startsWith('blob:') && (second.width > 10 || second.naturalWidth > 10)) {
            if (!previousBlob || second.src !== previousBlob) {
              return second.src;
            }
          }
        }
        return null;
      };
      const mo = new MutationObserver((muts)=>{
        for (const m of muts){
          for (const n of m.addedNodes){
            if (n.nodeType===1 && (n.tagName==='IMG' || (n.querySelector && n.querySelector('img')))){ lastActivity = Date.now(); break; }
          }
        }
        // Gozlemci aninda cozer (arka-plan kisilmasinda poll gecikir); poll yedek
        const hit = findResult();
        if (hit) done(hit);
      });
      try{ mo.observe(scope, {childList:true, subtree:true, attributes:true, attributeFilter:['src']}); }catch(_){}
      const check = () => {
        const hit = findResult();
        if (hit) return done(hit);
        if (Date.now() - start > timeout) {
          if (lastBlob && lastBlob!==previousBlob) return done(lastBlob);
          // Butce doldu ama Google hala uretiyorsa (taze img aktivitesi) uzat; takildiysa erken birak
          if (Date.now()-lastActivity < 15000 && Date.now()-start < hardCap){ setTimeout(check, 1000); return; }
          return done(null);
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  async function blobUrlToDataUrl(blobUrl) {
    const res = await fetch(blobUrl);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async function compressImage(blob, quality=0.85, maxWidth=1600) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxWidth) {
          h = Math.round(h * maxWidth / w);
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob(b => resolve(b || blob), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }

  async function convertToJpeg(blob) {
    return compressImage(blob, 0.92, 2000);
  }

  // Otomatik temizleme: sayfa kapanmadan önce blob'ları revoke etme
})();
