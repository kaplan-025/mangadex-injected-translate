// MangaDex Google Görsel Çeviri - Background Script
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') var browser = chrome;

// Konsol sarmalayıcı: tüm [MGC*] satırları yereldeki log sunucusuna (tek yön, sessiz)
try{
  const _origLog = console.log.bind(console);
  const _origWarn = console.warn.bind(console);
  const _origErr = console.error.bind(console);
  console.log = (...a)=>{ try{ _origLog(...a); }catch(_){} try{ if (String(a[0] ?? '').indexOf('[MGC') === 0) mgcRelayBg(a); }catch(_){} };
  console.warn = (...a)=>{ try{ _origWarn(...a); }catch(_){} try{ mgcRelayBg(a); }catch(_){} };
  console.error = (...a)=>{ try{ _origErr(...a); }catch(_){} try{ mgcRelayBg(a); }catch(_){} };
}catch(_){}

const DEFAULT_SETTINGS = {
  targetLang: 'tr',
  sourceLang: 'auto',
  ocrLang: 'eng',
  autoTranslate: false,
  showLensButton: true,
  translateMode: 'google_direct',
  keepTranslateTab: false
};

const pendingJobs = new Map();
const senderToTranslate = new Map();
const jobQueues = new Map();
const BG_PARALLEL_LIMIT = 4;
const BG_QUEUE_LIMIT = 100;
function getSenderTabs(senderId){
  const v = senderToTranslate.get(senderId);
  if (!v) return [];
  if (v instanceof Set) return Array.from(v);
  return [v];
}
function addSenderTab(senderId, tabId){
  let s = senderToTranslate.get(senderId);
  if (!s){
    s = new Set([tabId]);
    senderToTranslate.set(senderId, s);
  } else if (s instanceof Set){
    s.add(tabId);
  } else {
    const set = new Set([s, tabId]);
    senderToTranslate.set(senderId, set);
  }
}
function removeSenderTab(senderId, tabId){
  const s = senderToTranslate.get(senderId);
  if (!s) return;
  if (s instanceof Set){
    s.delete(tabId);
    if (s.size===0) senderToTranslate.delete(senderId);
  } else {
    if (s===tabId) senderToTranslate.delete(senderId);
  }
}
function findIdleTab(senderId){
  const tabs = getSenderTabs(senderId);
  for (const tid of tabs){
    if (!pendingJobs.has(tid)) return tid;
  }
  return null;
}
function countActiveForSender(senderId){
  let c=0;
  for (const job of pendingJobs.values()) if (job.senderTabId===senderId) c++;
  return c;
}

// --- Injected iframe için X-Frame-Options strip (v2) ---
try{
  if (browser.webRequest && browser.webRequest.onHeadersReceived){
    browser.webRequest.onHeadersReceived.addListener(
      (details)=>{
        const headers = details.responseHeaders.filter(h=>{
          const n = h.name.toLowerCase();
          if (n==='x-frame-options' || n==='frame-options') return false;
          if (n==='content-security-policy' && h.value.includes('frame-ancestors')) {
            // frame-ancestors'ı kaldır, diğer CSP'yi koru
            h.value = h.value.replace(/frame-ancestors[^;]*;?/i, '');
            // eğer boş kaldıysa sil
            if (!h.value.trim()) return false;
          }
          return true;
        });
        return {responseHeaders: headers};
      },
      {urls: ["*://translate.google.com/*", "*://translate.google.com.tr/*"]},
      ["blocking", "responseHeaders"]
    );
    console.log('[MGC-BG] X-Frame strip aktif (v2 enjekte)');
  }
}catch(e){ console.warn('[MGC-BG] webRequest strip fail', e); }

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === 'translateText') {
    return handleTranslate(msg.text, msg.targetLang, msg.sourceLang);
  }
  if (msg.action === 'getSettings') {
    return browser.storage.local.get(DEFAULT_SETTINGS).then(s => Object.assign({}, DEFAULT_SETTINGS, s));
  }
  if (msg.action === 'saveSettings') {
    return browser.storage.local.set(msg.settings);
  }
  if (msg.action === 'fetchImageAsDataUrl') {
    return fetchImageAsDataUrl(msg.url);
  }
  if (msg.action === 'googleImageTranslate') {
    console.log('[MGC-BG] SEKMESİZ MOD: tab açılmıyor, enjeksiyon kullanın');
    return Promise.resolve({error: 'SEKMESİZ MOD: googleImageTranslate kapalı, translateViaInjected kullanın'});
  }
  if (msg.action === 'poolTranslate') {
    return poolTranslate(msg, sender);
  }
  if (msg.action === 'tesseractOCR') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    return handleTesseractOCR(msg, tabId);
  }
  if (msg.action === 'fetchPendingPush') {
    const sid = sender && sender.tab ? sender.tab.id : null;
    let n = 0;
    try{
      for (const [k,e] of pendingPush){
        if (e.senderTabId===sid && (!msg.chId || e.chId===msg.chId)){ attemptPush(k); n++; }
      }
    }catch(_){}
    return Promise.resolve({ok:true, flushed:n});
  }
  if (msg.action === 'mgcLog' && Array.isArray(msg.lines)) {
    try{
      for (const ln of msg.lines){
        if (typeof ln !== 'string') continue;
        mgcBgBuf.push(String(ln).slice(0, 500));
      }
      if (mgcBgBuf.length > 300) mgcBgBuf.splice(0, mgcBgBuf.length - 300);
      mgcScheduleFlush();
    }catch(_){}
    return Promise.resolve({ok:true});
  }
  if (msg.action === 'translateTabReady') {
    if (sender.tab) handleTranslateTabReady(sender.tab.id);
    return Promise.resolve({ ok: true });
  }
  if (msg.action === 'googleTranslateResult') {
    return handleGoogleResultFromTab(msg, sender);
  }
  if (msg.action === 'dropQueuedExcept') {
    // Chapter atlama: koşmayan eski işleri at, yenilere yol aç (kayıp yok: cache'te biten durur)
    const keep = msg.chId;
    let dropped = 0;
    try{
      for (let i=poolQueue.length-1;i>=0;i--){
        const j = poolQueue[i];
        if (!j.running && j.chId !== keep){ poolQueue.splice(i,1); dropped++; }
      }
      console.log('[MGC-BG] eski chapter kuyruğu atıldı', dropped, 'kalan', poolQueue.length);
    }catch(e){}
    setTimeout(pumpPool, 300);
    return Promise.resolve({ok:true, dropped});
  }
  if (msg.action === 'clearQueueForSender') {
    const sid = sender.tab ? sender.tab.id : null;
    if (sid){
      console.log('[MGC-BG] clearQueueForSender', sid, 'active', countActiveForSender(sid), 'queued', jobQueues.get(sid)?.length||0);
      jobQueues.delete(sid);
      const tabs = getSenderTabs(sid);
      for (const tid of [...tabs]){
        if (pendingJobs.has(tid)){
          pendingJobs.delete(tid);
        }
        try{ browser.tabs.remove(tid); }catch(e){}
        removeSenderTab(sid, tid);
      }
      // kalan idle tabları da temizle
      const remaining = getSenderTabs(sid);
      for (const tid of remaining){
        try{ browser.tabs.remove(tid); }catch(e){}
      }
      senderToTranslate.delete(sid);
    }
    return Promise.resolve({ok:true});
  }
});

browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.get(DEFAULT_SETTINGS).then(current => {
    const toSet = {};
    for (const k in DEFAULT_SETTINGS) if (current[k] === undefined) toSet[k] = DEFAULT_SETTINGS[k];
    if (Object.keys(toSet).length) browser.storage.local.set(toSet);
  });
});

async function handleGoogleImageTranslate(msg, sender) {
  console.log('[MGC-BG] handleGoogleImageTranslate geldi', 'senderTab', sender.tab?.id, 'mangaUrl', msg.mangaUrl?.slice(0,60), 'dataUrl len', msg.dataUrl?.length, 'target', msg.targetLang);
  const { dataUrl, targetLang, sourceLang, mangaUrl } = msg;
  if (!dataUrl) {
    console.error('[MGC-BG] dataUrl yok');
    return { error: 'dataUrl yok' };
  }
  const senderTabId = sender.tab ? sender.tab.id : null;
  if (!senderTabId) {
    console.error('[MGC-BG] sender.tab yok', sender);
    return { error: 'sender.tab yok' };
  }

  const settings = await browser.storage.local.get(DEFAULT_SETTINGS);
  const tl = targetLang || settings.targetLang || 'tr';
  const sl = sourceLang || settings.sourceLang || 'auto';
  const translateUrl = `https://translate.google.com.tr/?sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&op=images`;

  try {
    const active = countActiveForSender(senderTabId);
    const queued = jobQueues.get(senderTabId)?.length || 0;
    if (active + queued >= BG_PARALLEL_LIMIT + BG_QUEUE_LIMIT){
      return { error: 'Çok fazla bekleyen iş, lütfen bekleyin' };
    }
    // idle tab varsa yeniden kullan
    if (active < BG_PARALLEL_LIMIT){
      const idle = findIdleTab(senderTabId);
      if (idle){
        try{
          const tab = await browser.tabs.get(idle);
          if (tab){
            console.log('[MGC-BG] idle translate sekmesi yeniden kullanılıyor', idle);
            pendingJobs.set(idle, { senderTabId, mangaUrl, dataUrl, targetLang: tl, sourceLang: sl, createdAt: Date.now() });
            setTimeout(() => tryDoTranslate(idle), 500);
            setTimeout(() => tryDoTranslate(idle), 1500);
            setTimeout(() => tryDoTranslate(idle), 3000);
            return { queued: true, translateTabId: idle, reused: true };
          }
        }catch(e){
          removeSenderTab(senderTabId, idle);
          pendingJobs.delete(idle);
        }
      }
    }
    // paralel limit doluysa kuyruğa ekle
    if (active >= BG_PARALLEL_LIMIT){
      if (!jobQueues.has(senderTabId)) jobQueues.set(senderTabId, []);
      jobQueues.get(senderTabId).push({ mangaUrl, dataUrl, targetLang: tl, sourceLang: sl, senderTabId });
      console.log('[MGC-BG] paralel limit dolu, kuyruğa eklendi', mangaUrl.slice(0,40), 'aktif', active, 'kuyruk', jobQueues.get(senderTabId).length);
      const tabs = getSenderTabs(senderTabId);
      return { queued: true, translateTabId: tabs[0] || null, queuedPosition: jobQueues.get(senderTabId).length };
    }

    let translateTab = null;
    try {
      translateTab = await browser.tabs.create({ url: translateUrl, active: false });
    } catch (e) {
      console.warn('[MGC] tabs.create active:false fail, trying active:true', e);
      translateTab = await browser.tabs.create({ url: translateUrl, active: true });
      try { await browser.tabs.update(senderTabId, { active: true }); } catch(e2){}
    }

    const tabId = translateTab.id;
    console.log('[MGC-BG] Translate sekmesi oluşturuldu (paralel)', tabId, translateUrl, 'sender', senderTabId);
    LOG(`[MGC] Translate sekmesi oluşturuldu tabId=${tabId} -> ${translateUrl} (sender ${senderTabId})`);
    pendingJobs.set(tabId, { senderTabId, mangaUrl, dataUrl, targetLang: tl, sourceLang: sl, createdAt: Date.now() });
    addSenderTab(senderTabId, tabId);
    if (!jobQueues.has(senderTabId)) jobQueues.set(senderTabId, []);
    setTimeout(() => tryDoTranslate(tabId), 2000);
    setTimeout(() => tryDoTranslate(tabId), 4000);
    setTimeout(() => tryDoTranslate(tabId), 7000);
    return { queued: true, translateTabId: tabId };
  } catch (e) {
    console.error('[MGC] handleGoogleImageTranslate hata', e);
    return { error: e.message };
  }
}

