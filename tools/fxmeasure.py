#!/usr/bin/env python3
"""Hız ölçümü: chapter'lar arası sayfa/dk + hata/kısılma olayları.
Kullanım: python3 tools/fxmeasure.py <chapterId> [dakika]"""
import sys, time, os, re, json, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fxconsole import FxConsole

EVT = re.compile(r"devri doldu|yenileniyor|zaman aşımı|timeout|hata|Hata|error|Error|429|throttl|kıs|yavaş|tekrar denenecek|indiril|404|havuz gönderim fail")

def snap(fx):
    try:
        return fx.js(
            "({cid:document.documentElement.dataset.mgcCid,"
            "ck:(JSON.parse(document.documentElement.dataset.mgcDbg||'{}')).ck||[],"
            "q:(JSON.parse(document.documentElement.dataset.mgcDbg||'{}')).q||0,"
            "pd:(JSON.parse(document.documentElement.dataset.mgcDbg||'{}')).pd||0,"
            "le:(JSON.parse(document.documentElement.dataset.mgcDbg||'{}')).le||'none',"
            "trans:document.querySelectorAll('img[data-mgc-translated]').length})")
    except Exception as e:
        return {"driver_err": str(e)[:80]}

def main():
    ch0 = sys.argv[1]
    budget = int(sys.argv[2]) if len(sys.argv) > 2 else 9
    fx = FxConsole()
    try:
        fx.goto(ch0)
        print("INIT:", json.dumps(snap(fx))[:200], flush=True)
        fx.click_start()
        t0 = time.time()
        cur = None
        n0 = 0
        t_ch = time.time()
        seen_evts = set()
        while time.time() - t0 < budget * 60:
            time.sleep(5)
            s = snap(fx)
            ck = s.get("ck", [])
            if s.get("cid") != cur:
                if cur is not None:
                    dt = (time.time() - t_ch) / 60
                    print(f"CHAPTER-DONE {cur[:8]}: {len(ck)} sayfa / {dt:.1f}dk = {len(ck)/max(dt,0.01):.1f} sayfa/dk", flush=True)
                cur = s.get("cid")
                n0 = len(ck)
                t_ch = time.time()
                print(f"CHAPTER-START {cur} ck={len(ck)} q={s.get('q')} pd={s.get('pd')}", flush=True)
            for l in fx.logs(None):
                if EVT.search(l):
                    key = l[:120]
                    if key not in seen_evts:
                        seen_evts.add(key)
                        print("EVT:", l[:220], flush=True)
            el = (time.time() - t_ch) / 60
            print(f"[{int(time.time()-t0)}s] ch={str(cur)[:8]} ck={len(ck)} (+{len(ck)-n0}) q={s.get('q')} pd={s.get('pd')} trans={s.get('trans')} le={str(s.get('le'))[:50]} hız={len(ck)/max(el,0.01):.1f}/dk", flush=True)
    finally:
        fx.quit()
    print("DONE", flush=True)

main()
