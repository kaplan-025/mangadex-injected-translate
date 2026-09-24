// MangaDex Google Görsel Çeviri - Content Script v1.3 optimize
// 1) google_direct: Görseli translate.google.com/?op=images'e yolla
// 2) tesseract: Yerel OCR + Google Text Translate
// OPTIMIZE: sadece reader resimleri, sıralı kuyruk, HUD, kaybolmama fix
(() => {
  try {
    if (typeof globalThis.browser === 'undefined' && typeof globalThis.chrome !== 'undefined') globalThis.browser = globalThis.chrome;
    if (typeof browser === 'undefined' && typeof chrome !== 'undefined') browser = chrome;
  } catch(e){}

  const STATE = {
    settings: {
      targetLang: 'tr',
      sourceLang: 'auto',
      ocrLang: 'eng',
      autoTranslate: false,
      showLensButton: true,
      translateMode: 'google_direct',
      keepTranslateTab: false
    },
    tesseractReady: false,
    tesseractLoading: false,
    observedImages: new WeakSet(),
    toolbarInjected: false,
    pendingGoogle: new Map(), // mangaUrl -> {btn, progressEl, img, parent}
    // optimize ekleri
    translationCache: new Map(),
    indexCache: new Map(),
    pageIndexMap: new WeakMap(),
    srcToIndex: new Map(),
    queue: [],
    processing: false,
    activeCount: 0,
    hudEl: null,
    totalCount: 0,
    domNextIdx: 0,
    blobHashToIdx: new Map(),
    apiQueued: new Set(),
    autoStarted: false,
    userStarted: false,
    readerContainerCache: null,
    readerContainerCacheTime: 0,
    chapterCaches: new Map(), // chapterId -> {translationCache, indexCache, srcToIndex, totalCount, queue}
    currentChapterId: null,
  };


  // ---------- API ENJEKSİYON (v2.1): Google özellikleri MangaDex'e gömülü, sekme YOK ----------
  const INJECT_POOL_SIZE = 2;
  const injectPool = []; // {iframe, busy, ready, id}
  let injectRR = 0;
  function injectTargetLang(){ return STATE.settings.targetLang || 'tr'; }
  function injectSourceLang(){ return STATE.settings.sourceLang || 'auto'; }
  function ensureInjectPool(){
    for (let i=injectPool.length-1;i>=0;i--){ const e=injectPool[i]; if(!e.iframe || !e.iframe.isConnected){ injectPool.splice(i,1); } }
    while (injectPool.length < INJECT_POOL_SIZE){
      const id = injectPool.length;
      const iframe = document.createElement('iframe');
      iframe.id = 'mgc-injected-iframe-' + id;
      iframe.dataset.mgcInject = '1';
      // Sandbox YOK: file input + postMessage için gerekli. Offscreen konum yeterli.
      iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1280px;height:900px;opacity:0;pointer-events:none;border:0;'; // geniş: Google masaüstü UI + input için
      iframe.src = `https://translate.google.com.tr/?sl=${encodeURIComponent(injectSourceLang())}&tl=${encodeURIComponent(injectTargetLang())}&op=images`;
      const entry = {iframe, busy:false, ready:false, id, readyResolve:null};
      entry.readyPromise = new Promise((res)=>{ entry.readyResolve = res; });
      iframe.addEventListener('load', ()=>{
        setTimeout(()=>{ entry.ready = true; try{entry.readyResolve();}catch(e){} console.log('[MGC] inject havuz iframe hazır', id); }, 2200);
      }, {once:true});
      setTimeout(()=>{ if(!entry.ready){ entry.ready = true; try{entry.readyResolve();}catch(e){} console.log('[MGC] inject iframe fallback hazır', id); } }, 6000);
      (document.documentElement||document.body).appendChild(iframe);
      injectPool.push(entry);
      console.log('[MGC] inject iframe oluşturuldu', id, iframe.src);
    }
    return injectPool;
  }
  // Tekil uyumluluk için eski isimler havuza bağlanır
  let injectedIframe = null;
  let injectedReady = false;
  let injectedReadyPromise = Promise.resolve();
  function ensureInjectedIframe(){
    const pool = ensureInjectPool();
    injectedIframe = pool[0].iframe;
    injectedReadyPromise = pool[0].readyPromise.then(()=>{ injectedReady = true; });
    pool[0].readyPromise.then(()=>{ injectedReady = true; });
    return injectedIframe;
  }
  async function sendPool(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl){
    let lastErr = null;
    for (let a=0; a<3; a++){
      try{
        const r = await browser.runtime.sendMessage({action:'poolTranslate', pageUrl: pageUrl||null, dataUrl: pageUrl?null:dataUrl, targetLang, sourceLang: injectSourceLang(), mangaUrl, pageIdx, chId});
        if (r && (r.queued || r.dataUrl || r.error)) return r;
        lastErr = new Error('boş havuz yanıtı');
      }catch(e){ lastErr = e; }
      await new Promise(rr=>setTimeout(rr, 600));
    }
    throw lastErr || new Error('boş havuz yanıtı');
  }

  function translateViaInjected(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl){
    // v2.8: Google havuz modu (Yandex eklenti bağlamında engelli, tüm modlar Google'a düşer)
    return new Promise(async (resolve, reject)=>{
      try{
        const t = setTimeout(()=>reject(new Error('Havuz timeout 200s')), 200000);
        const mode = STATE.settings.translateMode;

        if (mode === 'yandex_ocr'){
          // Yandex API eklenti bağlamında engelli -> Google havuzuna düş (kilitlenme yok)
          const res = await sendPool(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl);
          clearTimeout(t);
          if (res && res.queued) return resolve({queued:true});
          if (res && res.dataUrl) return resolve({dataUrl: res.dataUrl, via:'google-fallback'});
          if (res && res.error) return reject(new Error(res.error));
          return reject(new Error('Boş havuz yanıtı'));
        }

        if (mode === 'multi_auto'){
          // İkisi birden yarış: hangisi önce hazır olursa
          const r = await translateRace(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl);
          clearTimeout(t);
          if (r && r.dataUrl) return resolve(r);
          if (r && r.queued) return resolve({queued:true});
          if (r && r.error) return reject(new Error(r.error));
          return reject(new Error('Motor yarışı boş'));
        }

        // varsayılan: google_direct
        const res = await sendPool(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl);
        clearTimeout(t);
        if (res && res.queued) return resolve({queued:true});
        if (res && res.dataUrl) return resolve({dataUrl: res.dataUrl});
        if (res && res.error) return reject(new Error(res.error));
        return reject(new Error('Boş havuz yanıtı'));
      }catch(e){ return reject(e); }
    });
  }


  async function translateRace(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl){
    // Yandex çalışmıyor (API engellenmiş) - sadece Google kullan
    console.log('[MGC] multi_auto: Yandex devre dışı, sadece Google kullanılıyor');
    return translateViaGoogleOnly(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl);
  }

  async function translateViaGoogleOnly(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl){
    return new Promise(async (resolve, reject) => {
      try{
        const t = setTimeout(()=>reject(new Error('Google havuz timeout 200s')), 200000);
        const res = await sendPool(dataUrl, targetLang, mangaUrl, pageIdx, chId, pageUrl);
        clearTimeout(t);
        if (res && res.queued) return resolve({queued:true});
        if (res && res.dataUrl) return resolve({dataUrl: res.dataUrl, via:'google'});
        if (res && res.error) return reject(new Error(res.error));
        return reject(new Error('Boş Google havuz yanıtı'));
      }catch(e){ return reject(e); }
    });
  }

  init();

  async function init() {
    try{
    try{ console.log('[MGC] v'+(browser.runtime.getManifest?browser.runtime.getManifest().version:'?')+' başlatılıyor'); }catch(e){ console.log('[MGC] başlatılıyor'); }
    STATE.settings = await getSettings();
    // v2.8.11: varsayılan Google Görsel; eski yarış modları (multi_auto/yandex_ocr) aynısıydı, normale
    if (STATE.settings.translateMode === 'multi_auto' || STATE.settings.translateMode === 'yandex_ocr'){
      STATE.settings.translateMode = 'google_direct';
      browser.storage.local.set({translateMode: 'google_direct'});
    }
    console.log('[MGC] Ayarlar yüklendi', JSON.stringify(STATE.settings));
    console.log('[MGC] Sayfa:', location.href, 'hostname:', location.hostname);
    injectToolbar();
    injectGlobalStyle();
    ensureHud();
    if (isChapterPage()) switchChapterCacheIfNeeded(true);
    scanAndAttach();

    const mo = new MutationObserver(() => {
      scanAndAttach();
      // NOT: mutasyonlar çeviri tetiklemez (tek yol: chapter yerleşmesi + Başla kapısı)
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // chapter sayfasındaysa: BAŞLA kapısı (ilk çalışmada hemen çevirme) + tek elden izleyici
    if (isChapterPage()) {
      console.log('[MGC] Chapter sayfası algılandı');
      loadStartedFlag().then(()=>{
        try{ updateHud(); }catch(e){ console.error('[MGC] gate updateHud hata', e); }
        if (STATE.userStarted){
          // reader otursun diye tek gecikmeli tetik (3x blast yok)
          setTimeout(()=> { scanAndAttach(); maybeAutoStart(); try{ browser.runtime.sendMessage({action:'fetchPendingPush', chId:getChapterId()}); }catch(e){} }, 1500);
        } else {
          console.log('[MGC] ilk çalış: kullanıcı Başla demeden çeviri yok (HUD ▶)');
        }
      });
// chapter değişim izleyici (tek elden, idempotent)
  let lastHref = location.href;
  let lastCid = getChapterId();
  const onChapterSettled = (why)=>{
    const nid = getChapterId();
    if (!nid) return;
    if (nid !== lastCid || nid !== STATE.currentChapterId){
      lastCid = nid;
      console.log('[MGC] chapter değişti ('+why+') ->', nid, 'buradan devam');
      switchChapterCacheIfNeeded(true);
      STATE.readerContainerCache = null;
      STATE.queue = [];
      STATE.activeCount = 0;
      STATE.processing = false;
      // Atlama: eski chapter işleri havuzu tıkamasın — kuyruktakiler iptal
      // (bitenler cache'te durur, geri dönünce kaldığı yerden; uçan 2 iş zararsız biter)
      try{
        for (const k of [...STATE.apiQueued]){ if (!k.startsWith(nid+':')) STATE.apiQueued.delete(k); }
        for (const [u, pr] of [...STATE.pendingGoogle.entries()]){
          if (pr && pr.chId && pr.chId !== nid) STATE.pendingGoogle.delete(u);
        }
        browser.runtime.sendMessage({action:'dropQueuedExcept', chId: nid});
      }catch(e){}
      hideGlobalProgress();
      updateHud();
      cleanupStaleButtons();
    }
    scanAndAttach();
    // Yeni chapter: reader görselleri yüklenene kadar bekle (max 5s), sonra başlat
    waitForReaderImages(nid).then(()=>{
      if (getChapterId()===nid && STATE.userStarted) maybeAutoStart();
      try{ browser.runtime.sendMessage({action:'fetchPendingPush', chId:getChapterId()}); }catch(e){}
    });
  };
  // Reader container + blob görselleri gelene kadar bekle
  function waitForReaderImages(targetCid){
    return new Promise(resolve=>{
      let attempts = 0;
      const check = ()=>{
        attempts++;
        const imgs = getReaderImages();
        if (imgs.length >= 3 || attempts > 25){ // ~5s
          console.log('[MGC] reader görselleri hazır', imgs.length, 'deneme', attempts);
          resolve();
        } else {
          setTimeout(check, 200);
        }
      };
      check();
    });
  }
      setInterval(()=>{
        if (location.href !== lastHref) {
          lastHref = location.href;
          setTimeout(()=> onChapterSettled('href'), 800);
        } else {
          const curCid = getChapterId();
          if (curCid && curCid !== STATE.currentChapterId){
            onChapterSettled('cid');
          }
        }
      }, 800);
      // Reader Store jumping / SPA navigation hook
      const origPush = history.pushState;
      history.pushState = function(){ const r = origPush.apply(this, arguments);
        setTimeout(()=>{ lastHref = location.href; onChapterSettled('push'); }, 600);
        return r;
      };
      window.addEventListener('popstate', ()=> setTimeout(()=>{ lastHref = location.href; onChapterSettled('pop'); }, 600));
    } else {
      loadStartedFlag().then(()=>updateHud());
    }
    }catch(e){ console.error('[MGC] init hata', String(e&&e.message||e), String((e&&e.stack)||'').slice(0,300)); }

    if (STATE.settings.autoTranslate) setupAutoObserver();

    browser.storage.onChanged.addListener((changes) => {
      for (let k in changes) STATE.settings[k] = changes[k].newValue;
      updateToolbarUI();
      if (changes.autoTranslate && STATE.settings.autoTranslate) setupAutoObserver();
      document.querySelectorAll('.mgc-translate-btn').forEach(b=>{
        if (!b.dataset.busy || b.dataset.busy==='0') {
          const isDone = b.classList.contains('translated');
          b.innerHTML = isDone ? `✓ ${STATE.settings.targetLang.toUpperCase()}` : `<span style="font-weight:700">G</span> ${STATE.settings.translateMode==='google_direct'?'Görsel':'OCR'} <span style="opacity:0.8;font-size:10px">(${STATE.settings.targetLang.toUpperCase()})</span>`;
        }
      });
      updateHud();
    });

    browser.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'translateAll') translateAllVisible();
      if (msg.action === 'clearAll') clearAllOverlays();
      if (msg.action === 'toggleAuto') {
        STATE.settings.autoTranslate = msg.value;
        browser.storage.local.set({ autoTranslate: msg.value });
      }
      if (msg.action === 'showTranslatedImage') {
        handleShowTranslatedImage(msg);
      }
      if (msg.action === 'googleTranslateError') {
        handleGoogleError(msg);
      }
      if (msg.action === 'bgLog') {
        console.log('[MGC-BG]', msg.text);
      }
    });

  // Konsol sarmalayıcı: doğrudan console.log('[MGC]...') çağrıları da köprüye aksın
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

    // klavye kısayolları
    document.addEventListener('keydown', (e)=>{
      if (e.altKey && (e.key==='t' || e.key==='T')) { e.preventDefault(); translateAllVisible(); }
      if (e.altKey && (e.key==='c' || e.key==='C')) { e.preventDefault(); clearAllOverlays(); }
    });
  }

  function getSettings() {
    return browser.runtime.sendMessage({ action: 'getSettings' }).then(s=>s||STATE.settings).catch(()=>STATE.settings);
  }

  function injectGlobalStyle() {
    if (document.getElementById('mgc-global-style')) return;
    const s = document.createElement('style');
    s.id = 'mgc-global-style';
    s.textContent = `
      @keyframes mgc-spin { to { transform: rotate(360deg) } }
      @media (max-width: 768px) {
        .mgc-toolbar { top: 56px !important; right: 8px !important; left: 8px !important; min-width: auto !important; max-width: 92vw !important; }
        .mgc-translate-btn { padding: 8px 14px !important; font-size: 13px !important; }
        .mgc-lens-btn { padding: 6px 12px !important; font-size: 12px !important; }
      }
    `;
    document.head.appendChild(s);
  }

  // ---------- Reader algılama & HUD ----------
  function isChapterPage(){
    return location.pathname.includes('/chapter/');
  }
  function getChapterId(){
    const m = location.pathname.match(/\/chapter\/([^\/]+)/);
    return m ? m[1] : null;
  }
  // ---------- Başla kapısı: ilk çalışmada kullanıcı Başla demeden çeviri yok ----------
  function isStarted(){ return !!STATE.userStarted; }
  function refreshStartedDataset(){
    try{
      document.documentElement.dataset.mgcStarted = STATE.userStarted?'1':'0';
      document.documentElement.dataset.mgcCid = getChapterId()||'';
    }catch(e){}
  }
  async function loadStartedFlag(){
    try{
      const r = await browser.storage.local.get('mgcUserStarted');
      STATE.userStarted = !!(r && r.mgcUserStarted);
    }catch(e){ STATE.userStarted = false; }
    refreshStartedDataset();
  }
  function setStarted(v){
    STATE.userStarted = !!v;
    if (!STATE.userStarted) stopPostBeat();
    refreshStartedDataset();
    try{ browser.storage.local.set({mgcUserStarted: STATE.userStarted}); }catch(e){}
    console.log('[MGC] userStarted =', STATE.userStarted);
    try{ updateHud(); }catch(e){ console.error('[MGC] setStarted hud hata', String(e&&e.message||e).slice(0,150)); }
    try{ updateToolbarUI(); }catch(e){ console.error('[MGC] setStarted toolbar hata', String(e&&e.message||e).slice(0,150)); }
    if (STATE.userStarted && isChapterPage()) maybeAutoStart();
  }
  function maybeAutoStart(){
    if (!isChapterPage()) return;
    if (!STATE.userStarted){ updateHud(); return; }
    console.log('[MGC] otomatik başlatılıyor', getChapterId());
    autoTranslateViaAPI();
  }
  function NN(v){ return (v===undefined || v===null || (typeof v==='number' && Number.isNaN(v))) ? null : v; }
  function idxInRange(idx){
    if (!Number.isInteger(idx) || idx < 0) return false;
    const t = STATE.totalCount || 500;
    return idx < t;
  }
  // Sayfa sonucunu chapter önbelleğine yazar; sınır dışı indeksi düşürür (yanlış takas engeli).
  // Toplam SADECE güvenilirse bakılır: girişin kendi totali veya aynı-chapter sayacı.
  // Başka chapter + bilinmeyen totalde düşürme YOK (bayat STATE.totalCount ile sonuç yakma engeli).
  function setPageResult(chId, idx, mangaUrl, dataUrl){
    if (!Number.isInteger(idx) || idx < 0) return false;
    let entry = STATE.chapterCaches.get(chId);
    const ownTotal = (entry && (entry.totalCount || (entry.pageUrls && entry.pageUrls.length))) || 0;
    const total = ownTotal || (chId === getChapterId() ? (STATE.totalCount || 0) : 0);
    if (total && idx >= total){
      console.warn('[MGC] sınır dışı indeks düşürüldü', chId && String(chId).slice(0,8), idx, 'total', total);
      return false;
    }
    if (!entry){
      entry = {translationCache:new Map(), indexCache:new Map(), srcToIndex:new Map(), totalCount:0, domNextIdx:0, pageUrls:null, hashToIdx:new Map()};
      STATE.chapterCaches.set(chId, entry);
    }
    entry.indexCache.set(idx, dataUrl);
    entry.translationCache.set(mangaUrl, dataUrl);
    STATE.apiQueued.delete(`${chId}:${idx}`);
    if (chId === getChapterId()){
      STATE.indexCache.set(idx, dataUrl);
      STATE.translationCache.set(mangaUrl, dataUrl);
    }
    return true;
  }
  function switchChapterCacheIfNeeded(force=false){
    const cid = getChapterId();
    if (!cid) return;
    if (STATE.currentChapterId === cid && !force) return;
    if (STATE.currentChapterId){
      // Budama: ölü blob anahtarları birikmesin (12 sayfada size 43 engeli); api: anahtarları kalıcı
      try{
        const live = new Set();
        for (const im of document.querySelectorAll('img')){ const s = im.src||''; if (s.startsWith('blob:')) live.add(s); }
        for (const k of STATE.translationCache){ if (!k.startsWith('api:') && !live.has(k)) STATE.translationCache.delete(k); }
        for (const [k,v] of STATE.srcToIndex){
          if (v===undefined || v===null || (typeof v==='number' && Number.isNaN(v))){ STATE.srcToIndex.delete(k); continue; }
          if (!k.startsWith('api:') && !live.has(k)) STATE.srcToIndex.delete(k);
        }
        for (const [k] of STATE.indexCache){ if (typeof k!=='number' || Number.isNaN(k) || k<0) STATE.indexCache.delete(k); }
        for (const k of STATE.apiQueued){ if (String(k).endsWith(':undefined')) STATE.apiQueued.delete(k); }
      }catch(_){}
      STATE.chapterCaches.set(STATE.currentChapterId, {
        translationCache: new Map(STATE.translationCache),
        indexCache: new Map(STATE.indexCache),
        srcToIndex: new Map(STATE.srcToIndex),
        totalCount: STATE.totalCount,
        domNextIdx: STATE.domNextIdx,
        pageUrls: (STATE.chapterCaches.get(STATE.currentChapterId)?.pageUrls)||null,
        hashToIdx: (STATE.chapterCaches.get(STATE.currentChapterId)?.hashToIdx)||new Map()
      });
      // ponytail: en fazla 3 chapter cache (~150MB tavan); eskiler silinir, geri dönünce yeniden çevrilir.
      // Uçuşan işi olan chapter ATILMAZ (çıplak giriş + totalsız setPageResult = sonuç kaybı).
      while (STATE.chapterCaches.size > 3){
        const oldest = STATE.chapterCaches.keys().next().value;
        if (oldest === cid) break;
        let busy = false;
        try{
          for (const pr of STATE.pendingGoogle.values()){ if (pr && pr.chId===oldest){ busy = true; break; } }
          if (!busy) for (const k of STATE.apiQueued){ if (k===oldest || String(k).startsWith(oldest+':')){ busy = true; break; } }
        }catch(_){}
        if (busy) break;
        STATE.chapterCaches.delete(oldest);
        try{
          for (const k of [...STATE.apiQueued]){ if (k===oldest || k.startsWith(oldest+':')) STATE.apiQueued.delete(k); }
          for (const [u, pr] of [...STATE.pendingGoogle.entries()]){
            if ((pr && pr.chId===oldest) || String(u).startsWith('api:'+oldest+':')) STATE.pendingGoogle.delete(u);
          }
        }catch(e){}
        console.log('[MGC] eski chapter cache atıldı (LRU)', String(oldest).slice(0,8));
      }
      console.log('[MGC] chapter cache kaydedildi', STATE.currentChapterId, 'size', STATE.translationCache.size);
      try{ browser.runtime.sendMessage({action:'clearQueueForSender'}); }catch(e){}
      STATE.queue = [];
      STATE.activeCount = 0;
      STATE.processing = false;
      STATE.pendingGoogle.clear();
    }
    if (STATE.chapterCaches.has(cid)){
      const c = STATE.chapterCaches.get(cid);
      STATE.chapterCaches.delete(cid); STATE.chapterCaches.set(cid, c);
      STATE.translationCache = c.translationCache;
      STATE.indexCache = c.indexCache;
      STATE.srcToIndex = c.srcToIndex;
      STATE.totalCount = c.totalCount || 0;
      STATE.domNextIdx = c.domNextIdx || 0;
      console.log('[MGC] chapter cache yüklendi', cid, 'size', STATE.translationCache.size, 'domNextIdx', STATE.domNextIdx);
    } else {
      STATE.translationCache = new Map();
      STATE.indexCache = new Map();
      STATE.srcToIndex = new Map();
      STATE.totalCount = 0;
      STATE.domNextIdx = 0;
      STATE.queue = [];
      STATE.processing = false;
      STATE.activeCount = 0;
      STATE.chapterCaches.set(cid, {translationCache: STATE.translationCache, indexCache: STATE.indexCache, srcToIndex: STATE.srcToIndex, totalCount: 0, domNextIdx: 0, pageUrls: null, hashToIdx: new Map()});
      console.log('[MGC] yeni chapter cache oluşturuldu', cid);
    }
    STATE.currentChapterId = cid;
    stopPostBeat();
    try{ STATE.pageFails = {}; STATE.blobFails = {}; }catch(_){}
    // Geri dönüştürülmüş elemanlardaki bayat kimlikleri sök (vol atlamada yanlış takas engeli)
    try{
      for (const im of document.querySelectorAll('img')){
        delete im.dataset.mgcIdRun;
        delete im.dataset.mgcPageIndex;
        delete im.dataset.mgcIdxSrc;
        delete im.dataset.mgcTranslated;
        delete im.dataset.mgcOriginal;
        delete im.dataset.mgcAttachedSrc;
        delete im.dataset.mgcAttached;
        delete im.dataset.mgcChId;
      }
      STATE.observedImages = new WeakSet();
    }catch(_){}
    STATE.pageIndexMap = new WeakMap();
    STATE.readerContainerCache = null;
    // eski buton kalıntılarını temizle (chapter değişiminde gölge kalınlaşması fix)
    cleanupStaleButtons();
    updateHud();
  }
  function cleanupStaleButtons(){
    document.querySelectorAll('#mgc-zoom-overlay').forEach(el=>el.remove());
    const stray = document.querySelectorAll('.mgc-translate-btn, .mgc-lens-btn, .mgc-zoom-btn, .mgc-badge, .mgc-progress');
    const parents = new Set();
    stray.forEach(el=>{
      const p = el.parentElement;
      if (p) parents.add(p);
    });
    parents.forEach(p=>{
      const btns = p.querySelectorAll('.mgc-translate-btn');
      if (btns.length>1){
        for (let i=0;i<btns.length-1;i++) btns[i].remove();
        console.log('[MGC] fazla buton temizlendi', p, btns.length);
      }
      const lenses = p.querySelectorAll('.mgc-lens-btn');
      if (lenses.length>1) for(let i=0;i<lenses.length-1;i++) lenses[i].remove();
      const zooms = p.querySelectorAll('.mgc-zoom-btn');
      if (zooms.length>1) for(let i=0;i<zooms.length-1;i++) zooms[i].remove();
      const badges = p.querySelectorAll('.mgc-badge');
      if (badges.length>1) for(let i=0;i<badges.length-1;i++) badges[i].remove();
    });
  }
  function getCurrentPageNumberFromDOM(){
    try{
      const all = document.querySelectorAll('span, div, p, button');
      for (const el of all){
        const txt = (el.textContent||'').trim();
        if (!txt || txt.length>20) continue;
        const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (m){
          const cur = parseInt(m[1],10);
          const total = parseInt(m[2],10);
          if (cur>=1 && cur<=total && total>=5 && total<=500){
            const r = el.getBoundingClientRect();
            if (r.width>0 && r.height>0) return cur-1;
          }
        }
        const m2 = txt.match(/Page\s+(\d+)/i);
        if (m2){
          const cur = parseInt(m2[1],10);
          if (cur>=1 && cur<=500) return cur-1;
        }
      }
    }catch(e){}
    return null;
  }
  function getPageNumberFromURL(){
    // Okuyucu başlığı gizliyken gösterge bulunamaz; URL'deki /sayfa her zaman oradadır (1-tabanlı)
    try{
      const m = location.pathname.match(/\/chapter\/[^\/]+\/(\d+)/);
      if (m){ const p = parseInt(m[1],10); if (p>=1 && p<=500) return p-1; }
    }catch(e){}
    return null;
  }
  function isHashMapFull(){
    // Gösterge/URL yedeği SADECE harita tamamsa güvenilir: erken yüklemede miss
    // "henüz kaydolmadı" demektir, "bilinmiyor" değil. Eksik haritayla pn basmak
    // komşu preload'a yanlış çeviri yapıştırır (yanlış resim).
    try{
      const cid = getChapterId(); const cc = cid && STATE.chapterCaches.get(cid);
      if (!cc || !cc.hashToIdx || !cc.hashToIdx.size) return false;
      const total = (cc.pageUrls && cc.pageUrls.length) || cc.totalCount || 0;
      if (!total) return true;
      return cc.hashToIdx.size >= total;
    }catch(e){ return false; }
  }
  function isIdxClaimed(pn){
    // Bir idx hash'le (veya göstergeyle) zaten bir görsele verildiyse yedek
    // aynı numarayı ikinci görsele vermesin (çift-tahsis = yanlış resim).
    try{
      for (const v of STATE.srcToIndex.values()){ if (v===pn) return true; }
      const cid = getChapterId(); const cc = cid && STATE.chapterCaches.get(cid);
      if (cc && cc.srcToIdx) for (const v of cc.srcToIdx.values()){ if (v===pn) return true; }
    }catch(e){}
    return false;
  }
  async function rehashFileIfNeeded(cid, pn){
    // Harita TAMAM ama birincil görsel eşleşmiyorsa: dosyanın kaydı bozuk olabilir
    // (bozuk indirme hash'i). Tek dosyayı yeniden indirip kaydı tazele, sayfa başına 1 kez.
    // Başarılıysa true (kimlik tekrar denensin), değilse false (yedek eskisi gibi).
    try{
      const cc = cid && STATE.chapterCaches.get(cid);
      if (!cc || !cc.pageUrls || !cc.pageUrls[pn] || pn===null || pn===undefined) return false;
      cc._rehashDone = cc._rehashDone || new Set();
      if (cc._rehashDone.has(pn)) return false;
      cc._rehashDone.add(pn);
      let furl = cc.pageUrls[pn];
      let blob = null;
      try{ blob = await fetchImageBlob(furl); }
      catch(be){
        try{ const fr = await refreshChapterUrls(cid, pn); if (fr) furl = fr; else return false; }catch(_){ return false; }
        try{ blob = await fetchImageBlob(furl); }catch(_){ return false; }
      }
      if (!blob) return false;
      const buf = await blob.arrayBuffer();
      if (!buf || buf.byteLength <= 10240) return false;
      const hex = await sha256hex(buf);
      if (!hex) return false;
      if (!cc.hashToIdx) cc.hashToIdx = new Map();
      try{ for (const [h, ix] of cc.hashToIdx){ if (ix===pn){ cc.hashToIdx.delete(h); } } }catch(_){}
      cc.hashToIdx.set(hex, pn);
      console.log('[MGC] hash tazelendi', hex.slice(0,12), pn);
      return true;
    }catch(e){ return false; }
  }
  // Bayat at-home bileti (HTTP 404) tazeleme: dosya adları aynı kalır, taban+hash yenilenir.
  // Tek yerden kullanılır: injectOnePage retry + handleGoogleError requeue.
  const refreshInflight = {};
  async function refreshChapterUrls(chId, pageIdx){
    try{
      if (!refreshInflight[chId]){
        refreshInflight[chId] = (async ()=>{
          try{
            const j = await fetchJsonWithTimeout(`https://api.mangadex.org/at-home/server/${chId}`);
            const files = j.chapter.data || j.chapter.dataSaver || [];
            if (!files.length) return null;
            const urls = files.map(f=>`${j.baseUrl}/data/${j.chapter.hash}/${f}`);
            const cc = STATE.chapterCaches.get(chId);
            if (cc) cc.pageUrls = urls;
            try{
              if (STATE.pageFails) for (const k of Object.keys(STATE.pageFails)){ if (k.startsWith(chId+':')) delete STATE.pageFails[k]; }
            }catch(_){}
            console.log('[MGC] at-home tazelendi', String(chId).slice(0,8), urls.length);
            return urls;
          }catch(e){ console.warn('[MGC] at-home tazeleme fail', e); return null; }
          finally{ delete refreshInflight[chId]; }
        })();
      }
      const urls = await refreshInflight[chId];
      if (!urls) return null;
      return (pageIdx!==null && pageIdx!==undefined) ? (urls[pageIdx]||null) : null;
    }catch(e){ return null; }
  }
  async function fetchWithTimeout(url, ms=20000){
    const ctl = new AbortController();
    const t = setTimeout(()=>ctl.abort(), ms);
    try{ return await fetch(url, {credentials:'omit', signal: ctl.signal}); }
    catch(e){ throw new Error('ağ zaman aşımı: '+String(e&&e.message||e).slice(0,40)); }
    finally{ clearTimeout(t); }
  }
  // Başlık+govde toplam koruması (json gövde akmazsa fetch çözülür ama json asılır)
  async function fetchJsonWithTimeout(url, ms=25000){
    return await Promise.race([
      (async ()=>{
        const r = await fetchWithTimeout(url, ms);
        if (!r.ok) throw new Error('HTTP '+r.status);
        return await r.json();
      })(),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('json zaman aşımı')), ms)),
    ]);
  }
  async function fetchChapterPageUrls(){
    const cid = getChapterId();
    if (!cid) return null;
    try{
      const j = await fetchJsonWithTimeout(`https://api.mangadex.org/at-home/server/${cid}`);
      const base = j.baseUrl;
      const hash = j.chapter.hash;
      const files = j.chapter.data || j.chapter.dataSaver || [];
      if (!files.length) return null;
      return files.map(f=> `${base}/data/${hash}/${f}`);
    }catch(e){
      console.warn('[MGC] at-home API fail', e);
      return null;
    }
  }
  // ---------- ENJEKSİYON LOOP (sekme YOK): chapter bitene kadar durma ----------
  async function injectOnePage({url, dataUrlIn, chId, pageIdx, chNum, total}){
    pageIdx = NN(pageIdx);
    if (!chId) chId = getChapterId();
    if (!chId){
      console.warn('[MGC] chapter yok, iş atıldı');
      updateHud('chapter algılanamadı');
      return 'no-chapter';
    }
    const key = `${chId}:${pageIdx}`;
    const mangaUrl = `api:${chId}:${pageIdx}`;
    const chCache = STATE.chapterCaches.get(chId);
    if (chCache && chCache.indexCache.has(pageIdx)) return 'cached';
    if (STATE.apiQueued.has(key)) return 'queued';
    for (const pr of STATE.pendingGoogle.values()){ if (pr.mangaUrl===mangaUrl || (pr.chId===chId && pr.pageIdx===pageIdx)) return 'pending'; }
    STATE.apiQueued.add(key);
    let prog = null;
    try{
      prog = showProgress(null, `Bölüm ${chNum} Sayfa ${pageIdx+1}/${total} enjekte...`);
      if (chId===getChapterId()){ STATE.totalCount = Math.max(STATE.totalCount, total); updateHud(); }
      let dataUrl = dataUrlIn || null;
      if (!dataUrl){
        let blob = null;
        try{ blob = await fetchImageBlob(url); }
        catch(be){
          if (/BLOB_OLDU/.test(String(be&&be.message||be))){
            if (blobDead(url)){
              if (prog){ prog.textContent = 'Sayfa kapandı (görsel yok)'; setTimeout(()=>{prog.style.display='none';}, 4000); }
              STATE.pendingGoogle.delete(mangaUrl);
              STATE.apiQueued.delete(key);
              updateHud();
              return 'dead-blob';
            }
            throw new Error('blob yok');
          }
          throw be;
        }
        if (!blob) throw new Error('blob yok');
        // Orijinal baytların hash'i = sayfa kimliği (DOM blob'larıyla birebir eşleşir)
        try{
          const buf = await blob.arrayBuffer();
          // ponytail: 10KB altı gövde hata sayfasıdır (gerçek sayfalar 250KB+); zehirli kayıt engeli
          if (buf && buf.byteLength > 10240){
            const hex = await sha256hex(buf);
            const cc0 = STATE.chapterCaches.get(chId);
            if (hex && cc0){
              if (!cc0.hashToIdx) cc0.hashToIdx = new Map();
              // Aynı idx'nin eski (bozuk) kaydını temizle — son indirme kazanır
              try{ for (const [h, ix] of cc0.hashToIdx){ if (ix===pageIdx){ cc0.hashToIdx.delete(h); } } }catch(_){}
              cc0.hashToIdx.set(hex, pageIdx); console.log('[MGC] hash kayit', hex.slice(0,12), pageIdx);
              // Harita tamamlanınca bekleyen birincil-görsel yedeği için hemen süpür
              // (10sn kalp atışını bekleme — ilk sayfa gecikmesi engeli)
              try{ const _t = (cc0.pageUrls && cc0.pageUrls.length) || total || 0; if (_t && cc0.hashToIdx.size>=_t && !cc0._fullSwept){ cc0._fullSwept = true; sweepRestore(); } }catch(_){}
            }
          }
        }catch(he){ console.warn('[MGC] hash fail', pageIdx, he); }
        dataUrl = await prepareImageForGoogle(blob);
      }
      const chC = STATE.chapterCaches.get(chId);
      STATE.pendingGoogle.set(mangaUrl, {btn:null, progressEl:prog, img:null, parent:null, pageIdx, apiUrl:url||null, chId, mangaUrl, t0: Date.now()});
      if (pageIdx!==null){
        if (chC) chC.srcToIndex.set(mangaUrl, pageIdx);
        STATE.srcToIndex.set(mangaUrl, pageIdx);
      }
      updateProgress(prog, `Bölüm ${chNum} Sayfa ${pageIdx+1} Google içinde...`);
      updateHud(`Enjekte ${chNum}:${pageIdx+1}/${total}`);
      const inj = await translateViaInjected(dataUrl, injectTargetLang(), mangaUrl, pageIdx, chId, url);
      dataUrl = null; // ponytail: 800KB kanal/bellek şişkinliği bitirir (hash zaten alındı)
      if (inj && inj.queued){
        // Ateşle-unut: sonuç itmeli gelecek (showTranslatedImage). Gelmezse watchdog tekrar kuyruklar.
        updateProgress(prog, `Bölüm ${chNum} Sayfa ${pageIdx+1} havuzda, sonuç bekleniyor...`);
        setTimeout(()=>{
          const ccw = STATE.chapterCaches.get(chId);
          if (ccw && ccw.indexCache.has(pageIdx)) return;
          if (STATE.pendingGoogle.has(mangaUrl)) return; // hâlâ uçuşta: izci ateşlemez
          console.warn('[MGC] itme gelmedi, tekrar kuyruklanıyor', chNum, pageIdx);
          STATE.pendingGoogle.delete(mangaUrl);
          STATE.apiQueued.delete(key);
          injectOnePage({url, dataUrlIn:null, chId, pageIdx, chNum, total});
        }, 300000);
        return 'queued';
      }
      if (prog) prog.style.display='none';
      STATE.pendingGoogle.delete(mangaUrl);
      STATE.apiQueued.delete(key);
      blobAlive(url); blobAlive(mangaUrl); pageAlive(key);
      const outUrl = inj.dataUrl;
      setPageResult(chId, pageIdx, mangaUrl, outUrl);
      if (chId===getChapterId()){
        updateHud();
        // Kimlik taraması: hash ile kesin eşleşen görsele uygula (tahmin yok, karışma yok)
        try{
          getReaderImages().forEach(im=>{
            if (im.dataset.mgcIdxSrc==='hash'){ if (getPageIndex(im)===pageIdx) tryRestoreFromCache(im); }
            else identifyAndRestore(im);
          });
        }catch(e){}
      } else {
        console.log(`[MGC] enjekte arka plan çevrildi ${chNum}:${pageIdx+1}`);
      }
      return 'done';
    }catch(e){
      try{ STATE.lastErr = `${chNum}:${pageIdx+1}=${String(e&&e.message||e).slice(0,60)}`; }catch(_){}
      console.warn('[MGC] enjekte sayfa hata', chNum, pageIdx, e.message);
      if (pageDead(key)){
        if (prog){ prog.textContent = `Bölüm ${chNum} Sayfa ${pageIdx+1} indirilemiyor, atlandı`; setTimeout(()=>{prog.style.display='none';}, 5000); }
        STATE.pendingGoogle.delete(mangaUrl);
        STATE.apiQueued.delete(key);
        updateHud('bir sayfa atlandı (indirilemiyor)');
        return 'dead-page';
      }
      if (prog){ prog.textContent = `Bölüm ${chNum} Sayfa ${pageIdx+1} tekrar denenecek`; setTimeout(()=>{prog.style.display='none';}, 3000); }
      STATE.pendingGoogle.delete(mangaUrl);
      // tekrar kuyruğa al (loop durmasın): 404 bayat-biletse önce tazele
      const backoff = (chId === getChapterId()) ? 2500 : 15000;
      const needFresh = /404|indirilemedi/i.test(String(e&&e.message||e));
      setTimeout(async ()=>{
        STATE.apiQueued.delete(key);
        let furl = url, waitMore = 0;
        if (needFresh){
          updateHud('bilet tazeleniyor...');
          furl = (await refreshChapterUrls(chId, pageIdx)) || url;
          if (furl === url) waitMore = 30000; // tazeleme tutmadı: at-home'u dövme
        }
        if (waitMore) await new Promise(r=>setTimeout(r, waitMore));
        injectOnePage({url: furl, dataUrlIn:null, chId, pageIdx, chNum, total});
      }, backoff);
      updateHud();
      return 'retry';
    }
  }
  async function autoTranslateViaAPI(){
    if (!STATE.userStarted){ updateHud(); return; }
    const cid = getChapterId();
    if (!cid){ return; }
    if (STATE._apiLoopCid === cid) return; // çift çalış engeli (kapı + aralık üst üste binmesin)
    STATE._apiLoopCid = cid;
    const clearLoop = ()=>{ if (STATE._apiLoopCid === cid) STATE._apiLoopCid = null; };
    const retryLater = ()=>{
      clearLoop();
      setTimeout(()=>{ if (STATE.userStarted && getChapterId()===cid) autoTranslateViaAPI(); }, 15000);
    };
    console.log('[MGC] sayfa listesi alınıyor', cid.slice(0,8));
    let urls = null;
    const centry = STATE.chapterCaches.get(cid);
    if (centry && centry.pageUrls && centry.pageUrls.length){ urls = centry.pageUrls; }
    else {
      urls = await fetchChapterPageUrls();
      if (!urls || !urls.length){
        STATE._emptyAtHome = STATE._emptyAtHome || {};
        STATE._emptyAtHome[cid] = (STATE._emptyAtHome[cid]||0)+1;
        if (STATE._emptyAtHome[cid] >= 3){
          clearLoop();
          updateHud('bu chapter harici bağlantı olabilir (sayfa listesi boş)');
          console.log('[MGC] at-home boş, tekrar denenmeyecek', cid.slice(0,8));
          return;
        }
        updateHud('sayfa listesi alınamadı, 15sn sonra tekrar'); retryLater(); return;
      }
    }
    console.log('[MGC] ENJEKTE LOOP:', urls.length, 'sayfa, sekme yok, chapter bitene kadar (cid', String(cid).slice(0,8)+')');
    STATE.totalCount = Math.max(STATE.totalCount, urls.length);
    if (!STATE.chapterCaches.has(cid)) STATE.chapterCaches.set(cid, {translationCache:new Map(), indexCache:new Map(), srcToIndex:new Map(), totalCount: urls.length, domNextIdx:0, pageUrls: urls, hashToIdx:new Map()});
    else { const ce = STATE.chapterCaches.get(cid); ce.totalCount = urls.length; ce.pageUrls = urls; }
    updateHud();

    // Pencere tabanlı kuyruk: görünen sayfa +-3, sonra genişlet (79 tek seferde YOK)
    const WINDOW_RADIUS = 3;          // önceki/sonraki 3 sayfa
    const MAX_IN_FLIGHT = 8;          // 2 sekmelik havuz + pencere akışı
    let queuedIndices = new Set();
    let currentCenter = -1;

    function getVisiblePageIndex(){
      // 1) sayfa göstergesinden
      const pn = getCurrentPageNumberFromDOM();
      if (pn!==null && pn>=0 && pn<urls.length) return pn;
      // 1b) gösterge yoksa URL'deki /sayfa (taze yüklemede başlık gizli olur;
      // birincil-görsel tahmini yerleşim oturmamışken komşuyu seçebiliyor)
      try{
        const upn = getPageNumberFromURL();
        if (upn!==null && upn>=0 && upn<urls.length) return upn;
      }catch(e){}
      // 2) viewport'taki birincil görsel
      try{
        const prim = getPrimaryReaderImage();
        if (prim){
          const idx = getPageIndex(prim);
          if (idx!==null && idx>=0 && idx<urls.length) return idx;
        }
      }catch(e){}
      // 3) ilk çevrilmemiş
      for (let i=0;i<urls.length;i++){
        const cc = STATE.chapterCaches.get(cid);
        if (!cc || !cc.indexCache.has(i)) return i;
      }
      return 0;
    }

    function queueWindow(center, force){
      if (center===currentCenter && !force) return;
      currentCenter = center;
      const start = Math.max(0, center - WINDOW_RADIUS);
      const end = Math.min(urls.length - 1, center + WINDOW_RADIUS);
      let added = 0;
      for (let i=start; i<=end && added < MAX_IN_FLIGHT; i++){
        const cc = STATE.chapterCaches.get(cid);
        if (cc && cc.indexCache.has(i)) { queuedIndices.delete(i); continue; } // zaten çevrildi
        if (STATE.apiQueued.has(`${cid}:${i}`)) continue;
        // ponytail: pageDead/blobDead sayaç artırır, burada doğrudan oku (saf kontrol)
        try{ if (STATE.pageFails && (STATE.pageFails[`${cid}:${i}`]||0) >= 4) continue; }catch(_){}
        try{ if (STATE.blobFails && (STATE.blobFails[String(urls[i]||'')]||0) >= 2) continue; }catch(_){}
        // Canlı uçuş var mı? Yoksa (kayıp iş) yeniden enjekte et — queuedIndices tek başına engel değil
        let live = false;
        try{ for (const pr of STATE.pendingGoogle.values()){ if (pr && pr.chId===cid && pr.pageIdx===i){ live = true; break; } } }catch(_){}
        if (live) { queuedIndices.add(i); continue; }
        const chNum = center!==-1 ? `B${center+1}` : 'Bölüm';
        injectOnePage({url: urls[i], chId: cid, pageIdx: i, chNum, total: urls.length});
        queuedIndices.add(i);
        added++;
      }
      // Pencere dışındaki bitmişleri temizle (bellek)
      for (const q of queuedIndices){
        if (q < start || q > end){
          const cc = STATE.chapterCaches.get(cid);
          if (cc && cc.indexCache.has(q)) queuedIndices.delete(q);
        }
      }
    }

    function expandIfNeeded(){
      // Kuyruktaki işler biterse pencereyi genişlet
      const cc = STATE.chapterCaches.get(cid);
      if (!cc) return;
      let inProgress = 0;
      for (const q of queuedIndices){
        if (!cc.indexCache.has(q) && STATE.apiQueued.has(`${cid}:${q}`)) inProgress++;
      }
      if (inProgress < 3 && currentCenter!==-1){
        // Merkeze yakın çevrilmemiş var mı?
        const start = Math.max(0, currentCenter - WINDOW_RADIUS);
        const end = Math.min(urls.length - 1, currentCenter + WINDOW_RADIUS);
        let hasMissing = false;
        for (let i=start;i<=end;i++){
          if (!cc.indexCache.has(i) && !STATE.apiQueued.has(`${cid}:${i}`)){
            hasMissing = true; break;
          }
        }
        if (hasMissing) queueWindow(currentCenter, true);
      }
      // Sonraki sayfaları da kuyruğa al (ileri okuma): merkezden ileri ilk eksik, tur başına 1.
      // Kullanıcı dururken de chapter tamamlansın — /14'te takılma engeli.
      // Uçuş üst sınırı: at-home/CDN'yi dövme (tur başına 1 kuralı korunur).
      let fwdIp = 0;
      try{ for (const pr of STATE.pendingGoogle.values()){ if (pr && pr.chId===cid) fwdIp++; } }catch(_){}
      for (let n = currentCenter + 1; n < urls.length && fwdIp < 10; n++){
        if (cc.indexCache.has(n) || STATE.apiQueued.has(`${cid}:${n}`)) continue;
        let lp = false;
        try{ for (const pr of STATE.pendingGoogle.values()){ if (pr && pr.chId===cid && pr.pageIdx===n){ lp = true; break; } } }catch(_){}
        if (lp) break;
        try{ if (STATE.pageFails && (STATE.pageFails[`${cid}:${n}`]||0) >= 4) continue; }catch(_){}
        const chNum2 = currentCenter!==-1 ? `B${currentCenter+1}` : 'Bölüm';
        injectOnePage({url: urls[n], chId: cid, pageIdx: n, chNum: chNum2, total: urls.length});
        queuedIndices.add(n);
        break;
      }
    }

    // İlk pencere: görünen sayfa
    const vp = getVisiblePageIndex();
    queueWindow(vp);

    // Dinamik genişletme: her 2sn'de bir kontrol et
    let sweepTick = 0;
    const expandTimer = setInterval(()=>{
      if (!STATE.userStarted || getChapterId()!==cid){ clearInterval(expandTimer); clearLoop(); return; }
      // Görünen sayfa değişti mi?
      const newVp = getVisiblePageIndex();
      if (newVp!==currentCenter){
        queueWindow(newVp);
      } else {
        expandIfNeeded();
      }
      // Bayat uçuş temizliği: havuzda takılıp push'suz kalan işi serbest bırak
      // (arka-plan sekme kısılması/ölü sekme; tek-seferlik izci yetmiyordu — /14 takılması)
      try{
        const _now = Date.now();
        for (const [u, pr] of STATE.pendingGoogle.entries()){
          if (!pr || pr.chId!==cid) continue;
          if (!pr.t0){ pr.t0 = _now; continue; }
          if (_now - pr.t0 > 240000){
            const _pi = (pr.pageIdx!==null && pr.pageIdx!==undefined) ? pr.pageIdx : null;
            console.warn('[MGC] bayat iş serbest, tekrar kuyruklanacak', _pi);
            STATE.pendingGoogle.delete(u);
            if (_pi!==null){ STATE.apiQueued.delete(`${cid}:${_pi}`); queuedIndices.delete(_pi); }
            try{ if (pr.progressEl) pr.progressEl.style.display='none'; }catch(_){}
          }
        }
      }catch(_){}
      // Kalp atışı: kimliği geç kurulmuş görünen sayfalar için periyodik süpürme
      // (kuyruk kuruyunca tetik kalmaz, son sayfalar takılı kalırdı)
      sweepTick++;
      if (sweepTick % 5 === 0) sweepRestore();
      // Tümü bittiyse dur (kapanışta son süpürme: geç render edilenler için)
      const cc2 = STATE.chapterCaches.get(cid);
      if (cc2 && cc2.indexCache.size >= urls.length){
        clearInterval(expandTimer);
        clearLoop();
        sweepRestore();
        setTimeout(()=>{ if (STATE.userStarted && getChapterId()===cid) sweepRestore(); }, 4000);
        startPostBeat(cid);
        try{ queueNextChapterPrefetch(cid); }catch(_){}
      }
    }, 2000);
  }
  async function queueNextChapterPrefetch(cid){
    // Havuz boşta kalmasın: mevcut chapter bitince SONRAKİ chapter'ı önden çevir.
    // Kullanıcı geçince çeviriler hazır olur ("sonradan geldi" gecikmesi engeli).
    // Mevcut chapter'a dokunmaz (o zaten tam); chapter değişince bekleyen işler
    // normal kapılarla temizlenir, bitenler cache'te kalır.
    try{
      if (!STATE.userStarted || getChapterId()!==cid) return;
      STATE._prefetched = STATE._prefetched || {};
      if (STATE._prefetched[cid]) return;
      if (Object.keys(STATE._prefetched).length > 10) STATE._prefetched = {};
      STATE._prefetched[cid] = true;
      const ch = await fetchJsonWithTimeout(`https://api.mangadex.org/chapter/${cid}?includes[]=manga`, 15000);
      if (!STATE.userStarted || getChapterId()!==cid) return;
      const rel = (ch.data && ch.data.relationships) || [];
      const manga = ((rel.find(r=>r.type==='manga'))||{}).id;
      const lang = (ch.data && ch.data.attributes && ch.data.attributes.translatedLanguage) || 'en';
      if (!manga) return;
      const feed = await fetchJsonWithTimeout(`https://api.mangadex.org/manga/${manga}/feed?limit=500&translatedLanguage[]=${encodeURIComponent(lang)}&order[chapter]=asc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`, 20000);
      if (!STATE.userStarted || getChapterId()!==cid) return;
      const list = ((feed && feed.data)||[]).map(d=>d.id);
      const at = list.indexOf(cid);
      const next = at>=0 ? list[at+1] : null;
      if (!next || STATE.chapterCaches.has(next)) return;
      const j = await fetchJsonWithTimeout(`https://api.mangadex.org/at-home/server/${next}`, 20000);
      if (!STATE.userStarted || getChapterId()!==cid) return;
      const files = (j.chapter && (j.chapter.data || j.chapter.dataSaver)) || [];
      if (!files.length) return;
      const urls2 = files.map(f=>`${j.baseUrl}/data/${j.chapter.hash}/${f}`);
      STATE.chapterCaches.set(next, {translationCache:new Map(), indexCache:new Map(), srcToIndex:new Map(), totalCount: urls2.length, domNextIdx:0, pageUrls: urls2, hashToIdx:new Map()});
      console.log('[MGC] sonraki chapter önden çevriliyor', String(next).slice(0,8), urls2.length);
      for (let i=0;i<urls2.length;i++){
        if (!STATE.userStarted || getChapterId()!==cid) return;
        try{
          const ce2 = STATE.chapterCaches.get(next);
          if (ce2 && ce2.indexCache.has(i)) continue;
          injectOnePage({url: urls2[i], chId: next, pageIdx: i, chNum: 'Ön', total: urls2.length});
        }catch(_){}
        await new Promise(r=>setTimeout(r, 1500));
      }
    }catch(e){}
  }
  function getReaderContainer(){
    const now = Date.now();
    if (STATE.readerContainerCache && (now - STATE.readerContainerCacheTime) < 2000) return STATE.readerContainerCache;
    // en çok blob img içeren div'i bul
    const allDivs = Array.from(document.querySelectorAll('div'));
    let best=null, bestCount=0;
    for (const d of allDivs){
      // hızlı filtre: içinde img var mı
      const imgs = d.querySelectorAll('img[src^="blob:"]');
      if (imgs.length>bestCount && imgs.length<=80){
        // container çok büyük değil, makul
        // ayrıca blob domain kontrol
        let valid=0;
        for (const im of imgs) if ((im.src||'').includes('mangadex.org')) valid++;
        if (valid>bestCount) { best=d; bestCount=valid; }
      }
    }
    // fallback: doğrudan blob img'lerin ortak atası
    if (!best || bestCount<1){
      const blobs = Array.from(document.querySelectorAll('img[src^="blob:"]')).filter(im=> (im.src||'').includes('mangadex.org'));
      if (blobs.length){
        // en dış kapsayıcı bul
        let common = blobs[0].parentElement;
        // yukarı tırmanırken çok geniş kapsayıcıdan kaçın
        while (common && common !== document.body && common.querySelectorAll('img[src^="blob:"]').length === blobs.length){
          const p = common.parentElement;
          if (!p || p===document.body) break;
          const cnt = p.querySelectorAll('img[src^="blob:"]').length;
          if (cnt===blobs.length && p.clientWidth< window.innerWidth*1.2) common=p; else break;
        }
        best = common || document.body;
        bestCount = blobs.length;
      } else {
        best = document.body;
      }
    }
    STATE.readerContainerCache = best;
    STATE.readerContainerCacheTime = now;
    return best;
  }
  function getReaderImages(){
    if (!isChapterPage()) return [];
    const container = getReaderContainer();
    // container içindeki blob img'ler
    let imgs = [];
    if (container){
      imgs = Array.from(container.querySelectorAll('img')).filter(img=>{
        const src = img.src || img.dataset.src || '';
        if (!src.startsWith('blob:')) return false;
        if (!src.toLowerCase().includes('mangadex.org')) return false;
        // boyut filtresi: sadece çok küçük (ikon) ele, sayfa görselleri genelde >=300px
        const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width')||0);
        const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height')||0);
        if (w>0 && h>0 && w<100 && h<100) return false; // sadece ikonlar
        // görünmez küçük elemanları ele
        if (img.offsetParent===null && w<50) return false;
        return true;
      });
    }
    // fallback: genel tarama - container bulunamadı veya 0
    if (!imgs.length){
      imgs = Array.from(document.querySelectorAll('img')).filter(img=>{
        const src = img.src || '';
        return src.startsWith('blob:') && src.includes('mangadex.org') && (img.naturalWidth>=150 || img.width>=150 || !img.complete);
      });
    }
    // EK: sayfa sayısı API'den biliniyorsa, eksik sayfaları data-page attr ile bul
    const cid = getChapterId();
    const cc = cid ? STATE.chapterCaches.get(cid) : null;
    if (cc && cc.pageUrls && cc.pageUrls.length > imgs.length){
      // parent data-page ile sayfa elemanlarını bul
      const pageAttrImgs = Array.from(document.querySelectorAll('img[src^="blob:"]')).filter(img=>{
        const p = img.parentElement;
        return p && (p.hasAttribute('data-page') || p.hasAttribute('data-index') || p.hasAttribute('data-reader-page'));
      });
      for (const pi of pageAttrImgs){
        if (!imgs.includes(pi)) imgs.push(pi);
      }
    }
    // sırala: DOM sırasına göre
    imgs.sort((a,b)=>{
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return imgs;
  }
  function getPrimaryReaderImage(){
    // Tek-sayfa modda GERÇEKTEN görünen sayfa: viewport'ta en büyük alana sahip reader görseli
    try{
      const imgs = getReaderImages();
      if (!imgs.length) return null;
      let best = null, bestArea = 0;
      const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      for (const im of imgs){
        const r = im.getBoundingClientRect();
        const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const area = visW * visH;
        if (area > bestArea){ bestArea = area; best = im; }
      }
      return best || imgs[0];
    }catch(e){ return null; }
  }
  async function sha256hex(buf){
    try{
      if (typeof crypto!=='undefined' && crypto.subtle && crypto.subtle.digest){
        const d = await crypto.subtle.digest('SHA-256', buf);
        return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
      }
    }catch(e){}
    try{
      const v = new Uint8Array(buf); let h1=0xcbf29ce4, h2=0x84222325;
      const n = Math.min(v.length, 1<<20);
      for (let i=0;i<n;i++){ h1 = Math.imul(h1 ^ v[i], 16777619); h2 = Math.imul(h2 ^ v[(i*7)%n], 16777619); }
      return 'fnv'+(h1>>>0).toString(16)+(h2>>>0).toString(16);
    }catch(e){ return null; }
  }
  // Blob baytlarından sayfa kimliği: o chapter'ın orijinalleriyle birebir eşleşme (tahmin yok)
  async function identifyBlobPage(img){
    try{
      if (!img || !img.src || !img.src.startsWith('blob:')) return null;
      const cid = getChapterId(); if (!cid) return null;
      const cc = STATE.chapterCaches.get(cid);
      if (!cc){ console.log('[MGC] kimlik cc-yok'); return null; }
      try{
        if (cc.srcToIndex && cc.srcToIndex.has(img.src)){
          const ix0 = cc.srcToIndex.get(img.src);
          if (ix0!==undefined && ix0!==null){
            STATE.pageIndexMap.set(img, ix0);
            img.dataset.mgcPageIndex = String(ix0);
            img.dataset.mgcIdxSrc = 'hash';
            console.log('[MGC] kimlik memo', ix0);
            return ix0;
          }
        }
      }catch(_){}
      if (!cc.hashToIdx){ console.log('[MGC] kimlik map-yok'); return null; }
      // blob URL'ler süreyle geçersiz olabilir - 1 kez dene, başarısızsa null
      // (dönmeyen fetch asılı bırakıyordu: 15sn yarış, kalp atışı sonra tekrar dener)
      let r, buf, hex;
      try{
        r = await Promise.race([
          fetch(img.src, {credentials:'omit', cache: 'no-store'}),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('blob-fetch-timeout')), 15000)),
        ]);
      }catch(fe){
        if (!cc._timeLogged){ cc._timeLogged = true; console.log('[MGC] kimlik zaman-asimi'); }
        return null;
      }
      if (!r.ok){ console.log('[MGC] kimlik fetch', r.status); return null; }
      try{
        buf = await Promise.race([
          r.arrayBuffer(),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('blob-body-timeout')), 15000)),
        ]);
      }catch(_){ return null; }
      if (!buf || !buf.byteLength){ console.log('[MGC] kimlik bos-govde'); return null; }
      hex = await sha256hex(buf);
      if (!hex){ console.log('[MGC] kimlik hash-yok'); return null; }
      const idx = cc.hashToIdx.get(hex);
      if (idx===undefined || idx===null){
        // ponytail: hash başına 1 log; global-once sonrası sessizlik gerçek bilinmeyenleri gizliyordu
        try{
          cc._missSet = cc._missSet || new Set();
          const hk = hex.slice(0,12);
          if (!cc._missSet.has(hk)){ cc._missSet.add(hk); console.log('[MGC] kimlik yok', hk, 'map', cc.hashToIdx.size); }
        }catch(_){}
        return null;
      }
      console.log('[MGC] kimlik hash', idx);
      try{
        if (!cc.srcToIdx) cc.srcToIdx = new Map();
        if (!cc.srcToIdx.has(img.src)) cc.srcToIdx.set(img.src, idx);
      }catch(_){}
      STATE.pageIndexMap.set(img, idx);
      img.dataset.mgcPageIndex = String(idx);
      img.dataset.mgcIdxSrc = 'hash';
      if (!STATE.srcToIndex.has(img.src)) STATE.srcToIndex.set(img.src, idx);
      return idx;
    }catch(e){ 
      console.warn('[MGC] identifyBlobPage fail', img?.src?.slice(0,60), e);
      return null; 
    }
  }
  async function identifyAndRestore(img){
    try{
      if (!img || !isReaderImage(img)){ console.log('[MGC] kimlik atlandi'); return false; }
      if (img.dataset.mgcIdRun==='1') return false;
      img.dataset.mgcIdRun='1';
      try{
      if (img.dataset.mgcIdxSrc==='hash'){
        try{
          const _cc = STATE.chapterCaches.get(getChapterId());
          if (_cc && !_cc._ksLogged){ _cc._ksLogged = true; console.log('[MGC] kimlik kisa-devre', img.dataset.mgcPageIndex); }
        }catch(_){}
        return tryRestoreFromCache(img);
      }
      if (!img.src || !img.src.startsWith('blob:')) return tryRestoreFromCache(img);
      const idx = await identifyBlobPage(img);
      // Hash başarısızsa: gösterge + birincillik fallback (sadece görünen sayfa için,
      // SADECE harita tamamsa ve numara boşsa — eksik haritada miss "henüz kaydolmadı" demektir)
      if (idx===null || idx===undefined){
        let pn = getCurrentPageNumberFromDOM();
        if (pn===null) pn = getPageNumberFromURL(); // gösterge gizliyse URL'deki /sayfa
        const prim = getPrimaryReaderImage();
        // Zehirli kayıt şüphesi (harita tamam ama birincil eşleşmiyor, çevirisi de yok):
        // dosyayı bir kez tazeleyip kimliği tekrar dene — tahmin basmadan önce.
        if (prim===img && pn!==null && pn>=0 && isHashMapFull() && !isIdxClaimed(pn)){
          try{
            const _cid = getChapterId(); const _cc = _cid && STATE.chapterCaches.get(_cid);
            if (_cc && !_cc.indexCache.has(pn) && await rehashFileIfNeeded(_cid, pn)){
              const idx2 = await identifyBlobPage(img);
              if (idx2!==null && idx2!==undefined) return tryRestoreFromCache(img);
            }
          }catch(_){}
          STATE.pageIndexMap.set(img, pn);
          img.dataset.mgcPageIndex = String(pn);
          img.dataset.mgcIdxSrc = 'indicator-fallback';
          return tryRestoreFromCache(img);
        }
        return false;
      }
      return tryRestoreFromCache(img);
      }finally{ try{ delete img.dataset.mgcIdRun; }catch(_){} }
    }catch(e){ return false; }
  }
  function resetRecycledImage(img){
    // MangaDex tek-sayfa modda img elemanını geri dönüştürür (yeni blob src).
    // Eski indeksle restore KARIŞTIRIR — sıfırla, true dön.
    if (!img || !img.src || !img.src.startsWith('blob:')) return false;
    if (!img.dataset.mgcAttachedSrc || img.src === img.dataset.mgcAttachedSrc) return false;
    STATE.pageIndexMap.delete(img);
    delete img.dataset.mgcIdRun;
    delete img.dataset.mgcPageIndex;
    delete img.dataset.mgcTranslated;
    delete img.dataset.mgcOriginal;
    delete img.dataset.mgcIdxSrc;
    delete img.dataset.mgcAttached;
    img.dataset.mgcOriginal = img.src;
    img.dataset.mgcAttachedSrc = img.src;
    try{ STATE.observedImages.delete(img); }catch(e){}
    const bb = img.parentElement?.querySelector('.mgc-translate-btn');
    if (bb){ bb.classList.remove('translated'); bb.dataset.busy='0'; bb.disabled=false; }
    const bd = img.parentElement?.querySelector('.mgc-badge');
    if (bd) bd.style.display='none';
    console.log('[MGC] geri dönüştürülmüş img sıfırlandı, yeniden indekslenecek');
    return true;
  }
  function isReaderImage(img){
    const src = img.src || '';
    if (!src.startsWith('blob:')) return false;
    if (!src.includes('mangadex.org')) return false;
    if (isChapterPage()){
      const container = getReaderContainer();
      if (container && container!==document.body){
        // eğer container body değilse içinde olmalı
        if (!container.contains(img)) {
          // bazı reader modlarında img body dışında olabilir mi? fallback kabul et
          // ama chapter sayfasında blob genelde reader içindedir
          // yine de true dön, çünkü blob zaten nadir
        }
      }
      return true;
    }
    return false;
  }
  function ensureHud(){
    if (document.getElementById('mgc-hud')) { STATE.hudEl = document.getElementById('mgc-hud'); return; }
    const hud = document.createElement('div');
    hud.id='mgc-hud';
    hud.style.cssText='position:fixed;top:12px;right:20px;z-index:10001;background:rgba(32,33,36,0.92);color:white;padding:8px 12px;border-radius:20px;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:none;align-items:center;gap:8px;box-shadow:0 2px 10px rgba(0,0,0,0.3);backdrop-filter:blur(4px);';
    hud.innerHTML='<span style="background:#4285F4;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px">G</span><span id="mgc-hud-text">0/0 çevrildi</span><span id="mgc-hud-sub" style="opacity:0.8;font-size:11px"></span><button id="mgc-hud-start" title="Çeviriyi başlat/durdur" style="pointer-events:auto;cursor:pointer;background:#4285F4;color:white;border:none;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:700;line-height:1.6">▶</button>';
    document.documentElement.appendChild(hud);
    STATE.hudEl = hud;
    hud.querySelector('#mgc-hud-start')?.addEventListener('click', (e)=>{ e.stopPropagation(); setStarted(!STATE.userStarted); });
  }
  function updateHud(extra){
    if (!STATE.hudEl) ensureHud();
    const hud = STATE.hudEl;
    if (!hud) return;
    refreshStartedDataset();
    try{
      const dbgR = isChapterPage() ? getReaderImages() : [];
      document.documentElement.dataset.mgcDbg = JSON.stringify({
        pn: getCurrentPageNumberFromDOM(),
        n: dbgR.length,
        idx: dbgR.map(im=> (im.dataset.mgcPageIndex||'?')+':'+(im.dataset.mgcIdxSrc||'?')),
        ck: [...STATE.indexCache.keys()],
        q: STATE.apiQueued.size,
        pd: STATE.pendingGoogle.size,
        le: STATE.lastErr||'none',
        hh: (()=>{ try{ const cc=STATE.chapterCaches.get(getChapterId()); return cc&&cc.hashToIdx?cc.hashToIdx.size:0; }catch(e){ return -1; } })()
      });
    }catch(e){}
    if (!isChapterPage()){
      hud.style.display='none';
      return;
    }
    let translated = 0;
    try{
    const readerImgs = getReaderImages();
    const total = Math.max(STATE.totalCount, readerImgs.length, STATE.translationCache.size + STATE.queue.length + (STATE.processing?1:0));
    // gerçek çevrilen: cache size + DOM'da dataUrl olanlar
    translated = STATE.translationCache.size;
    // ayrıca indexCache size'ı da aynı sayılır, en büyüğünü al
    translated = Math.max(translated, STATE.indexCache.size);
    // DOM'da gömülü olanları da say
    const domTranslated = document.querySelectorAll('img.mgc-target[data-mgc-translated]').length;
    translated = Math.max(translated, domTranslated);
    // total güncelle
    if (readerImgs.length) STATE.totalCount = Math.max(STATE.totalCount, readerImgs.length);
    // eğer hiç reader yoksa gizle
    if (STATE.totalCount===0 && readerImgs.length===0){
      hud.style.display='none';
      return;
    }
    hud.style.display='flex';
    const startBtn = document.getElementById('mgc-hud-start');
    if (startBtn){
      startBtn.textContent = STATE.userStarted ? '⏸' : '▶';
      startBtn.title = STATE.userStarted ? 'Duraklat' : 'Çeviriyi başlat';
      startBtn.style.background = STATE.userStarted ? '#5F6368' : '#4285F4';
    }
    const txt = document.getElementById('mgc-hud-text');
    const sub = document.getElementById('mgc-hud-sub');
    if (txt) txt.textContent = `${translated}/${STATE.totalCount || readerImgs.length || '?'} çevrildi`;
    if (sub){
      if (extra) sub.textContent = extra;
      else if (!STATE.userStarted) sub.textContent = 'başlamak için ▶’ye bas';
      else if (STATE.processing) sub.textContent = 'çevriliyor...';
      else if (translated>0 && translated < (STATE.totalCount||0)) sub.textContent = 'sırada...';
      else if (translated===STATE.totalCount && translated>0) sub.textContent = '✓ tamamlandı';
      else sub.textContent = '';
    }
    }catch(e){ console.error('[MGC] updateHud kuyruk hata', String(e&&e.message||e).slice(0,150)); }
    // renk: tamamlandı yeşil
    if (translated===STATE.totalCount && translated>0) hud.style.background='rgba(52,168,83,0.95)';
    else if (STATE.processing) hud.style.background='rgba(66,133,244,0.95)';
    else hud.style.background='rgba(32,33,36,0.92)';
  }

  // ---------- Toolbar ----------
  function injectToolbar() {
    if (STATE.toolbarInjected) return;
    if (!location.hostname.includes('mangadex.org')) return;
    const bar = document.createElement('div');
    bar.id = 'mgc-toolbar';
    bar.className = 'mgc-toolbar';
    bar.innerHTML = `
      <div class="mgc-toolbar-header" id="mgc-drag-handle" style="cursor:move;user-select:none">
        <span style="background:#4285F4;color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">G</span>
        <span>MangaDex Görsel Çeviri</span>
        <span style="margin-left:auto;display:flex;gap:4px;align-items:center">
          <span id="mgc-minimize-toolbar" title="Küçült" style="cursor:pointer;color:#5F6368;font-size:18px;padding:4px 6px;line-height:1">—</span>
          <span id="mgc-close-toolbar" title="Kapat" style="cursor:pointer;color:#5F6368;font-size:18px;padding:4px">✕</span>
        </span>
      </div>
      <div style="background:#E8F0FE;border-radius:8px;padding:8px;margin-bottom:10px;font-size:11px;color:#1967D2;line-height:1.4">
        <b>Yeni:</b> Görünen sayfa öncelikli pencere kuyruğu — bulunduğun sayfa önce çevrilir.
      </div>
      <div class="mgc-toolbar-row">
        <label>Çeviri Modu</label>
        <select id="mgc-mode">
          <option value="google_direct">Google Görsel (çalışıyor)</option>
          <option value="yandex_ocr" disabled>Yandex Hızlı (API engellenmiş)</option>
          <option value="multi_auto">Otomatik (Google)</option>
          <option value="tesseract">Yerel OCR (Tesseract)</option>
        </select>
      </div>
      <div class="mgc-toolbar-row">
        <label>Hedef Dil</label>
        <select id="mgc-target-lang">
          <option value="tr">Türkçe</option>
          <option value="en">English</option>
          <option value="az">Azərbaycanca</option>
          <option value="de">Deutsch</option>
          <option value="fr">Français</option>
          <option value="es">Español</option>
          <option value="ru">Русский</option>
          <option value="ar">العربية</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
          <option value="zh">中文</option>
        </select>
      </div>
      <div class="mgc-toolbar-row" id="mgc-ocr-row">
        <label>OCR Dili</label>
        <select id="mgc-ocr-lang">
          <option value="eng">İngilizce</option>
          <option value="jpn">Japonca</option>
          <option value="eng+jpn">İng + Japonca</option>
          <option value="kor">Korece</option>
          <option value="chi_sim">Çince (Basit)</option>
          <option value="eng+kor">İng + Korece</option>
        </select>
      </div>
      <div class="mgc-toolbar-row">
        <label style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="mgc-auto"/> Otomatik çevir
        </label>
      </div>
      <div class="mgc-toolbar-row" style="font-size:11px;color:#5F6368;justify-content:flex-start;gap:6px">
        <input type="checkbox" id="mgc-keep-tab"/>
        <label for="mgc-keep-tab">Google sekmesini açık tut (debug)</label>
      </div>
      <button id="mgc-start-stop">▶ Başla</button>
      <button id="mgc-clear-all" class="secondary">🧹 Çevirileri Temizle</button>
      <div style="font-size:10px;color:#80868B;margin-top:8px;line-height:1.3">
        <span id="mgc-mode-hint"></span><br>
        <b>Kısayol:</b> <code>Alt+T</code> çevir, <code>Alt+C</code> temizle. Her görselin üstündeki <b style="color:#4285F4">G</b> butonuna da basabilirsin.
      </div>
    `;
    document.documentElement.appendChild(bar);
    // Küçültüldüğünde tekrar açmak için küçük buton
    let openBtn = document.getElementById('mgc-open-toolbar');
    if (!openBtn){
      openBtn = document.createElement('button');
      openBtn.id='mgc-open-toolbar';
      openBtn.title='Paneli aç';
      openBtn.innerHTML='G';
      openBtn.style.cssText='display:none;position:fixed;bottom:20px;right:20px;z-index:10002;background:#4285F4;color:white;border:none;border-radius:50%;width:44px;height:44px;font-size:18px;font-weight:700;box-shadow:0 2px 10px rgba(0,0,0,0.3);cursor:pointer;align-items:center;justify-content:center;';
      openBtn.addEventListener('click', ()=>{
        bar.style.display='block';
        openBtn.style.display='none';
        // konum yoksa ortaya getir
        if (!bar.style.left) { bar.style.top='70px'; bar.style.right='16px'; }
      });
      document.documentElement.appendChild(openBtn);
    }
    // Sürüklenebilir yap
    setupDraggable(bar, bar.querySelector('#mgc-drag-handle'));
    function setupDraggable(el, handle){
      if (!handle) return;
      let isDragging=false, startX, startY, startLeft, startTop;
      const onDown = (clientX, clientY)=>{
        const rect = el.getBoundingClientRect();
        startX=clientX; startY=clientY; startLeft=rect.left; startTop=rect.top;
        isDragging=true;
        el.style.transition='none';
      };
      handle.addEventListener('mousedown', e=>{ onDown(e.clientX,e.clientY); e.preventDefault(); });
      handle.addEventListener('touchstart', e=>{ const t=e.touches[0]; onDown(t.clientX,t.clientY); }, {passive:false});
      const onMove = (clientX, clientY)=>{
        if (!isDragging) return;
        const dx=clientX-startX, dy=clientY-startY;
        let nl = startLeft+dx, nt = startTop+dy;
        // sınırlar içinde tut
        nl = Math.max(4, Math.min(window.innerWidth - el.offsetWidth -4, nl));
        nt = Math.max(4, Math.min(window.innerHeight - el.offsetHeight -4, nt));
        el.style.left = nl+'px';
        el.style.top = nt+'px';
        el.style.right='auto';
        el.style.bottom='auto';
        el.style.position='fixed';
      };
      document.addEventListener('mousemove', e=> onMove(e.clientX,e.clientY));
      document.addEventListener('touchmove', e=>{ if(!isDragging) return; const t=e.touches[0]; onMove(t.clientX,t.clientY); e.preventDefault(); }, {passive:false});
      const onUp = ()=>{ if(isDragging){ isDragging=false; el.style.transition=''; } };
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchend', onUp);
    }

    STATE.toolbarInjected = true;
    setTimeout(() => {
      const modeSel = document.getElementById('mgc-mode');
      const tl = document.getElementById('mgc-target-lang');
      const ol = document.getElementById('mgc-ocr-lang');
      const au = document.getElementById('mgc-auto');
      const keep = document.getElementById('mgc-keep-tab');
      const hint = document.getElementById('mgc-mode-hint');
      const ocrRow = document.getElementById('mgc-ocr-row');
      if (modeSel) modeSel.value = STATE.settings.translateMode;
      if (tl) tl.value = STATE.settings.targetLang;
      if (ol) ol.value = STATE.settings.ocrLang;
      if (au) au.checked = STATE.settings.autoTranslate;
      if (keep) keep.checked = STATE.settings.keepTranslateTab;

      const updateHint = ()=>{
        const m = modeSel.value;
        if (m==='google_direct') {
          hint.innerHTML = 'Google Görsel: <code>translate.google.com/?op=images</code> ile tam görsel çeviri. En doğru sonuç.';
          ocrRow.style.display='none';
        } else if (m==='yandex_ocr') {
          hint.innerHTML = 'Yandex Hızlı: <b style="color:#c00">API engellenmiş (Firefox kısıtlaması)</b>. Google modunu kullanın.';
          ocrRow.style.display='none';
        } else if (m==='multi_auto') {
          hint.innerHTML = 'Otomatik: Sadece Google Görsel kullanılır (Yandex API engellenmiş).';
          ocrRow.style.display='none';
        } else {
          hint.innerHTML = 'Yerel OCR: Tesseract.js ile cihazında okunur, sonra Google metin çeviri yapılır.';
          ocrRow.style.display='flex';
        }
      };
      updateHint();

      modeSel?.addEventListener('change', e=>{
        STATE.settings.translateMode = e.target.value;
        browser.storage.local.set({ translateMode: e.target.value });
        updateHint();
      });
      tl?.addEventListener('change', e=>{ STATE.settings.targetLang=e.target.value; browser.storage.local.set({targetLang:e.target.value});});
      ol?.addEventListener('change', e=>{ STATE.settings.ocrLang=e.target.value; browser.storage.local.set({ocrLang:e.target.value});});
      au?.addEventListener('change', e=>{ STATE.settings.autoTranslate=e.target.checked; browser.storage.local.set({autoTranslate:e.target.checked}); if(e.target.checked) setupAutoObserver();});
      keep?.addEventListener('change', e=>{ browser.storage.local.set({keepTranslateTab: e.target.checked});});

      document.getElementById('mgc-start-stop')?.addEventListener('click', ()=> setStarted(!STATE.userStarted));
      syncStartBtn();
      // NOT: eski "Tüm Sayfayı Çevir" düğmesi kaldırıldı — ▶ Başla ile aynı işi yapıyordu (Alt+T durur).
      document.getElementById('mgc-clear-all')?.addEventListener('click', clearAllOverlays);
      const openBtnEl = document.getElementById('mgc-open-toolbar');
      document.getElementById('mgc-minimize-toolbar')?.addEventListener('click', ()=>{
        bar.style.display='none';
        if (openBtnEl) openBtnEl.style.display='flex';
      });
      document.getElementById('mgc-close-toolbar')?.addEventListener('click', ()=>{
        bar.style.display='none';
        if (openBtnEl) openBtnEl.style.display='flex';
      });
    }, 300);
  }

  function syncStartBtn(){
    const b = document.getElementById('mgc-start-stop');
    if (b){ b.textContent = STATE.userStarted ? '⏸ Duraklat' : '▶ Başla'; }
  }
  function updateToolbarUI() {
    syncStartBtn();
    const modeSel = document.getElementById('mgc-mode');
    const tl = document.getElementById('mgc-target-lang');
    const ol = document.getElementById('mgc-ocr-lang');
    const au = document.getElementById('mgc-auto');
    const keep = document.getElementById('mgc-keep-tab');
    if (modeSel) modeSel.value = STATE.settings.translateMode;
    if (tl) tl.value = STATE.settings.targetLang;
    if (ol) ol.value = STATE.settings.ocrLang;
    if (au) au.checked = STATE.settings.autoTranslate;
    if (keep) keep.checked = STATE.settings.keepTranslateTab;
  }

  // ---------- Görsel Tarama ----------
  function scanAndAttach() {
    let candidates = [];
    try{ candidates = document.querySelectorAll('img'); }catch(e){ console.error('[MGC] scan query hata', e); return; }
    candidates.forEach(img=>{
      try{
      // Geri-dönüşüm: eleman yeni blob ile yeniden kullanılıyorsa sıfırla ve yeniden ekle
      if (isChapterPage() && resetRecycledImage(img)){ try{ STATE.observedImages.delete(img); }catch(e){} }
      // zaten gözlemlendiyse: kimlikle restore dene
      if (STATE.observedImages.has(img)) {
        if (isChapterPage() && isReaderImage(img)) {
          if (!tryRestoreFromCache(img)) identifyAndRestore(img);
        }
        return;
      }
      if (!isMangaImage(img)) {
        return;
      }
      if (!img.complete || img.naturalWidth===0) {
        img.addEventListener('load', ()=>attachToImage(img), {once:true});
        setTimeout(()=>attachToImage(img), 800);
        return;
      }
      attachToImage(img);
      }catch(e){ console.error('[MGC] scan img hata', String(e&&e.message||e).slice(0,120)); }
    });
    // reader cache restore toplu
    if (isChapterPage()){
      getReaderImages().forEach(img=> tryRestoreFromCache(img));
      updateHud();
    }
  }

  function isMangaImage(img) {
    const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width')||0);
    const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height')||0);
    const src = img.src || img.dataset.src || '';
    const srcLower = src.toLowerCase();

    if (srcLower.endsWith('.svg') || srcLower.includes('/assets/') || srcLower.includes('/img/brand/') || srcLower.includes('mangadex-logo') || srcLower.includes('mangadex-wordmark') || srcLower.includes('avatar') || srcLower.includes('visa') || srcLower.includes('mastercard') || srcLower.includes('amex')) {
      return false;
    }
    if (w>0 && h>0 && (w<200 || h<200)) return false;
    if (srcLower.startsWith('blob:')) {
      if (w>=300 || h>=300 || (w===0 && h===0)) {
        if (srcLower.includes('mangadex.org')) return true;
      }
      return false;
    }
    if (srcLower.includes('mangadx') || srcLower.includes('uploads.mangadx.org') || srcLower.includes('cmdxa') || srcLower.includes('mangadex.network')) {
      return true;
    }
    if (location.pathname.includes('/chapter/')) {
      if (w>=400 || h>=400) return true;
      return false;
    }
    if (location.pathname.includes('/title/')) {
      if (w>=300 || h>=300) return true;
      return false;
    }
    if (w>=400 && h>=400) return true;
    return false;
  }

  function attachToImage(img) {
    if (STATE.observedImages.has(img)) return;
    if (!document.body.contains(img)) return;
    if (!isMangaImage(img)) return;
    if (img.dataset.mgcAttached==='1') return;
    img.dataset.mgcAttached='1';
    try{ const _cid = getChapterId(); if (_cid) img.dataset.mgcChId = _cid; }catch(_){}
    img.classList.add('mgc-target');
    // Resme tıklayınca yakınlaştır (site tıklaması boşta, sayfa çevirmez — doğrulandı)
    img.style.cursor = 'zoom-in';
    if (img.dataset.mgcZoomBound!=='1'){
      img.dataset.mgcZoomBound='1';
      img.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); toggleZoom(img); });
    }

    // sayfa index ata (reader için) + bayt-kimliğiyle kesin restore
    if (isChapterPage() && isReaderImage(img)){
      assignPageIndex(img);
      const _tr = tryRestoreFromCache(img);
      if (_tr){
        console.log('[MGC] attach restore cache', img.dataset.mgcPageIndex);
      } else {
        console.log('[MGC] attach-kimlik-gidiyor', img.src?.slice(0,40));
        identifyAndRestore(img);
      }
    } else {
      console.log('[MGC] attach-skip', isChapterPage(), img.src?.slice(0,40));
    }

    console.log('[MGC] attachToImage:', img.src?.slice(0,80), 'size', img.width, 'x', img.height, 'parent', img.parentElement?.tagName, 'idx', img.dataset.mgcPageIndex||'-');
    const parent = img.parentElement;
    if (parent) {
      const ps = getComputedStyle(parent);
      if (ps.position === 'static') parent.style.position = 'relative';
      // gölge kalınlaşması / buton üst üste binme fix: aynı parent yeniden kullanılırsa eski mgc elemanlarını temizle
      // MangaDex single-page modunda aynı div'e yeni img gelir, eski butonlar kalır
      const existingBtns = parent.querySelectorAll('.mgc-translate-btn');
      if (existingBtns.length>0){
        const imgsInParent = parent.querySelectorAll('img');
        // tek img'li parent'ta eski butonlar stale'dir
        if (imgsInParent.length<=1){
          existingBtns.forEach(b=>{
            // yeni img için eski btn'yi sil (duplicate shadow)
            if (b.dataset.mangaUrl !== img.src) b.remove();
            else if (existingBtns.length>1) b.remove();
          });
          // lens/bagde/progress temizliği
          const lenses = parent.querySelectorAll('.mgc-lens-btn');
          if (lenses.length>0){
            // aynı parent'ta tek img varsa eski lensleri sil
            lenses.forEach(l=> l.remove());
          }
          parent.querySelectorAll('.mgc-zoom-btn').forEach(z=> z.remove());
          const badges = parent.querySelectorAll('.mgc-badge');
          // çevrilmemiş yeni img için eski badge gereksiz
          if (badges.length>0 && !img.dataset.mgcTranslated){
            badges.forEach(b=> b.remove());
          } else if (badges.length>1){
            for(let i=0;i<badges.length-1;i++) badges[i].remove();
          }
          parent.querySelectorAll('.mgc-progress').forEach(p=> p.remove());
        } else if (existingBtns.length>1){
          // çoklu img'li parent'ta da en yeniyi tutup sil (birikme engeli)
          for (let i=0;i<existingBtns.length-1;i++) existingBtns[i].remove();
          console.log('[MGC] parentta fazla btn temizlendi', existingBtns.length);
        }
      }
    }

    const isDirect = STATE.settings.translateMode==='google_direct';
    const isYandex = STATE.settings.translateMode==='yandex_ocr';
    const isMulti = STATE.settings.translateMode==='multi_auto';
    const btn = document.createElement('button');
    btn.className='mgc-translate-btn';
    btn.dataset.mangaUrl = img.src;
    let modeLabel = 'Görsel';
    if (isYandex) modeLabel = 'Yandex (devre dışı)';
    else if (isMulti) modeLabel = 'Otomatik (Google)';
    else if (!isDirect) modeLabel = 'OCR';
    btn.innerHTML = `<span style="font-weight:700">G</span> ${modeLabel} <span style="opacity:0.8;font-size:10px">(${STATE.settings.targetLang.toUpperCase()})</span>`;
    btn.title = isYandex ? 'Yandex API engellenmiş - Google modunu kullanın' : isMulti ? 'Otomatik: Google Görsel kullanılır' : isDirect ? 'Google Görsel Çeviri (op=images) ile çevir - bütün görsel değişir' : 'Yerel OCR + Google ile çevir';
    // eğer zaten çevrilmişse butonu yeşil yap
    if (img.dataset.mgcTranslated) {
      btn.innerHTML = `✓ ${STATE.settings.targetLang.toUpperCase()} (Geri al)`;
      btn.classList.add('translated');
    }
    btn.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); handleTranslateClick(img,btn); });
    if (parent) parent.appendChild(btn);
    else img.insertAdjacentElement('afterend', btn);

    if (STATE.settings.showLensButton) {
      const lensBtn=document.createElement('button');
      lensBtn.className='mgc-lens-btn';
      lensBtn.textContent='Lens';
      lensBtn.title='Google Lens ile aç';
      lensBtn.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); openInLens(img.src); });
      if (parent) parent.appendChild(lensBtn);
    }

    // Büyüteç: o anki görünümü (çevriliyse çeviriyi) tam boy overlayde aç, tıkla/Esc kapat
    const zoomBtn=document.createElement('button');
    zoomBtn.className='mgc-zoom-btn';
    zoomBtn.textContent='🔍';
    zoomBtn.title='Yakınlaştır (tıkla kapat)';
    zoomBtn.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); toggleZoom(img); });
    if (parent) parent.appendChild(zoomBtn);

    if (!img.dataset.mgcOriginal) img.dataset.mgcOriginal = img.src;
    img.dataset.mgcAttachedSrc = img.src;
    // src değişim gözlemcisi: kaybolmama fix
    if (img.dataset.mgcObs==='1'){ /* gözlemci zaten var, yeniden ekleme */ }
    else {
    img.dataset.mgcObs='1';
    const obs = new MutationObserver(()=>{
      if (img.dataset.mgcTranslated && img.src === img.dataset.mgcTranslated) return;
      if (img.src.startsWith('data:')) return;
      // Geri-dönüşüm: yeni blob geldiyse eski indeksle restore YAPMA (karışma engeli)
      if (resetRecycledImage(img)){
        assignPageIndex(img);
        identifyAndRestore(img);
        return;
      }
      // Eğer src orijinale döndüyse ve cache varsa geri yükle (toggle ise dokunma)
      if (img.dataset.mgcTranslated && img.src === img.dataset.mgcOriginal){
        const b = img.parentElement?.querySelector('.mgc-translate-btn');
        if (b && b.classList.contains('translated')){
        }
        return;
      }
      // Genel restore denemesi (tryRestore içinde fallback koruması var)
      if (tryRestoreFromCache(img)){
        console.log('[MGC] Mutation restore tetiklendi', img.src.slice(0,40), 'idx', img.dataset.mgcPageIndex);
      }
    });
    obs.observe(img, { attributes:true, attributeFilter:['src'] });
    }

    STATE.observedImages.add(img);
    if (STATE.settings.autoTranslate && isInViewport(img) && !isChapterPage()) {
      // sadece title vb. için eski auto, chapter için kuyruk kullanılıyor
      setTimeout(()=>handleTranslateClick(img,btn), 700);
    }

  }

  function openInLens(src){
    window.open(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(src)}`,'_blank');
  }

  // ---------- Yakınlaştırma ----------
  function toggleZoom(img){
    const old = document.getElementById('mgc-zoom-overlay');
    if (old){ old.remove(); return; }
    const src = (img && img.src) || '';
    if (!src) return;
    const ov = document.createElement('div');
    ov.id = 'mgc-zoom-overlay';
    ov.className = 'mgc-zoom-overlay';
    const big = document.createElement('img');
    big.src = src;
    ov.appendChild(big);
    const close = (e)=>{ if (e) e.stopPropagation(); ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e)=>{ if (e.key === 'Escape'){ e.stopPropagation(); close(); } };
    ov.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    (document.body || document.documentElement).appendChild(ov);
  }

  // ---------- Cache helpers ----------
  function assignPageIndex(img){
    if (STATE.pageIndexMap.has(img)) return STATE.pageIndexMap.get(img);
    const orig = img.dataset.mgcOriginal || img.src;
    // önce zaten eşlenmiş src var mı? en güvenilir
    if (STATE.srcToIndex.has(orig)){
      const idx = NN(STATE.srcToIndex.get(orig));
      if (idx!==null){
        STATE.pageIndexMap.set(img, idx);
        img.dataset.mgcPageIndex = String(idx);
        return idx;
      }
    }
    // parent data-page kontrol (gerçek sayfa numarası varsa) — en güvenilir
    const parent = img.parentElement;
    let idx = null;
    let idxSrc = '';
    if (parent){
      const attr = parent.getAttribute('data-page') || parent.getAttribute('data-index') || parent.getAttribute('data-reader-page');
      if (attr !== null && !isNaN(parseInt(attr))){
        const p = parseInt(attr);
        let taken = false;
        for (const [k,v] of STATE.srcToIndex.entries()){ if (v===p && k!==orig) { taken=true; break; } }
        if (!taken) { idx = p; idxSrc = 'page-attr'; }
      }
    }
    // tek-sayfa modda SADECE gerçekten görünen (birincil) görsel göstergeyi kullanır
    // (DOM sırası sayfa sırası değildir; komşu preload'lar fallback alır)
    // Harita eksikken gösterge YASAK: miss "henüz kaydolmadı" demektir (yanlış resim engeli).
    // Numara zaten bir görseldeyse de YASAK (çift-tahsis engeli).
    if (idx===null && isChapterPage() && isHashMapFull()){
      try{
        const prim = getPrimaryReaderImage();
        const pageNum = getCurrentPageNumberFromDOM();
        if (prim && prim===img && pageNum!==null && pageNum>=0 && pageNum < (STATE.totalCount||500) && !isIdxClaimed(pageNum)){
          idx = pageNum; idxSrc = 'indicator';
          if (pageNum >= STATE.domNextIdx) STATE.domNextIdx = pageNum+1;
        }
      }catch(e){}
    }
    // Uzun şerit modunda DOM sırası sayfa sırasıdır; TEK-SAYFA modda komşu preload'lar
    // DOM'da karışık durur — orada pos KULLANMA (gösterge + birincillik geçerli).
    if (idx===null && isHashMapFull()){
      const readers = getReaderImages();
      if (readers.length > 1){
        let visCount = 0;
        try{
          const vw = window.innerWidth||0, vh = window.innerHeight||0;
          for (const r of readers){
            const b = r.getBoundingClientRect();
            const a = Math.max(0,Math.min(b.right,vw)-Math.max(b.left,0)) * Math.max(0,Math.min(b.bottom,vh)-Math.max(b.top,0));
            if (a > vw*vh*0.25) visCount++;
          }
        }catch(e){}
        if (visCount >= 2){
          const pos = readers.indexOf(img);
          if (pos!==-1){
            let taken=false;
            for (const [k,v] of STATE.srcToIndex.entries()){ if (v===pos && k!==orig) taken=true; }
            if (!taken) { idx = pos; idxSrc = 'dom-order'; }
          }
        }
      }
    }
    // NOT: gösterge/DOM-sırası TAHMİNİ KALDIRILDI — tek-sayfa modda komşu preload'lar
    // karışık sırada durur, yanlış indeks = yanlış sayfaya çeviri demek.
    // Kimlik SADECE: parent data-page, uzun-şerit DOM-sırası veya bayt-hash ile kurulur.
    // Bilinmeyen görsel null döner; hash bulununca identifyAndRestore tamamlar.
    if (idx===null){
      idxSrc = 'unknown';
    }
    STATE.pageIndexMap.set(img, idx);
    if (idx!==null && idx!==undefined){
      img.dataset.mgcPageIndex = String(idx);
      if (!STATE.srcToIndex.has(orig)) STATE.srcToIndex.set(orig, idx);
    } else {
      delete img.dataset.mgcPageIndex;
    }
    img.dataset.mgcIdxSrc = idxSrc || 'unknown';
    return idx;
  }
  function getPageIndex(img){
    if (STATE.pageIndexMap.has(img)) return NN(STATE.pageIndexMap.get(img));
    if (img.dataset.mgcPageIndex !== undefined){
      const p = parseInt(img.dataset.mgcPageIndex);
      return Number.isNaN(p) ? null : p;
    }
    const orig = img.dataset.mgcOriginal || img.src;
    if (STATE.srcToIndex.has(orig)) return NN(STATE.srcToIndex.get(orig));
    return null;
  }
  function tryRestoreFromCache(img){
    if (!img || !isReaderImage(img) && !img.classList.contains('mgc-target')) return false;
    const orig = img.dataset.mgcOriginal || img.src;
    // 1) direkt src cache
    if (STATE.translationCache.has(orig)){
      const dataUrl = STATE.translationCache.get(orig);
      if (img.src !== dataUrl){
        applyTranslated(img, dataUrl, true);
        return true;
      }
      return true;
    }
    // 2) index cache — SADECE güvenilir indeksle (fallback + görünmez komşuya uygulama YOK)
    const idx = getPageIndex(img);
    if (idx!==null && STATE.indexCache.has(idx)){
      const idxSrc = img.dataset.mgcIdxSrc || '';
      let isPrim = false;
      try{ isPrim = (getPrimaryReaderImage()===img); }catch(e){}
      if (idxSrc!=='fallback' || isPrim){
        const dataUrl = STATE.indexCache.get(idx);
        if (img.src !== dataUrl){
          applyTranslated(img, dataUrl, true);
          return true;
        }
        return true;
      }
    }
    // 3) eğer img zaten çevrilmişse cache'e ekle
    if (img.dataset.mgcTranslated){
      // cache'e ekle ki ileride restore edilebilsin
      if (!STATE.translationCache.has(orig)) STATE.translationCache.set(orig, img.dataset.mgcTranslated);
      if (idxInRange(idx) && !STATE.indexCache.has(idx)) STATE.indexCache.set(idx, img.dataset.mgcTranslated);
      return true;
    }
    return false;
  }
  function applyTranslated(img, dataUrl, fromCache){
    if (!img) return;
    const parent = img.parentElement;
    if (!img.dataset.mgcOriginal || img.dataset.mgcOriginal.startsWith('data:')){
      if (!img.dataset.mgcOriginal || img.dataset.mgcOriginal===dataUrl) {
        img.dataset.mgcOriginal = img.src.startsWith('data:') ? (img.dataset.mgcOriginal||'') : img.src;
        if (!img.dataset.mgcOriginal || img.dataset.mgcOriginal.startsWith('data:')){
          // fallback: srcToIndex'ten bul
          const idx = getPageIndex(img);
          // orijinali saklamak için mevcut src'yi kullanma, cache key'i kullan
          for (const [k,v] of STATE.translationCache.entries()){
            if (v===dataUrl){ img.dataset.mgcOriginal = k; break; }
          }
        }
      }
    }
    // eğer orijinal boşsa mevcut src'yi orijinal kabul etme (dataUrl değilse)
    if (!img.dataset.mgcOriginal && !img.src.startsWith('data:')){
      img.dataset.mgcOriginal = img.src;
    }
    img.dataset.mgcTranslated = dataUrl;
    // sadece src farklıysa değiştir, döngüyü engelle
    if (img.src !== dataUrl){
      img.src = dataUrl;
    }
    img.dataset.mangaUrl = dataUrl;
    let badge = parent?.querySelector('.mgc-badge');
    if (!badge && parent){
      badge = document.createElement('div');
      badge.className='mgc-badge';
      parent.appendChild(badge);
    }
    if (badge){
      badge.textContent=`G Görsel → ${STATE.settings.targetLang.toUpperCase()}`;
      badge.style.display='block';
    }
    const btn = parent?.querySelector('.mgc-translate-btn');
    if (btn){
      // fromCache ise butonu yeşil yap ama busy temizle
      btn.innerHTML=`✓ ${STATE.settings.targetLang.toUpperCase()} (Geri al)`;
      btn.classList.add('translated');
      btn.disabled=false;
      btn.dataset.busy='0';
      btn.dataset.translated='1';
      btn.title='Tıkla: Orijinal / Çeviri arasında geçiş (bütün görsel)';
      btn.dataset.mangaUrl = dataUrl;
    }
    // cache güncelle
    const origForCache = img.dataset.mgcOriginal;
    if (origForCache && !origForCache.startsWith('data:')){
      STATE.translationCache.set(origForCache, dataUrl);
    }
    const idx = getPageIndex(img);
    if (idxInRange(idx)) STATE.indexCache.set(idx, dataUrl);

    LOG(fromCache?'Cache restore':'Bütün görsel değiştirildi', (img.dataset.mgcOriginal||'').slice(0,40), '->', dataUrl.slice(0,40), 'idx', idx);
    updateHud();
  }

  // ---------- Çeviri Dispatcher ----------
  async function handleTranslateClick(img, btn){
    console.log('[MGC] handleTranslateClick tetiklendi', img.src?.slice(0,80), 'mode', STATE.settings.translateMode, 'idx', img.dataset.mgcPageIndex);
    if (btn.dataset.busy==='1') {
      try{
        const ob = btn.innerHTML;
        btn.innerHTML='⏳ kuyrukta...';
        setTimeout(()=>{ if (btn.dataset.busy==='1') btn.innerHTML=ob; }, 1200);
      }catch(_){}
      return;
    }
    // Eğer zaten çevrilmişse toggle
    if (img.dataset.mgcTranslated) {
      const isTranslated = img.src === img.dataset.mgcTranslated;
      if (isTranslated) {
        img.src = img.dataset.mgcOriginal;
        btn.innerHTML = `<span style="font-weight:700">G</span> Görsel <span style="opacity:0.8;font-size:10px">(${STATE.settings.targetLang.toUpperCase()})</span>`;
        btn.classList.remove('translated');
        const badge = img.parentElement?.querySelector('.mgc-badge');
        if (badge) badge.style.display='none';
        updateHud();
        return;
      } else if (img.dataset.mgcTranslated) {
        img.src = img.dataset.mgcTranslated;
        btn.innerHTML = `✓ ${STATE.settings.targetLang.toUpperCase()} (Geri al)`;
        btn.classList.add('translated');
        const badge = img.parentElement?.querySelector('.mgc-badge');
        if (badge) badge.style.display='block';
        updateHud();
        return;
      }
    }
    // cache'den gelmişse tekrar çevirme, direkt göster
    const orig = img.dataset.mgcOriginal || img.src;
    if (STATE.translationCache.has(orig)){
      applyTranslated(img, STATE.translationCache.get(orig), true);
      return;
    }
    const idx = getPageIndex(img);
    if (idx!==null && STATE.indexCache.has(idx)){
      applyTranslated(img, STATE.indexCache.get(idx), true);
      return;
    }

    if (STATE.settings.translateMode==='google_direct' || STATE.settings.translateMode==='yandex_ocr' || STATE.settings.translateMode==='multi_auto') {
      await handleGoogleDirectTranslate(img, btn);
    } else {
      await handleTesseractTranslate(img, btn);
    }
  }

  // ---------- Google Direct ----------
  async function handleGoogleDirectTranslate(img, btn){
    console.log('[MGC] handleGoogleDirectTranslate başlıyor', img.src?.slice(0,80), 'idx', img.dataset.mgcPageIndex);
    btn.dataset.busy='1';
    const origHTML = btn.innerHTML;
    btn.disabled=true;
    btn.innerHTML='⏳ Hazırlanıyor...';
    let progressEl = showProgress(img.parentElement || document.body, 'Görsel hazırlanıyor...');
    console.log('[MGC] progress oluşturuldu', progressEl);
    try {
      const blob = await fetchImageBlob(img.src);
      if (!blob) throw new Error('Görsel yüklenemedi (CORS). Lens ile dene.');

      updateProgress(progressEl, 'Google formatına dönüştürülüyor...');
      const dataUrl = await prepareImageForGoogle(blob);
      console.log('[MGC] dataUrl hazır', dataUrl.slice(0,40), 'len', dataUrl.length, 'mime ok');
      LOG('dataUrl hazır', dataUrl.slice(0,40), 'len', dataUrl.length);

      updateProgress(progressEl, `Google Görsel'e gönderiliyor... (${(dataUrl.length/1024).toFixed(0)} KB)`);
      btn.innerHTML='🚀 Google\'a gönderildi...';

      const mangaUrl = img.dataset.mgcOriginal || img.src;
      let pageIdx = getPageIndex(img);
      try{ const hid = await identifyBlobPage(img); if (hid!==null && hid!==undefined) pageIdx = hid; }catch(e){}
      if (pageIdx!==null && pageIdx!==undefined) STATE.srcToIndex.set(mangaUrl, pageIdx);

      // SAF ENJEKSİYON (sekme YOK): chapter izolasyonlu, loop durmaz
      const cid0 = getChapterId();
      // Dedupe: otomatik loop zaten bu sayfayı kuyruğa aldıysa tekrar çevirme, cache'i bekle
      if (cid0 && pageIdx!==null && STATE.apiQueued.has(`${cid0}:${pageIdx}`)){
        updateProgress(progressEl, 'Kuyrukta, enjekte bekleniyor...');
        for (let w=0; w<40; w++){
          await new Promise(r=>setTimeout(r, 1000));
          const ccw = STATE.chapterCaches.get(cid0);
          if (ccw && ccw.indexCache.has(pageIdx)){
            if (progressEl) progressEl.style.display='none';
            btn.disabled=false; btn.dataset.busy='0';
            await showTranslatedImageDirect(mangaUrl, ccw.indexCache.get(pageIdx), {btn, progressEl:null, origHTML, img, parent: img.parentElement, pageIdx});
            return;
          }
        }
      }
      const chKey0 = cid0 ? `${cid0}:${pageIdx}` : mangaUrl;
      STATE.pendingGoogle.set(mangaUrl, { btn, progressEl, origHTML, img, parent: img.parentElement, pageIdx, chId: cid0, mangaUrl, t0: Date.now() });
      updateProgress(progressEl, "Google MangaDex'e enjekte...");
      btn.innerHTML='⏳ Enjekte...';
      updateHud(`Enjekte ${pageIdx!==null?pageIdx+1:'?'}...`);
      try{
        const injectedRes = await translateViaInjected(dataUrl, injectTargetLang(), mangaUrl, pageIdx, cid0);
        if (injectedRes && injectedRes.dataUrl){
          console.log('[MGC] saf enjekte başarılı', injectedRes.dataUrl.length);
          if (progressEl) progressEl.style.display='none';
          btn.disabled=false; btn.dataset.busy='0';
          await showTranslatedImageDirect(mangaUrl, injectedRes.dataUrl, {btn, progressEl:null, origHTML, img, parent: img.parentElement, pageIdx});
          return;
        }
        throw new Error('boş enjekte yanıt');
      }catch(e){
        console.warn('[MGC] saf enjekte retry', e.message);
        updateProgress(progressEl, 'Enjekte kuyrukta, tekrar denenecek...');
        // Sekme YOK: kısa gecikmeyle enjeksiyona geri koy (bölüm karışmaz, unutulmaz)
        setTimeout(()=>{
          STATE.pendingGoogle.delete(mangaUrl);
          btn.innerHTML=origHTML; btn.disabled=false; btn.dataset.busy='0';
          const cc0 = cid0 && STATE.chapterCaches.get(cid0);
          // cache'e yazılmadıysa tekrar dene
          if (!(cc0 && cc0.indexCache.has(pageIdx))){
            STATE.apiQueued.delete(chKey0);
            injectOnePage({url: img.dataset.mgcOriginal || img.src, dataUrlIn: dataUrl, chId: cid0, pageIdx, chNum: 'Tekil', total: STATE.totalCount||1});
          }
          updateHud();
        }, 2500);
        // 40sn zaman aşımı: loop durmasın
        setTimeout(()=>{
          const pp = STATE.pendingGoogle.get(mangaUrl);
          if (pp){ STATE.pendingGoogle.delete(mangaUrl); btn.innerHTML=origHTML; btn.disabled=false; btn.dataset.busy='0'; updateHud(); }
        }, 40000);
        return;
      }

    } catch(e){
      console.error('[MGC] google_direct hata', e, e.stack);
      if (progressEl) {
        progressEl.style.background='rgba(180,0,0,0.85)';
        progressEl.innerHTML=`❌ Hata: ${e.message}<br><small>Tesseract modunu dene: Toolbar'dan değiştir<br><button style="margin-top:6px;padding:4px 8px;border-radius:4px;border:none;cursor:pointer" onclick="this.parentElement.remove()">Kapat</button></small>`;
        setTimeout(()=>progressEl?.remove(), 8000);
      }
      btn.innerHTML=origHTML; btn.disabled=false; btn.dataset.busy='0';
      STATE.pendingGoogle.delete(img.dataset.mgcOriginal || img.src);
      updateHud();
      // paralel aktif sayacı launchTranslation finally'sinde düşecek
    }
  }

  function handleShowTranslatedImage(msg){
    const { mangaUrl, dataUrl } = msg;
    LOG('showTranslatedImage', mangaUrl, dataUrl?.length);
    let pending = STATE.pendingGoogle.get(mangaUrl);
    // NOT: bulanık includes() eşleşmesi KALDIRILDI — 'api:cid:1', 'api:cid:14'ü önekten
    // yutuyordu; 10+ sayfalı (vol-sonu) chapter'larda yanlış görsele basıyordu. Birebir anahtar şart.
    if (!pending) {
      const imgs = document.querySelectorAll('img.mgc-target');
      for (const im of imgs){
        if (im.src===mangaUrl || im.dataset.mgcOriginal===mangaUrl) {
          const parent = im.parentElement;
          pending = { btn: parent?.querySelector('.mgc-translate-btn'), progressEl: parent?.querySelector('.mgc-progress'), img: im, origHTML: parent?.querySelector('.mgc-translate-btn')?.innerHTML, parent };
          break;
        }
      }
    }
    if (!pending) {
      console.warn('[MGC] showTranslatedImage pending bulunamadı, index ile eşleştirmeyi dene', mangaUrl);
      // srcToIndex üzerinden gerçek pageIdx'i bulmaya çalış
      let targetIdx = null;
      if (STATE.srcToIndex.has(mangaUrl)) targetIdx = STATE.srcToIndex.get(mangaUrl);
      else {
        // mangaUrl blob'u eski olabilir, srcToIndex'te yoksa pending içindeki pageIdx'lerden bul
        for (const [url,p] of STATE.pendingGoogle.entries()){
          if (p.pageIdx!=null && url===mangaUrl) { targetIdx = p.pageIdx; break; }
        }
      }
      if (targetIdx!==null){
        const candidates = getReaderImages();
        for (const c of candidates){
          if (getPageIndex(c)===targetIdx){
            showTranslatedImageDirect(c.dataset.mgcOriginal || c.src, dataUrl, {img:c, btn:c.parentElement?.querySelector('.mgc-translate-btn'), progressEl:c.parentElement?.querySelector('.mgc-progress'), parent:c.parentElement, pageIdx: targetIdx});
            return;
          }
        }
      }
      // NOT: ilk-bulunan-aday fallback KALDIRILDI — chapter karıştırmanın başlıca kaynağıydı.
      {
        const mm = String(mangaUrl||'').match(/^api:([^:]+):(\d+)$/);
        if (mm){
          const oc = mm[1], oi = parseInt(mm[2],10);
          if (!STATE.chapterCaches.has(oc)) STATE.chapterCaches.set(oc, {translationCache:new Map(), indexCache:new Map(), srcToIndex:new Map(), totalCount:0, domNextIdx:0, pageUrls:null, hashToIdx:new Map()});
          setPageResult(oc, oi, mangaUrl, dataUrl);
          STATE.apiQueued.delete(`${oc}:${oi}`);
          console.log('[MGC] eşleşmeyen sonuç ilgili chapter cache-e yazıldı', oc, oi);
          if (oc === getChapterId()) sweepRestore();
        } else {
          let rescued = false;
          try{
            const live = getReaderImages().find(im=>im.src===mangaUrl || im.dataset.mgcOriginal===mangaUrl);
            if (live){
              STATE.translationCache.set(mangaUrl, dataUrl);
              blobAlive(mangaUrl);
              showTranslatedImageDirect(mangaUrl, dataUrl, {img:live, btn:live.parentElement?.querySelector('.mgc-translate-btn'), progressEl:live.parentElement?.querySelector('.mgc-progress'), parent:live.parentElement, pageIdx:getPageIndex(live)});
              rescued = true;
            }
          }catch(_){}
          if (!rescued) console.warn('[MGC] showTranslatedImage eşleşmedi, atıldı', String(mangaUrl||'').slice(0,60));
        }
      }
      return;
    }
    showTranslatedImageDirect(mangaUrl, dataUrl, pending);
  }

  function handleGoogleError(msg){
    const { mangaUrl, error } = msg;
    let pending = STATE.pendingGoogle.get(mangaUrl);
    if (!pending){
      for (const [url,p] of STATE.pendingGoogle.entries()){
        if (url===mangaUrl) { pending=p; break; }
      }
    }
    if (!pending) return;
    const { btn, progressEl, origHTML } = pending;
    if (progressEl){
      progressEl.style.background='rgba(180,0,0,0.85)';
      progressEl.textContent=`❌ Google hata: ${error}`;
      setTimeout(()=>progressEl.remove(), 7000);
    }
    if (btn){ btn.innerHTML=origHTML; btn.disabled=false; btn.dataset.busy='0'; }
    const pm = STATE.pendingGoogle.get(mangaUrl);
    STATE.pendingGoogle.delete(mangaUrl);
    // Hata alan işi enjeksiyon loop'una geri ver (kayıp yok, çift iş yok: anahtar silinip yeniden eklenir)
    try{
      const mm = String(mangaUrl||'').match(/^api:([^:]+):(\d+)$/);
      if (mm && pm && pm.apiUrl){
        const ek = `${mm[1]}:${mm[2]}`;
        STATE.apiQueued.delete(ek);
        const ech = mm[1], epi = parseInt(mm[2],10);
        setTimeout(async ()=>{
          let furl = pm.apiUrl;
          if (/404|indirilemedi/i.test(String(error||''))){
            const fr = await refreshChapterUrls(ech, epi);
            if (fr) furl = fr;
            else await new Promise(r=>setTimeout(r, 30000)); // bilet alınamadı: dövme
          }
          injectOnePage({url: furl, dataUrlIn:null, chId: ech, pageIdx: epi, chNum:'Tekrar', total: STATE.totalCount||1});
        }, 4000);
      } else if (mm){
        STATE.apiQueued.delete(`${mm[1]}:${mm[2]}`);
      }
    }catch(e){}
    updateHud();
    setTimeout(()=> processQueueParallel(), 500);
  }

  async function showTranslatedImageDirect(mangaUrl, dataUrl, pendingOpt){
    let pending = pendingOpt || STATE.pendingGoogle.get(mangaUrl);
    // Chapter kapısı (TEK NOKTA): başka chapter'ın işi mevcut DOM'a ASLA basılmaz.
    // Eskiden sadece !img dalındaydı; pending.img/DOM eşleşmesinde atlanıyor, çakışan
    // idx (her chapter'da 0,1,2...) yanlış chapter'a basılıyordu.
    {
      const jobChId = (pending && pending.chId) || (String(mangaUrl||'').match(/^api:([^:]+):/)||[])[1] || null;
      if (jobChId && jobChId !== getChapterId()){
        const oi2 = (pending && pending.pageIdx!==null && pending.pageIdx!==undefined) ? pending.pageIdx : null;
        if (!STATE.chapterCaches.has(jobChId)) STATE.chapterCaches.set(jobChId, {translationCache:new Map(), indexCache:new Map(), srcToIndex:new Map(), totalCount:0, domNextIdx:0, pageUrls:null, hashToIdx:new Map()});
        if (oi2!==null) setPageResult(jobChId, oi2, mangaUrl, dataUrl);
        else STATE.chapterCaches.get(jobChId).translationCache.set(mangaUrl, dataUrl);
        if (pending && pending.progressEl) pending.progressEl.style.display='none';
        STATE.pendingGoogle.delete(mangaUrl);
        if (oi2!==null) STATE.apiQueued.delete(`${jobChId}:${oi2}`);
        console.log('[MGC] eski chapter sonucu cache-e yazıldı (direct), DOMa dokunulmadı', jobChId, oi2);
        return;
      }
    }
    let img = pending?.img;
    let btn = pending?.btn;
    let progressEl = pending?.progressEl;
    let parent = pending?.parent || img?.parentElement;
    if (!img) {
      img = document.querySelector(`img[data-mgc-original="${mangaUrl}"]`) || document.querySelector(`img[src="${mangaUrl}"]`);
      if (!img) {
        const imgs = document.querySelectorAll('img.mgc-target');
        for (const im of imgs) if (im.dataset.mgcOriginal===mangaUrl) { img=im; break; }
      }
      if (!img) {
        // index ile bulmayı dene
        if (pending && pending.pageIdx!=null){
          const candidates = getReaderImages();
          for (const c of candidates) if (getPageIndex(c)===pending.pageIdx) { img=c; break; }
        }
      }
      if (!img) {
        // API modu: img henüz DOM'da değil ama çeviri hazır, sadece cache'e al
        if (pending && pending.pageIdx!=null){
          const idx = pending.pageIdx;
          const wch = (pending && pending.chId) || getChapterId();
          if (wch && wch !== getChapterId()){
            if (!STATE.chapterCaches.has(wch)) STATE.chapterCaches.set(wch, {translationCache:new Map(), indexCache:new Map(), srcToIndex:new Map(), totalCount:0, domNextIdx:0, pageUrls:null, hashToIdx:new Map()});
            setPageResult(wch, idx, mangaUrl, dataUrl);
            STATE.apiQueued.delete(`${wch}:${idx}`);
          } else {
            setPageResult(getChapterId(), idx, mangaUrl, dataUrl);
            STATE.apiQueued.delete(`${getChapterId()}:${idx}`);
            STATE.apiQueued.delete(idx);
          }
          if (pending.progressEl) {
            // global progress olduğu için sadece text güncelle, hepsini silme
            pending.progressEl.textContent = `Sayfa ${idx+1} çevrildi`;
            setTimeout(()=> { if(pending.progressEl) pending.progressEl.style.display='none'; }, 2000);
          } else if (progressEl) progressEl.style.display='none';
          STATE.pendingGoogle.delete(mangaUrl);
          updateHud();
          getReaderImages().forEach(im=>{
            if (getPageIndex(im)===idx) tryRestoreFromCache(im);
          });
          sweepRestore();
          setTimeout(()=> processQueueParallel(), 300);
          LOG('API cache kaydedildi (img yok)', mangaUrl.slice(0,40), 'idx', idx);
          return;
        }
        return;
      }
      parent = img.parentElement;
      btn = parent?.querySelector('.mgc-translate-btn');
      progressEl = parent?.querySelector('.mgc-progress');
    }
    if (!img) return;
    // Uyumsuzluk bekçisi: sonucun sayfası/chapter'ı ile hedefin sayfası/chapter'ı farklıysa basma.
    // (Geri dönüştürülmüş eleman + çakışan idx: her chapter'da 0,1,2... var.)
    try{
      let wantIdx = NN(pending && pending.pageIdx);
      if (wantIdx===null){
        const mmw = String(mangaUrl||'').match(/^api:([^:]+):(\d+)$/);
        if (mmw) wantIdx = parseInt(mmw[2],10);
      }
      const gotIdx = NN(getPageIndex(img));
      const wantCh = (pending && pending.chId) || (String(mangaUrl||'').match(/^api:([^:]+):/)||[])[1] || null;
      const gotCh = (img && img.dataset && img.dataset.mgcChId) || null;
      if (wantCh && gotCh && wantCh!==gotCh){
        console.warn('[MGC] uyumsuz chapter, önbelleğe yazıldı', String(mangaUrl||'').slice(0,40), 'want', String(wantCh).slice(0,8), 'got', String(gotCh).slice(0,8));
        const mm = String(mangaUrl||'').match(/^api:([^:]+):(\d+)$/);
        if (mm) setPageResult(mm[1], parseInt(mm[2],10), mangaUrl, dataUrl);
        else STATE.translationCache.set(mangaUrl, dataUrl);
        STATE.pendingGoogle.delete(mangaUrl);
        updateHud();
        sweepRestore();
        return;
      }
      if (wantIdx!==null && gotIdx!==null && wantIdx!==gotIdx){
        console.warn('[MGC] uyumsuz hedef, önbelleğe yazıldı', String(mangaUrl||'').slice(0,40), 'want', wantIdx, 'got', gotIdx);
        const mm = String(mangaUrl||'').match(/^api:([^:]+):(\d+)$/);
        if (mm) setPageResult(mm[1], parseInt(mm[2],10), mangaUrl, dataUrl);
        else STATE.translationCache.set(mangaUrl, dataUrl);
        STATE.pendingGoogle.delete(mangaUrl);
        updateHud();
        sweepRestore();
        return;
      }
    }catch(_){}
    parent = parent || img.parentElement;
    if (progressEl) progressEl.remove();

    applyTranslated(img, dataUrl, false);
    // pending temizle
    STATE.pendingGoogle.delete(mangaUrl);
    sweepRestore();
    LOG('Bütün görsel değiştirildi', mangaUrl.slice(0,60), '->', dataUrl.slice(0,40), 'idx', img.dataset.mgcPageIndex);
    updateHud();
    // paralel kuyruk bir sonraki için - aktif sayaç launch finally'sinde düşecek
    setTimeout(()=> processQueueParallel(), 300);
  }

  async function prepareImageForGoogle(blob){
    const valid = ['image/jpeg','image/png','image/webp'];
    let outBlob = blob;
    const origType = blob.type || 'image/jpeg';
    if (!valid.includes(origType)) {
      outBlob = await blobToJpeg(blob);
    }
    if (outBlob.size > 7.5*1024*1024) {
      outBlob = await compressImageBlob(outBlob, 0.82, 1800);
    }
    const dims = await getImageDimensions(outBlob);
    if (dims.width > 2200 || dims.height > 3000) {
      outBlob = await compressImageBlob(outBlob, 0.88, 2000);
    }
    return await blobToDataUrl(outBlob);
  }

  function blobToDataUrl(blob){
    return new Promise((resolve,reject)=>{
      const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(blob);
    });
  }

  function blobToJpeg(blob){
    return new Promise((resolve)=>{
      const url=URL.createObjectURL(blob);
      const img=new Image();
      img.onload=()=>{
        const canvas=document.createElement('canvas');
        canvas.width=img.naturalWidth; canvas.height=img.naturalHeight;
        const ctx=canvas.getContext('2d');
        ctx.drawImage(img,0,0);
        URL.revokeObjectURL(url);
        canvas.toBlob(b=>resolve(b||blob), 'image/jpeg', 0.92);
      };
      img.onerror=()=>{ URL.revokeObjectURL(url); resolve(blob); };
      img.src=url;
    });
  }

  function compressImageBlob(blob, quality, maxWidth){
    return new Promise((resolve)=>{
      const url=URL.createObjectURL(blob);
      const img=new Image();
      img.onload=()=>{
        let w=img.naturalWidth, h=img.naturalHeight;
        if (w>maxWidth){
          h=Math.round(h*maxWidth/w);
          w=maxWidth;
        }
        const canvas=document.createElement('canvas');
        canvas.width=w; canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        URL.revokeObjectURL(url);
        const mime = blob.type==='image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob(b=>resolve(b||blob), mime, quality);
      };
      img.onerror=()=>{ URL.revokeObjectURL(url); resolve(blob); };
      img.src=url;
    });
  }

  function getImageDimensions(blob){
    return new Promise(resolve=>{
      const url=URL.createObjectURL(blob);
      const img=new Image();
      img.onload=()=>{ const d={width:img.naturalWidth,height:img.naturalHeight}; URL.revokeObjectURL(url); resolve(d); };
      img.onerror=()=>{ URL.revokeObjectURL(url); resolve({width:0,height:0}); };
      img.src=url;
    });
  }

  let sweepTimer = null;
  // Tamamlanmış chapter'da yavaş nabız (20sn): geç render edilen takılı sayfalar için
  function stopPostBeat(){ try{ if (STATE.postBeat){ clearInterval(STATE.postBeat); STATE.postBeat = null; } }catch(_){} }
  function startPostBeat(cid){
    stopPostBeat();
    STATE.postBeat = setInterval(()=>{
      try{
        if (!STATE.userStarted || getChapterId()!==cid || !isChapterPage()){ stopPostBeat(); return; }
        sweepRestore();
      }catch(e){ stopPostBeat(); }
    }, 20000);
  }
  function sweepRestore(){
    // Push ile önbelleğe yazılan ama DOM'a uygulanmamış sayfaları tara (ölü sonuç engeli)
    if (sweepTimer) return;
    const sweepCid = getChapterId();
    sweepTimer = setTimeout(()=>{
      sweepTimer = null;
      try{
        if (!isChapterPage()) return;
        if (getChapterId() !== sweepCid) return; // arada bölüm değişti: bayat süpürme yok
        for (const im of getReaderImages()){
          try{
            if (im.dataset.mgcTranslated && im.src === im.dataset.mgcTranslated) continue;
            if (!tryRestoreFromCache(im)) identifyAndRestore(im);
          }catch(_){}
        }
      }catch(_){}
    }, 600);
  }
  // Sayfa JS hataları da köprüye aksın (tam konsol okunamaz, ama patlamalar görünür)
  try{
    window.addEventListener('error', e=>{ try{ mgcRelay(['[MGC-PAGE-ERR]', String(e.message||e), String(e.filename||'').slice(-60)]); }catch(_){} });
    window.addEventListener('unhandledrejection', e=>{ try{ mgcRelay(['[MGC-PAGE-REJ]', String((e.reason&&e.reason.message)||e.reason)]); }catch(_){} });
  }catch(_){}
  function LOG(...a){ try{ console.log('[MGC]', ...a);}catch(e){} }
  // Canlı log köprüsü: [MGC*] konsol satırları background üzerinden yereldeki sunucuya (tek yön, sessiz)
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

  // ---------- Tesseract ----------
  async function handleTesseractTranslate(img,btn){
    btn.dataset.busy='1';
    const origHTML=btn.innerHTML;
    btn.disabled=true;
    btn.innerHTML='⏳ OCR hazırlanıyor...';
    let progressEl=showProgress(img.parentElement || document.body,'Görsel yükleniyor...');
    try{
      const blob=await fetchImageBlob(img.src);
      if(!blob) throw new Error('Görsel yüklenemedi');
      // OCR background'da: sayfa CSP'si WASM'ı engeller, eklenti CSP'si izinlidir
      updateProgress(progressEl,`Metin algılanıyor (arka plan)... [${STATE.settings.ocrLang}]`);
      // İlk çalışta dil verisi iner (yavaş olabilir); yanıt gelmezse 7dk sonra vazgeç
      const ocrRes=await Promise.race([
        browser.runtime.sendMessage({action:'tesseractOCR', dataUrl: await blobToDataUrl(blob), lang: STATE.settings.ocrLang}),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('OCR zaman aşımı (7dk) — ilk çalışta dil verisi iniyor olabilir, tekrar dene')), 420000)),
      ]);
      if(!ocrRes || ocrRes.error) throw new Error(ocrRes?.error||'OCR yanıtı boş');
      const blocks=ocrRes.blocks||[];
      console.log('[MGC] tesseract blok', blocks.length, JSON.stringify(blocks.slice(0,4).map(b=>({t:b.text?.slice(0,60), c:Math.round(b.conf||0)}))));
      if(!blocks.length) throw new Error('Metin bulunamadı. OCR dili yanlış olabilir.');
      const isSalad=t=>{const s=String(t||'');if(s.length<2)return true;const g=(s.match(/[A-Za-z0-9\u00c0-\u024f\u1e00-\u1eff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g)||[]).length;return g/s.length<0.5;};
      const filtered=blocks.filter(b=>b.text.trim().length>=2 && b.conf>30 && !isSalad(b.text));
      if(!filtered.length) throw new Error('Okunabilir metin yok (güven <30)');
      updateProgress(progressEl, `${filtered.length} metin çevriliyor...`);
      const translations=[];
      for(let i=0;i<filtered.length;i++){
        const b=filtered[i];
        updateProgress(progressEl, `Çevriliyor ${i+1}/${filtered.length}`);
        try{
          const res=await Promise.race([
            browser.runtime.sendMessage({action:'translateText', text:b.text, targetLang:STATE.settings.targetLang, sourceLang:STATE.settings.sourceLang}),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error('metin timeout')), 25000)),
          ]);
          translations.push(res.translated||b.text);
        }catch(e){ translations.push(b.text); }
      }
      console.log('[MGC] tesseract çeviriler', JSON.stringify(translations.slice(0,4).map(t=>t?.slice(0,60))));
      updateProgress(progressEl,'Görsel oluşturuluyor...');
      const canvas=await drawTranslatedCanvas(img,blob,filtered,translations);
      progressEl.remove();
      progressEl=null;
      canvas.className='mgc-canvas-overlay';
      canvas.dataset.done='1';
      canvas.style.width=img.width?img.width+'px':'100%';
      canvas.style.height='auto';
      const parentT = img.parentElement;
      if (parentT) {
        canvas.style.position='absolute';
        canvas.style.top='0';
        canvas.style.left='0';
        canvas.style.width='100%';
        canvas.style.height='auto';
        parentT.style.position = getComputedStyle(parentT).position==='static' ? 'relative' : parentT.style.position;
        parentT.appendChild(canvas);
      } else {
        img.parentNode.insertBefore(canvas, img.nextSibling);
      }
      const badge=document.createElement('div');
      badge.className='mgc-badge';
      badge.textContent=`G OCR → ${STATE.settings.targetLang.toUpperCase()}`;
      (img.parentElement || document.body).appendChild(badge);
      const toggle=document.createElement('button');
      toggle.className='mgc-toggle-original';
      toggle.textContent='Orijinali Göster';
      toggle.addEventListener('click',()=>{
        const hidden=canvas.style.display==='none';
        canvas.style.display=hidden?'block':'none';
        badge.style.display=hidden?'block':'none';
        toggle.textContent=hidden?'Orijinali Göster':'Çeviriyi Göster';
      });
      (img.parentElement || document.body).appendChild(toggle);
      btn.innerHTML=`✓ ${STATE.settings.targetLang.toUpperCase()}`;
      btn.classList.add('translated');
      btn.disabled=false;
      btn.dataset.busy='0';
      updateHud();
      setTimeout(()=> processQueueParallel(), 500);
    }catch(e){
      console.error('[MGC] tesseract hata',e);
      if(progressEl){
        progressEl.style.background='rgba(180,0,0,0.85)';
        progressEl.innerHTML=`❌ Hata: ${e.message}<br><button style="margin-top:6px;padding:4px 8px;border-radius:4px;border:none;cursor:pointer" onclick="this.parentElement.remove()">Kapat</button>`;
        setTimeout(()=>progressEl?.remove(),7000);
      }
      btn.innerHTML=origHTML; btn.disabled=false; btn.dataset.busy='0';
      updateHud();
      setTimeout(()=> processQueueParallel(), 500);
    }
  }

  let globalProgressEl = null;
  function showProgress(parent, text){
    // Tek global progress kullan (ort-alt), çok sayıda üst üste binmesin
    if (globalProgressEl && document.body.contains(globalProgressEl)){
      globalProgressEl.textContent = text;
      globalProgressEl.style.display = 'block';
      return globalProgressEl;
    }
    const el=document.createElement('div');
    el.className='mgc-progress';
    el.textContent=text;
    document.body.appendChild(el);
    globalProgressEl = el;
    return el;
  }
  function hideGlobalProgress(){
    if (globalProgressEl) {
      globalProgressEl.style.display = 'none';
    }
  }
  function updateProgress(el,text){ if(el) el.textContent=text; }

  async function fetchImageBlob(src){
    const isBlob = (src||'').startsWith('blob:');
    try{
      const ctl = new AbortController();
      const timer = setTimeout(()=>ctl.abort(), 45000);
      let r;
      try{ r = await fetch(src,{mode:'cors',credentials:'omit',signal:ctl.signal}); }
      finally{ clearTimeout(timer); }
      if(r.ok) return await r.blob();
      throw new Error(`status ${r.status}`);
    }catch(e){
      // blob: adresleri sayfaya özeldir (arka plan okuyamaz); tek şans canvas. O da olmazsa ÖLÜ.
      if (isBlob){
        try{ return await imageToBlobViaCanvas(src); }catch(e3){}
        throw new Error('BLOB_OLDU:'+String(e&&e.message||e).slice(0,60));
      }
      try{
        const res=await browser.runtime.sendMessage({action:'fetchImageAsDataUrl', url:src});
        if(res?.dataUrl){
          const blob=await (await fetch(res.dataUrl)).blob();
          return blob;
        }
      }catch(e2){}
      try{ return await imageToBlobViaCanvas(src); }catch(e3){ return null; }
    }
  }
  // Sayfa kesicisi: aynı iş üst üste ölürse bırak (ölü sunucu havuzu tıkamasın)
  function pageDead(key){
    try{
      STATE.pageFails = STATE.pageFails || {};
      STATE.pageFails[key] = (STATE.pageFails[key]||0)+1;
      return STATE.pageFails[key] >= 4;
    }catch(_){ return false; }
  }
  function pageAlive(key){
    try{ if (STATE.pageFails) delete STATE.pageFails[key]; }catch(_){}
  }
  // Ölü blob kesici: aynı URL üst üste ölürse retry fırtınası yok
  function blobDead(url){
    try{
      STATE.blobFails = STATE.blobFails || {};
      const k = String(url||'');
      STATE.blobFails[k] = (STATE.blobFails[k]||0)+1;
      return STATE.blobFails[k] >= 2;
    }catch(_){ return false; }
  }
  function blobAlive(url){
    try{ if (STATE.blobFails) delete STATE.blobFails[String(url||'')]; }catch(_){}
  }
  function imageToBlobViaCanvas(src){
    return new Promise((resolve,reject)=>{
      const img=new Image(); img.crossOrigin='anonymous';
      img.onload=()=>{
        try{
          const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
          c.getContext('2d').drawImage(img,0,0);
          c.toBlob(b=>b?resolve(b):reject(new Error('toBlob null')), 'image/png');
        }catch(e){ reject(e); }
      };
      img.onerror=()=>reject(new Error('image load failed'));
      img.src=src;
    });
  }

  async function drawTranslatedCanvas(originalImg,blob,blocks,translations){
    const img=await blobToImage(blob);
    const canvas=document.createElement('canvas');
    canvas.width=img.naturalWidth; canvas.height=img.naturalHeight;
    const ctx=canvas.getContext('2d');
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    blocks.forEach((block,i)=>{
      const trans=translations[i]||block.text;
      const {x0,y0,x1,y1}=normalizeBbox(block.bbox,canvas.width,canvas.height,img);
      const w=x1-x0, h=y1-y0; if(w<=0||h<=0) return;
      const pad=Math.max(2,Math.round(h*0.08));
      const rx=Math.max(0,x0-pad), ry=Math.max(0,y0-pad);
      const rw=Math.min(canvas.width-rx,w+pad*2), rh=Math.min(canvas.height-ry,h+pad*2);
      ctx.fillStyle='rgba(255,255,255,0.94)';
      roundRect(ctx,rx,ry,rw,rh,Math.max(3,h*0.12)); ctx.fill();
      ctx.strokeStyle='rgba(0,0,0,0.12)'; ctx.lineWidth=1; ctx.stroke();
      ctx.fillStyle='#202124';
      const fontSize=fitFontSize(ctx,trans,rw-pad,rh-pad,h);
      ctx.font=`700 ${fontSize}px -apple-system, sans-serif`;
      ctx.textBaseline='middle';
      const lines=wrapText(ctx,trans,rw-pad*1.2);
      const lineH=fontSize*1.18; const totalH=lines.length*lineH;
      let startY=ry+rh/2-totalH/2+lineH/2;
      if(totalH>rh-pad){
        const scale=(rh-pad)/totalH;
        const newSize=Math.max(8,Math.floor(fontSize*scale*0.92));
        ctx.font=`700 ${newSize}px -apple-system, sans-serif`;
        const newLines=wrapText(ctx,trans,rw-pad*1.2);
        const newLineH=newSize*1.18; const newTotalH=newLines.length*newLineH;
        startY=ry+rh/2-newTotalH/2+newLineH/2;
        lines.length=0; newLines.forEach(l=>lines.push(l));
        lines.forEach((line,idx)=>{
          const y=startY+idx*newLineH;
          const tw=ctx.measureText(line).width;
          const x=rx+rw/2-tw/2;
          ctx.fillText(line,x,y);
        });
      }else{
        lines.forEach((line,idx)=>{
          const y=startY+idx*lineH;
          const tw=ctx.measureText(line).width;
          const x=rx+rw/2-tw/2;
          ctx.fillText(line,x,y);
        });
      }
    });
    return canvas;
  }
  function normalizeBbox(bbox,cw,ch,img){
    let {x0,y0,x1,y1}=bbox;
    if(x0==null||y0==null) return {x0:0,y0:0,x1:cw,y1:ch*0.1};
    x0=Math.max(0,Math.min(cw,x0)); y0=Math.max(0,Math.min(ch,y0));
    x1=Math.max(0,Math.min(cw,x1)); y1=Math.max(0,Math.min(ch,y1));
    if(x1<=x0) x1=x0+80; if(y1<=y0) y1=y0+18;
    return {x0,y0,x1,y1};
  }
  function blobToImage(blob){
    return new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(blob);
      const img=new Image();
      img.onload=()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror=reject; img.src=url;
    });
  }
  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  function fitFontSize(ctx,text,maxW,maxH,boxH){
    let size=Math.max(10,Math.min(Math.floor(boxH*0.62),28));
    ctx.font=`700 ${size}px sans-serif`;
    let w=ctx.measureText(text).width;
    while(w>maxW && size>8){ size-=1; ctx.font=`700 ${size}px sans-serif`; w=ctx.measureText(text).width; }
    while(size*1.2>maxH && size>8){ size-=1; ctx.font=`700 ${size}px sans-serif`; }
    return size;
  }
  function wrapText(ctx,text,maxW){
    const words=text.split(' ');
    const lines=[]; let cur='';
    for(const w of words){
      const test=cur?cur+' '+w:w;
      if(ctx.measureText(test).width>maxW && cur){ lines.push(cur); cur=w; } else cur=test;
    }
    if(cur) lines.push(cur);
    const final=[];
    for(const l of lines){
      if(ctx.measureText(l).width<=maxW) final.push(l);
      else{
        let chunk='';
        for(const ch of l){
          if(ctx.measureText(chunk+ch).width>maxW){ final.push(chunk); chunk=ch; } else chunk+=ch;
        }
        if(chunk) final.push(chunk);
      }
    }
    return final.length?final:[text];
  }

  // ---------- Kuyruk ve toplu (paralel sıralı) ----------
  const PARALLEL_LIMIT = 3;
  function queueReaderImages(){
    if (!isChapterPage()) return;
    return; // chapter sayfalarında TEK YOL: API enjeksiyon loop (çift çeviri + havuz tıkanması engeli). Restore işini scanAndAttach yapar.
    const imgs = getReaderImages();
    if (!imgs.length) {
      updateHud('yükleniyor...');
      return;
    }
    if (imgs.length > STATE.totalCount) STATE.totalCount = imgs.length;
    imgs.forEach(img=> {
      assignPageIndex(img);
      tryRestoreFromCache(img);
    });
    updateHud();
    const toQueue = imgs.filter(img=>{
      const idx = getPageIndex(img);
      if (idx!==null && STATE.apiQueued.has(idx)) return false;
      if (img.dataset.mgcTranslated) return false;
      if (STATE.queue.includes(img)) return false;
      if (img.dataset.mgcBusy==='1') return false;
      const orig = img.dataset.mgcOriginal || img.src;
      if (STATE.translationCache.has(orig)) return false;
      if (idx!==null && STATE.indexCache.has(idx)) return false;
      for (const p of STATE.pendingGoogle.values()){
        if (p.img===img) return false;
        if (p.pageIdx!=null && p.pageIdx===idx) return false;
      }
      for (const q of STATE.queue) if (q===img) return false;
      return true;
    });
    toQueue.sort((a,b)=> (getPageIndex(a)??0) - (getPageIndex(b)??0));
    if (toQueue.length){
      console.log(`[MGC] Kuyruğa ${toQueue.length} sayfa eklendi (paralel)`, toQueue.map(i=> getPageIndex(i)));
      STATE.queue.push(...toQueue);
      STATE.totalCount = Math.max(STATE.totalCount, STATE.translationCache.size + STATE.queue.length + STATE.activeCount);
      updateHud();
      processQueueParallel();
    } else {
      updateHud();
      if (STATE.queue.length===0 && STATE.activeCount===0) {
        console.log('[MGC] Çevrilecek yeni sayfa yok');
      }
    }
  }

  function processQueueParallel(){
    // paralel limit kadar başlat, sıralı düzende
    while (STATE.activeCount < PARALLEL_LIMIT && STATE.queue.length){
      const img = STATE.queue.shift();
      if (!document.body.contains(img)){
        const idx = getPageIndex(img);
        const replacement = getReaderImages().find(nimg=> getPageIndex(nimg)===idx && !nimg.dataset.mgcTranslated);
        if (replacement && !STATE.queue.includes(replacement) && !isInActive(replacement)){
          // başa ekle ve devam
          STATE.queue.unshift(replacement);
        }
        continue;
      }
      if (tryRestoreFromCache(img)){
        continue;
      }
      const btn = img.parentElement?.querySelector('.mgc-translate-btn');
      if (!btn){
        console.warn('[MGC] buton bulunamadı idx', getPageIndex(img));
        continue;
      }
      if (btn.dataset.busy==='1'){
        // busy ise sona at
        STATE.queue.push(img);
        // döngüyü kır, sonra tekrar dene
        break;
      }
      STATE.activeCount++;
      STATE.processing = true;
      const idx = getPageIndex(img);
      updateHud(`Çevriliyor ${STATE.activeCount} paralel - sıradaki ${ (idx!==null? idx+1 : '?')}/${STATE.totalCount}...`);
      launchTranslation(img, btn).finally(()=>{
        STATE.activeCount = Math.max(0, STATE.activeCount-1);
        STATE.processing = STATE.activeCount>0;
        updateHud();
        setTimeout(()=> processQueueParallel(), 200);
        if (STATE.queue.length===0 && STATE.activeCount===0){
          console.log('[MGC] Tüm kuyruk bitti (paralel)');
          updateHud();
        }
      });
    }
    STATE.processing = STATE.activeCount>0;
    if (STATE.queue.length===0 && STATE.activeCount===0){
      updateHud();
    }
  }
  function isInActive(img){
    for (const p of STATE.pendingGoogle.values()) if (p.img===img) return true;
    return false;
  }
  async function launchTranslation(img, btn){
    try{
      await handleTranslateClick(img, btn);
      if (STATE.settings.translateMode==='google_direct'){
        await waitForTranslation(img, 45000);
      }
    }catch(e){
      console.warn('[MGC] launch hata idx', getPageIndex(img), e);
    }
  }
  // eski sequential wrapper (uyumluluk)
  async function processQueue(){
    return processQueueParallel();
  }

  function waitForTranslation(img, timeout){
    return new Promise((resolve)=>{
      const orig = img.dataset.mgcOriginal || img.src;
      const idx = getPageIndex(img);
      const start = Date.now();
      const iv = setInterval(()=>{
        const done = (img.dataset.mgcTranslated && img.src===img.dataset.mgcTranslated)
                  || STATE.translationCache.has(orig)
                  || (idx!==null && STATE.indexCache.has(idx))
                  || !STATE.pendingGoogle.has(orig);
        // pending bittiyse veya data geldi ise
        if (img.dataset.mgcTranslated || STATE.translationCache.has(orig) || (idx!==null && STATE.indexCache.has(idx))){
          clearInterval(iv);
          resolve();
        } else if (Date.now()-start > timeout){
          clearInterval(iv);
          resolve();
        }
      }, 400);
    });
  }

  function translateAllVisible(){
    if (isChapterPage()){
      // Başla kapısını aç + TEK YOL enjeksiyon loop (DOM kuyruğu kapalı, çift çeviri yok)
      setStarted(true);
      updateHud('başlatıldı');
      return;
    }
    // chapter değilse eski davranış (tüm sayfa)
    const imgs=document.querySelectorAll('img.mgc-target');
    let i=0;
    const next=()=>{
      if(i>=imgs.length) return;
      const img=imgs[i++];
      const parent = img.parentElement;
      const btn=parent?.querySelector('.mgc-translate-btn') || document.querySelector(`button[data-manga-url="${img.src}"]`);
      const hasOverlay = parent?.querySelector('canvas.mgc-canvas-overlay') || img.dataset.mgcTranslated;
      if(btn && !hasOverlay){
        handleTranslateClick(img,btn);
        setTimeout(next, STATE.settings.translateMode==='google_direct'? 3500 : 1800);
      } else next();
    };
    next();
  }
  function clearAllOverlays(){
    document.querySelectorAll('#mgc-zoom-overlay').forEach(el=>el.remove());
    document.querySelectorAll('canvas.mgc-canvas-overlay, .mgc-badge, .mgc-toggle-original').forEach(el=>el.remove());
    document.querySelectorAll('img.mgc-target').forEach(img=>{
      if (img.dataset.mgcOriginal && img.dataset.mgcTranslated && img.src===img.dataset.mgcTranslated) {
        img.src = img.dataset.mgcOriginal;
      }
      // cache'deki translated'i koru ama DOM'dan temizle? kullanıcı temizle dedi, cache de temizle
    });
    // cache temizle (mevcut chapter için)
    STATE.translationCache.clear();
    STATE.indexCache.clear();
    STATE.srcToIndex.clear();
    STATE.pageIndexMap = new WeakMap();
    STATE.queue = [];
    STATE.processing = false;
    STATE.activeCount = 0;
    STATE.totalCount = getReaderImages().length;
    // background kuyruğunu da temizle
    try{ browser.runtime.sendMessage({action:'clearQueueForSender'}); }catch(e){}
    // chapterCaches'i de güncelle
    const cid = getChapterId();
    if (cid && STATE.chapterCaches.has(cid)){
      const keepUrls = STATE.chapterCaches.get(cid)?.pageUrls || null;
      STATE.chapterCaches.set(cid, {
        translationCache: new Map(),
        indexCache: new Map(),
        srcToIndex: new Map(),
        totalCount: STATE.totalCount,
        domNextIdx: 0,
        pageUrls: keepUrls,
        hashToIdx: new Map()
      });
      STATE.translationCache = STATE.chapterCaches.get(cid).translationCache;
      STATE.indexCache = STATE.chapterCaches.get(cid).indexCache;
      STATE.srcToIndex = STATE.chapterCaches.get(cid).srcToIndex;
    }
    document.querySelectorAll('.mgc-translate-btn').forEach(b=>{
      b.classList.remove('translated');
      b.innerHTML=`<span style="font-weight:700">G</span> ${STATE.settings.translateMode==='google_direct'?'Görsel':'OCR'} <span style="opacity:0.8;font-size:10px">(${STATE.settings.targetLang.toUpperCase()})</span>`;
      b.disabled=false; b.dataset.busy='0'; b.dataset.translated='0';
    });
    document.querySelectorAll('.mgc-progress').forEach(p=>p.remove());
    STATE.pendingGoogle.clear();
    // apiQueued'daki bu chapter anahtarlarını da temizle (yoksa Temizle sonrası tekrar çevrilemez)
    try{
      const ccid = getChapterId();
      if (ccid){ for (const k of [...STATE.apiQueued]){ if (k===ccid || k.startsWith(ccid+':')) STATE.apiQueued.delete(k); } }
    }catch(e){}
    updateHud('temizlendi');
    setTimeout(()=>updateHud(), 1500);
  }
  function isInViewport(el){
    const r=el.getBoundingClientRect();
    return r.top<window.innerHeight && r.bottom>0;
  }
  function setupAutoObserver(){
    if (isChapterPage()) {
      // chapter'da kuyruk sistemi var, IntersectionObserver devre dışı
      return;
    }
    const io=new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if(entry.isIntersecting){
          const img=entry.target;
          const parent = img.parentElement;
          const btn=parent?.querySelector('.mgc-translate-btn');
          const hasOverlay = parent?.querySelector('canvas.mgc-canvas-overlay') || img.dataset.mgcTranslated;
          if(btn && !hasOverlay && btn.dataset.busy!=='1'){
            setTimeout(()=>handleTranslateClick(img,btn), 600);
            io.unobserve(img);
          }
        }
      });
    },{threshold:0.35});
    const observeAll=()=>document.querySelectorAll('img.mgc-target').forEach(img=>io.observe(img));
    observeAll();
    const mo2=new MutationObserver(observeAll);
    mo2.observe(document.body,{childList:true, subtree:true});
  }
})();