async function handleTranslateTabReady(tabId) {
  LOG(`[MGC] translateTabReady tabId=${tabId}`);
  setTimeout(() => tryDoTranslate(tabId), 800);
}

async function tryDoTranslate(tabId) {
  console.log('[MGC-BG] tryDoTranslate', tabId, 'pending', !!pendingJobs.get(tabId));
  const job = pendingJobs.get(tabId);
  if (!job) {
    console.log('[MGC-BG] job yok', tabId);
    return;
  }
  if (job._sent) {
    console.log('[MGC-BG] zaten gönderildi', tabId);
    return;
  }
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab) return;
    LOG(`[MGC] doGoogleTranslate gönderiliyor tabId=${tabId}`);
    job._sent = true;
    const res = await browser.tabs.sendMessage(tabId, {
      action: 'doGoogleTranslate',
      dataUrl: job.dataUrl,
      targetLang: job.targetLang,
      sourceLang: job.sourceLang
    });
    if (res && res.dataUrl) {
      LOG(`[MGC] çeviri başarılı tabId=${tabId}, sonuç uzunluk ${res.dataUrl.length}`);
      await forwardResultToManga(job, res);
    } else if (res && res.error) {
      LOG(`[MGC] çeviri hata tabId=${tabId} ${res.error}`);
      await forwardErrorToManga(job, res.error);
    } else {
      LOG(`[MGC] çeviri boş yanıt tabId=${tabId}`, res);
    }
  } catch (e) {
    console.warn(`[MGC] tryDoTranslate hata tabId=${tabId}`, e.message);
    if (String(e.message).includes('Receiving end') || String(e.message).includes('No tab with id')) {
      job._sent = false;
      setTimeout(() => tryDoTranslate(tabId), 1500);
    } else {
      await forwardErrorToManga(job, e.message);
    }
  }
}

async function handleGoogleResultFromTab(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  const job = tabId ? pendingJobs.get(tabId) : null;
  if (!job) return { error: 'job not found' };
  if (msg.dataUrl) {
    await forwardResultToManga(job, msg);
  } else {
    await forwardErrorToManga(job, msg.error || 'bilinmeyen hata');
  }
  return { ok: true };
}

async function forwardResultToManga(job, res) {
  console.log('[MGC-BG] forwardResultToManga', job.senderTabId, 'mangaUrl', job.mangaUrl?.slice(0,60), 'data len', res.dataUrl?.length);
  try {
    await browser.tabs.sendMessage(job.senderTabId, {
      action: 'showTranslatedImage',
      mangaUrl: job.mangaUrl,
      dataUrl: res.dataUrl,
      via: 'google_direct'
    });
  } catch (e) {
    console.warn('[MGC] forwardResultToManga fail', e);
  }
  const q = jobQueues.get(job.senderTabId);
  if (q && q.length>0){
    let tabId = null;
    for (const [k,v] of pendingJobs.entries()) if (v===job) { tabId=k; break; }
    if (tabId) pendingJobs.delete(tabId);
    const nextJob = q.shift();
    // aynı tabı yeniden kullan
    const reuseTabId = tabId;
    if (reuseTabId){
      console.log('[MGC-BG] kuyruktan sıradaki iş aynı sekmede başlatılıyor', reuseTabId, 'kalan', q.length);
      pendingJobs.set(reuseTabId, {
        senderTabId: nextJob.senderTabId,
        mangaUrl: nextJob.mangaUrl,
        dataUrl: nextJob.dataUrl,
        targetLang: nextJob.targetLang,
        sourceLang: nextJob.sourceLang,
        createdAt: Date.now()
      });
      // senderToTranslate zaten içeriyor, tekrar eklemeye gerek yok
      setTimeout(()=> tryDoTranslate(reuseTabId), 800);
      setTimeout(()=> tryDoTranslate(reuseTabId), 2000);
      return;
    }
  }
  const settings = await browser.storage.local.get(DEFAULT_SETTINGS);
  if (!settings.keepTranslateTab) {
    setTimeout(async () => {
      const qq = jobQueues.get(job.senderTabId);
      if (qq && qq.length>0){
        console.log('[MGC-BG] kapatma iptal, kuyruk doldu');
        return;
      }
      try { 
        let tabId = null;
        for (const [k,v] of pendingJobs.entries()) if (v===job) { tabId=k; break; }
        if (!tabId) {
          // job zaten silindi, reuseTabId'yi bul
          const tabs = getSenderTabs(job.senderTabId);
          // en son tab'ı kapatmaya çalışma, hangisi boşta?
          // pendingJobs'ta olmayan ama senderToTranslate'te olan idle tab'ı bul
          const idle = findIdleTab(job.senderTabId);
          if (idle) tabId = idle;
          else if (tabs.length) tabId = tabs[0];
        }
        if (tabId) {
          await browser.tabs.remove(tabId);
          pendingJobs.delete(tabId);
          removeSenderTab(job.senderTabId, tabId);
        }
      } catch(e){}
      for (const [k,v] of pendingJobs.entries()) if (v===job) pendingJobs.delete(k);
      const remainingQ = jobQueues.get(job.senderTabId);
      if (!remainingQ || remainingQ.length===0){
        // tüm tabları temizle
        const tabs = getSenderTabs(job.senderTabId);
        for (const t of tabs){
          try{ await browser.tabs.remove(t); }catch(e){}
          pendingJobs.delete(t);
        }
        senderToTranslate.delete(job.senderTabId);
        jobQueues.delete(job.senderTabId);
      }
    }, 1500);
  } else {
    for (const [k,v] of pendingJobs.entries()) if (v===job) pendingJobs.delete(k);
  }
}

async function forwardErrorToManga(job, error) {
  try {
    await browser.tabs.sendMessage(job.senderTabId, {
      action: 'googleTranslateError',
      mangaUrl: job.mangaUrl,
      error: String(error)
    });
  } catch(e){}
  const q = jobQueues.get(job.senderTabId);
  if (q && q.length>0){
    let tabId = null;
    for (const [k,v] of pendingJobs.entries()) if (v===job) { tabId=k; break; }
    if (tabId) pendingJobs.delete(tabId);
    const nextJob = q.shift();
    // aynı tabı yeniden kullanmaya çalış
    const reuseTabId = tabId || findIdleTab(job.senderTabId) || getSenderTabs(job.senderTabId)[0];
    if (reuseTabId){
      console.log('[MGC-BG] hata sonrası kuyruktan sıradaki', reuseTabId);
      pendingJobs.set(reuseTabId, {
        senderTabId: nextJob.senderTabId,
        mangaUrl: nextJob.mangaUrl,
        dataUrl: nextJob.dataUrl,
        targetLang: nextJob.targetLang,
        sourceLang: nextJob.sourceLang,
        createdAt: Date.now()
      });
      setTimeout(()=> tryDoTranslate(reuseTabId), 1000);
      return;
    }
  }
  if (String(error).includes('timeout') || String(error).includes('bulunamadı')) {
    try { 
      let tabId = null;
      for (const [k,v] of pendingJobs.entries()) if (v===job) { tabId=k; break; }
      if (tabId) {
        await browser.tabs.remove(tabId);
        pendingJobs.delete(tabId);
        removeSenderTab(job.senderTabId, tabId);
      }
    } catch(e){}
    for (const [k,v] of pendingJobs.entries()) if (v===job) pendingJobs.delete(k);
    // hata sonrası kuyruk da temizlensin mi? Hayır, kuyruk devam etsin
    // ama timeout ise tüm kuyruğu temizle
    jobQueues.delete(job.senderTabId);
    // tüm tabları temizle
    const tabs = getSenderTabs(job.senderTabId);
    for (const t of tabs){
      try{ await browser.tabs.remove(t); }catch(e){}
    }
    senderToTranslate.delete(job.senderTabId);
  } else {
    for (const [k,v] of pendingJobs.entries()) if (v===job) pendingJobs.delete(k);
  }
}

browser.tabs.onRemoved.addListener((tabId) => {
  // Havuz sekmesi: üstündeki koşan işleri iade et (kayıp push engeli)
  try{
    const pi = poolTabs.findIndex(t=>t.id===tabId);
    if (pi>=0) poolTabs.splice(pi,1);
    let revived = 0;
    for (let i=poolQueue.length-1;i>=0;i--){
      const j = poolQueue[i];
      if (j.running && j.tabId===tabId){
        j.running = false; j.tabId = null; j.tries = (j.tries||0)+1;
        if (j.tries >= 3){
          poolQueue.splice(i,1);
          try{ browser.tabs.sendMessage(j.senderTabId, {action:'googleTranslateError', mangaUrl: j.mangaUrl, error:'sekme kapandı, 3 deneme doldu'}).catch(()=>{}); }catch(_){}
        } else revived++;
      }
    }
    if (revived){ console.log('[MGC-BG] kapanan sekmeden iş iade', tabId, revived); setTimeout(pumpPool, 500); }
  }catch(e){}
  if (pendingJobs.has(tabId)) {
    LOG(`[MGC] translate tab kapatıldı ${tabId}, job temizleniyor`);
    const job = pendingJobs.get(tabId);
    pendingJobs.delete(tabId);
    removeSenderTab(job.senderTabId, tabId);
    const q = jobQueues.get(job.senderTabId);
    if (q && q.length) {
      console.log('[MGC] translate tab kapandı ama kuyruk vardı, kuyruk temizleniyor', q.length);
      jobQueues.delete(job.senderTabId);
      // kalan tabları da temizle
      const tabs = getSenderTabs(job.senderTabId);
      for (const t of [...tabs]){
        if (t!==tabId) {
          try{ browser.tabs.remove(t); }catch(e){}
          pendingJobs.delete(t);
        }
      }
      senderToTranslate.delete(job.senderTabId);
    }
  } else {
    const allSenders = Array.from(senderToTranslate.entries());
    for (const [sender, tabs] of allSenders){
      const arr = tabs instanceof Set ? Array.from(tabs) : [tabs];
      if (arr.includes(tabId)){
        LOG(`[MGC] boşta translate tab kapatıldı ${tabId} sender ${sender}`);
        removeSenderTab(sender, tabId);
        if (!senderToTranslate.has(sender)) jobQueues.delete(sender);
        break;
      }
    }
  }
});

// ---- v2.2 kalıcı sekme havuzu: en fazla 2 sekme, resim başına sekme YOK ----
const POOL_SIZE = 3;
const poolTabs = []; // {id, busy, ready}
const poolQueue = [];
let poolWarming = false;
async function ensurePool(sl, tl){
  for (let i=poolTabs.length-1;i>=0;i--){
    try{ await browser.tabs.get(poolTabs[i].id); }
    catch(e){ poolTabs.splice(i,1); }
  }
  while (poolTabs.length < POOL_SIZE){
    const url = `https://translate.google.com.tr/?sl=${encodeURIComponent(sl||'auto')}&tl=${encodeURIComponent(tl||'tr')}&op=images`;
    const tab = await browser.tabs.create({url, active:false});
    poolTabs.push({id: tab.id, busy:false, ready:false, bornAt: Date.now()});
    console.log('[MGC-BG] havuz sekmesi açıldı', tab.id, '(toplam '+poolTabs.length+', bir kez)');
    setTimeout(()=>{ const e=poolTabs.find(x=>x.id===tab.id); if(e) e.ready=true; }, 5000);
  }
  return poolTabs;
}
function poolTranslate(msg, sender){
  // Ateşle-unut: kanal hemen kapanır (uzun-açık kanal ölümlerini bitirir).
  // Sonuç itmeli gelir (showTranslatedImage / googleTranslateError).
  const {dataUrl, pageUrl, targetLang, sourceLang, mangaUrl, pageIdx, chId} = msg;
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  if (!senderTabId) return Promise.resolve({error:'sender.tab yok'});
  // Kopya koruması SENKRON: ensurePool await'inden önce bak+ekle, yoksa eşzamanlı
  // çağrılar aynı işi 2-4 kez kuyruğa sokuyordu (Google sekmeleri aynı resmi çeviriyordu).
  if (poolQueue.some(j=>j.mangaUrl===mangaUrl)){
    console.log('[MGC-BG] kopya iş atıldı', mangaUrl);
    return Promise.resolve({queued:true, duplicate:true});
  }
  poolQueue.push({dataUrl: dataUrl||null, pageUrl: pageUrl||null, targetLang, sourceLang, mangaUrl, pageIdx, chId, senderTabId, tries:0});
  ensurePool(sourceLang, targetLang).then(()=>{
    pumpPool();
  }).catch(e=>{ try{
    browser.tabs.sendMessage(senderTabId, {action:'googleTranslateError', mangaUrl, error:String(e&&e.message||e)});
  }catch(_){} });
  return Promise.resolve({queued:true});
}
// Teslim garantisi: push tek seferlik değil; hedef anlık yanıt vermezse saklanır,
// içerik fetchPendingPush ile ister, bulunca boşaltılır (son-sayfa kaybı engeli).
const pendingPush = new Map(); // mangaUrl -> {dataUrl, via, senderTabId, chId, tries, timer}
function attemptPush(key){
  const e = pendingPush.get(key);
  if (!e) return;
  try{ if (e.timer) clearTimeout(e.timer); }catch(_){}
  e.timer = null;
  e.tries++;
  browser.tabs.sendMessage(e.senderTabId, {action:'showTranslatedImage', mangaUrl:key, dataUrl:e.dataUrl, via:e.via}).then(()=>{
    if (pendingPush.get(key)===e) pendingPush.delete(key);
  }).catch(()=>{
    if (e.tries >= 12){ pendingPush.delete(key); console.warn('[MGC-BG] push birakildi', key); return; }
    e.timer = setTimeout(()=>attemptPush(key), Math.min(30000, 2000*e.tries));
  });
}
function pushResult(senderTabId, mangaUrl, dataUrl, via, chId){
  const ex = pendingPush.get(mangaUrl);
  if (ex){ ex.dataUrl = dataUrl; ex.via = via; }
  else {
    pendingPush.set(mangaUrl, {dataUrl, via, senderTabId, chId, tries:0, timer:null});
    if (pendingPush.size > 60){
      const k = pendingPush.keys().next().value;
      try{ const o = pendingPush.get(k); if (o && o.timer) clearTimeout(o.timer); }catch(_){}
      pendingPush.delete(k);
    }
  }
  attemptPush(mangaUrl);
}
const tabHealth = new Map(); // tabId -> {ok, at}
async function pingTab(tabId, ms=2500){
  const cached = tabHealth.get(tabId);
  if (cached && Date.now()-cached.at < 15000) return cached.h;
  try{
    const r = await Promise.race([
      browser.tabs.sendMessage(tabId, {action:'ping'}).then(x=>({ok:true, x}), e=>({ok:false})),
      new Promise(rs=>setTimeout(()=>rs({ok:false}), ms)),
    ]);
    const h = r.ok ? r.x : null;
    tabHealth.set(tabId, {h, at: Date.now()});
    return h;
  }catch(e){ return null; }
}
let pumpClaiming = false;
async function pumpPool(){
  if (pumpClaiming){ setTimeout(pumpPool, 250); return; }
  pumpClaiming = true;
  let job = null, free = null;
  try{
  job = poolQueue.find(j=>!j.running);
  if (!job) return;
  // Sağlık kontrollü atama: ölü/yabancı moddaki sekmeye iş verme (takılma engeli)
  for (const t of poolTabs){
    if (t.busy) continue;
    if (Date.now()-(t.bornAt||0) < 20000) continue; // yükleniyor: ne ping ne reload
    const h = await pingTab(t.id);
    if (h && h.url && h.url.includes('op=images') && h.hasInput){ free = t; break; }
    if (h && h.url && !h.url.includes('op=images')){
      console.log('[MGC-BG] sekme yanlış modda, yenileniyor', t.id, h.url.slice(0,60));
      try{ browser.tabs.reload(t.id); }catch(e){}
      t.busy = true; t.bornAt = Date.now();
      setTimeout(()=>{ t.busy = false; setTimeout(pumpPool, 500); }, 15000);
      continue;
    }
    if (!h){
      console.log('[MGC-BG] sekme yanıtsız, yenileniyor', t.id);
      try{ browser.tabs.reload(t.id); }catch(e){}
      t.busy = true; t.bornAt = Date.now();
      setTimeout(()=>{ t.busy = false; setTimeout(pumpPool, 500); }, 15000);
      continue;
    }
  }
  if (!free){
    // Havuz dolu/bozuk ya da sekmeler kapanmış (kullanıcı kapattı/çöktü):
    // önce havuzu doldur, sonra tekrar (doldurma yoksa sonsuz boş-dönüş = takılma).
    try{
      ensurePool(job.sourceLang, job.targetLang).then(()=>setTimeout(pumpPool, 3000)).catch(()=>setTimeout(pumpPool, 3000));
    }catch(_){ setTimeout(pumpPool, 2000); }
    return;
  }
  job.running = true;
  job.tabId = free.id;
  free.busy = true;
  } finally { pumpClaiming = false; }
  if (!job) return;
  if (!free){ setTimeout(pumpPool, 2000); return; }
  // Baytlar kanaldan gelmediyse (küçük mesaj): burada indir (en fazla 2 eşzamanlı)
  if (!job.dataUrl && job.pageUrl){
    try{
      const tF = Date.now();
      // Başlık+gövde toplam 60sn (korumasız blob() slotu rehin bırakırdı)
      const got = await Promise.race([
        (async ()=>{
          const resp = await fetch(job.pageUrl, {credentials:'omit'});
          if (!resp.ok) throw new Error('sayfa indirilemedi HTTP '+resp.status);
          const blob = await resp.blob();
          const durl = await new Promise((res2,rej)=>{ const r=new FileReader(); r.onload=()=>res2(r.result); r.onerror=rej; r.readAsDataURL(blob); });
          return {blob, durl};
        })(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('sayfa indirme zaman aşımı 60sn')), 60000)),
      ]);
      const blob = got.blob;
      job.dataUrl = got.durl;
      console.log('[MGC-BG] süre: indir', ((Date.now()-tF)/1000).toFixed(1)+'sn', (blob.size/1024).toFixed(0)+'KB', job.mangaUrl);
    }catch(e){
      free.busy = false;
      job.running = false;
      const ix = poolQueue.indexOf(job);
      if (ix>=0) poolQueue.splice(ix,1);
      try{ await browser.tabs.sendMessage(job.senderTabId, {action:'googleTranslateError', mangaUrl: job.mangaUrl, error:String(e&&e.message||e)}); }catch(_){}
      setTimeout(pumpPool, 500);
      return;
    }
  }
  if (!job.dataUrl){
    free.busy = false;
    job.running = false;
    const ix = poolQueue.indexOf(job);
    if (ix>=0) poolQueue.splice(ix,1);
    try{ await browser.tabs.sendMessage(job.senderTabId, {action:'googleTranslateError', mangaUrl: job.mangaUrl, error:'görsel yok'}); }catch(_){}
    setTimeout(pumpPool, 500);
    return;
  }
  // Sekme çağrısı yarışlı: reload anında kanal yanıtsız kalır; slotu rehin bırakma.
  // Zaman aşımında iş kuyrukta kalır (başka sekme dener), geç gelen sonuç yine itilir (önbellek yutar).
  const TAB_TIMEOUT = 200000;
  const tG = Date.now();
  let tabTimedOut = false;
  const pushLate = (durl)=>{
    pushResult(job.senderTabId, job.mangaUrl, durl, 'pool-late', job.chId);
  };
  const sendP = browser.tabs.sendMessage(free.id, {action:'doGoogleTranslate', dataUrl: job.dataUrl, targetLang: job.targetLang, sourceLang: job.sourceLang}).then(
    r=>({delivered:true, r}),
    e=>({delivered:false, err:String(e&&e.message||e)}));
  sendP.then(o=>{ if (tabTimedOut && o.delivered && o.r && o.r.dataUrl) pushLate(o.r.dataUrl); });
  const out = await Promise.race([sendP, new Promise(rs=>setTimeout(()=>rs({delivered:false, timeout:true}), TAB_TIMEOUT))]);
  console.log('[MGC-BG] süre: google', ((Date.now()-tG)/1000).toFixed(1)+'sn', job.mangaUrl);
  if (!out.delivered){
    tabTimedOut = !!out.timeout;
    const deadTab = !out.timeout && /receiving end|no tab|could not establish|no receiving|message port closed/i.test(out.err||'');
    if (deadTab){
      // Sekme o an ölü (reload/geçiş): çeviri hatası değil, deneme yakma; sağlık önbelleğini sil
      console.warn('[MGC-BG] ölü sekmeye denk geldi, yakmadan iade', job.mangaUrl, out.err||'');
      try{ tabHealth.delete(free.id); }catch(_){}
      free.busy = false;
      job.running = false;
      job.tabId = null;
      setTimeout(pumpPool, 1000);
      return;
    }
    console.warn('[MGC-BG] sekme yanıt vermedi', out.timeout?' (zaman aşımı 200sn)':'', job.mangaUrl, out.err||'');
    free.busy = false;
    job.running = false;
    job.tabId = null;
    job.tries++;
    if (job.tries < 3){ setTimeout(pumpPool, 1000); return; }
    const ixT = poolQueue.indexOf(job);
    if (ixT>=0) poolQueue.splice(ixT,1);
    try{ await browser.tabs.sendMessage(job.senderTabId, {action:'googleTranslateError', mangaUrl: job.mangaUrl, error:'Sekme yanıt vermedi (200sn)'}); }catch(e){}
    setTimeout(pumpPool, 500);
    return;
  }
  const res = out.r;
  try{
    free.busy = false;
    const ix = poolQueue.indexOf(job);
    if (ix>=0) poolQueue.splice(ix,1);
    if (res && res.dataUrl){
      free._inputFails = 0;
      free._uses = (free._uses||0)+1;
      // garantili itmeli teslimat: hedef yanıt vermezse saklanır, içerik isteyince boşaltılır
      pushResult(job.senderTabId, job.mangaUrl, res.dataUrl, 'pool', job.chId);
      // ponytail: 5 yüklemede bir sekmeyi yenile (Google durumu bozulmadan; ölü-sekme sınıfını kapatır)
      if (free._uses >= 5){
        const deadId = free.id;
        console.log('[MGC-BG] havuz sekmesi devri doldu, yenisi açılacak', deadId);
        setTimeout(async()=>{
          try{ await browser.tabs.remove(deadId); }catch(e){}
          const ix = poolTabs.findIndex(t=>t.id===deadId);
          if (ix>=0) poolTabs.splice(ix,1);
        }, 500);
      }
    }
    else {
      const em = String((res&&res.error)||'Boş havuz yanıtı');
      if (/input|bulunamadı/i.test(em) && (free._inputFails||0) < 3){
        // ponytail: ölü sekmeyi yeniden yükle, işi kuyrukta tut (kayıp yok)
        free._inputFails = (free._inputFails||0)+1;
        console.warn('[MGC-BG] ölü sekme, yenileniyor', free.id);
        try{ await browser.tabs.reload(free.id); }catch(e){}
        job.running = false;
        setTimeout(pumpPool, 7000);
        return;
      }
      const ix2 = poolQueue.indexOf(job);
      if (ix2>=0) poolQueue.splice(ix2,1);
      try{ await browser.tabs.sendMessage(job.senderTabId, {action:'googleTranslateError', mangaUrl: job.mangaUrl, error: em}); }catch(e){}
    }
    // giriş temizliği: sonraki iş için resmi temizle komutu (hızlı yeniden kullanım)
    setTimeout(pumpPool, 400);
  }catch(e){
    // Sekme hazır değil (henüz yüklenmedi): 2sn bekle, tekrar dene
    free.busy = false;
    job.running = false;
    console.warn('[MGC-BG] havuz gönderim fail, tekrar', e.message);
    setTimeout(pumpPool, 2000);
  }
}

function dataUrlToBlobBg(dataUrl){
  const [header, b64] = dataUrl.split(',');
  const mime = (header.match(/data:(.*?);/)||[])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i=0; i<bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], {type: mime});
}
function LOG(...a){ try{ console.log(...a);}catch(e){} }
// Canlı log köprüsü: içerik sekmelerinden gelen satırlar + kendi satırlarımız yereldeki sunucuya
const MGC_LOG_URL = 'http://127.0.0.1:8765/log';
const mgcBgBuf = [];
let mgcBgTimer = null;
function mgcScheduleFlush(){
  if (mgcBgTimer) return;
  mgcBgTimer = setTimeout(()=>{
    mgcBgTimer = null;
    const batch = mgcBgBuf.splice(0, mgcBgBuf.length);
    if (!batch.length) return;
    try{ fetch(MGC_LOG_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body: batch.join('\n')}).catch(()=>{}); }catch(_){}
  }, 3000);
}
function mgcRelayBg(a){
  try{
    let text;
    try{ text = a.map(x=> typeof x==='string' ? x : JSON.stringify(x)).join(' '); }
    catch(_){ text = String(a); }
    mgcBgBuf.push(text.slice(0, 500));
    if (mgcBgBuf.length > 300) mgcBgBuf.splice(0, mgcBgBuf.length - 300);
    mgcScheduleFlush();
  }catch(_){}
}
// Background konsolu headless'ta görünmez -> içeriğe röle (fxconsole yakalar)
function bgLog(tabId, ...a){
  try{
    const text = a.map(x=>{ try{ return typeof x==='string'?x:JSON.stringify(x); }catch(_){ return String(x); } }).join(' ');
    console.log('[MGC-BG-TESS]', text);
    if (tabId) browser.tabs.sendMessage(tabId, {action:'bgLog', text}).catch(()=>{});
  }catch(_){}
}

// ---- Tesseract OCR (background: eklenti CSP'si WASM'a izinli, sayfa CSP'si engeller) ----
// Kalıcı worker: ilk çağrıda ısınır (dil verisi+wasm), sonrakiler hızlı
let tessWorker = null, tessWorkerLang = null;
async function getTessWorker(lang, tlog){
  if (tessWorker && tessWorkerLang === lang) return tessWorker;
  if (tessWorker){ try{ await tessWorker.terminate(); }catch(_){} tessWorker = null; }
  tlog('worker yaratiliyor', lang);
  tessWorker = await Tesseract.createWorker(lang||'eng', undefined, {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    logger: m=>{ try{ tlog('ocr', (m.status||'?')+' '+(m.progress||0)); }catch(_){} },
  });
  tessWorkerLang = lang;
  tlog('worker hazir');
  return tessWorker;
}
// Manga için ön-işleme: 2x büyüt (küçük balon yazısı LSTM'e küçük gelir), gri ton
async function upscaleForOCR(blob, tlog){
  try{
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1.5, 2400 / Math.max(bmp.width, bmp.height));
    if (scale <= 1.05) return blob;
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale);
    cv.height = Math.round(bmp.height * scale);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.filter = 'grayscale(1) contrast(1.25)';
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    tlog('upscale', bmp.width + 'x' + bmp.height, '->', cv.width + 'x' + cv.height);
    return await new Promise(res => cv.toBlob(b => res(b || blob), 'image/png'));
  }catch(e){ tlog('upscale atlandi', String(e && e.message || e)); return blob; }
}
// Sembol salatasını ele: harf/rakam oranı düşük bloklar çöptür
function isTextSalad(t){
  const s = String(t || '');
  if (s.length < 2) return true;
  const good = (s.match(/[A-Za-z0-9\u00c0-\u024f\u1e00-\u1eff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
  return good / s.length < 0.5;
}
async function handleTesseractOCR({dataUrl, lang}, tabId){
  const tlog = (...a)=>bgLog(tabId, ...a);
  let lastStatus = 'start';
  try{
    if (typeof Tesseract==='undefined' || !Tesseract.createWorker) return {error:'Tesseract BG yok'};
    let blob = dataUrlToBlobBg(dataUrl);
    lastStatus = 'blob-ok:'+blob.size; tlog('blob', blob.size, blob.type);
    blob = await upscaleForOCR(blob, tlog);
    const worker = await getTessWorker(lang||'eng', tlog);
    lastStatus = 'recognize-basladi'; tlog('recognize basladi');
    const r = await worker.recognize(blob);
    tlog('recognize bitti');
    const out = [];
    const data = r && r.data;
    if (data && data.blocks && data.blocks.length){
      for (const b of data.blocks){
        for (const para of (b.paragraphs||[])){
          for (const line of (para.lines||[])){
            const text = line.text && line.text.trim();
            if (text && !isTextSalad(text)) out.push({text, bbox: line.bbox||b.bbox, conf: line.confidence||b.confidence||60});
          }
        }
        if (!b.paragraphs?.length && b.text && b.text.trim() && !isTextSalad(b.text)){
          out.push({text: b.text.trim(), bbox: b.bbox, conf: b.confidence||60});
        }
      }
    }
    tlog('blok', out.length);
    return {blocks: out};
  }catch(e){
    let info = 'son-durum='+lastStatus;
    try{ info += ' tip='+typeof e+' ad='+(e&&e.name)+' mesaj='+(e&&e.message)+' yigin='+String((e&&e.stack)||'').slice(0,200); }
    catch(_){ info += ' okunamadi'; }
    console.error('[MGC-BG] tesseractOCR hata', info);
    return {error:'Tesseract BG: '+info.slice(0,220)};
  }
}
async function handleTranslate(text, targetLang = 'tr', sourceLang = 'auto') {
  if (!text || !text.trim()) return { translated: '' };
  const chunks = splitText(text, 1500);
  let results = [];
  for (const chunk of chunks) {
    const t = await translateSingle(chunk, targetLang, sourceLang);
    results.push(t);
    await sleep(80);
  }
  return { translated: results.join(' ') };
}
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = []; let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      let lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start + maxLen * 0.5) end = lastSpace;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
async function translateSingle(text, tl, sl) {
  const endpoints = [
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
  ];
  for (const url of endpoints) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(()=>ctl.abort(), 20000);
      let resp;
      try{ resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, signal: ctl.signal }); }
      finally{ clearTimeout(timer); }
      if (!resp.ok) continue;
      const data = await resp.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        let out = '';
        for (const seg of data[0]) if (seg && seg[0]) out += seg[0];
        if (out) return out;
      }
      if (data.sentences) return data.sentences.map(s => s.trans).join('');
    } catch (e) { console.warn('[MGC] translate endpoint failed', url, e); continue; }
  }
  throw new Error('Çeviri başarısız - Google API yanıt vermedi');
}
async function fetchImageAsDataUrl(url) {
  try {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const dataUrl = await blobToDataUrl(blob);
    return { dataUrl, mime: blob.type };
  } catch (e) { return { error: e.message }; }
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
