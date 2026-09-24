#!/usr/bin/env python3
"""Firefox konsol köprüsü: headless Firefox + XPI + sayfa console'u stdout'tan yakalar.
Kopyala-yapıştır yok: log oku, JS çalıştır, durumu sorgula — hepsi buradan.

Kullanım:
  python3 tools/fxconsole.py smoke [sn]        # ch1 aç, başlat, log+durum akıt
  python3 tools/fxconsole.py jump              # ch1 başlat -> ch60 atla, devamı doğrula
  python3 tools/fxconsole.py eval "<JS>"       # sayfada JS çalıştır, sonucu yazdır
  python3 tools/fxconsole.py watch <sn> [flt]  # sadece konsolu akıt (filtreli)
  python3 tools/fxconsole.py tessbtn [sn]      # tesseract G düğmesi akışı

  Headed (gerçek pencere, sanal ekran): MGC_HEADED=1 DISPLAY=:99 python3 tools/fxconsole.py smoke
  Sanal ekran: Xvfb :99 -screen 0 1366x768x24 &   (kullanıcının :0 ekranına dokunmaz)
"""
import sys, time, os, re, json, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
XPI = os.path.join(os.path.dirname(HERE), "mangadex-injected-translate.xpi")
CH1_FALLBACK = "25e40892-8de2-4f16-93b5-68840deec39a"

def feed_ids(limit=65):
    url = ("https://api.mangadex.org/manga/35e4b0aa-4c17-4b72-aec9-39f646ef657d/feed"
           f"?limit={limit}&translatedLanguage[]=en&order[chapter]=asc")
    with urllib.request.urlopen(url, timeout=20) as r:
        j = json.load(r)
    return [d["id"] for d in j["data"]]

class FxConsole:
    def __init__(self, log_path="/tmp/fxconsole.gecko.log"):
        from selenium import webdriver
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.firefox.service import Service
        from selenium.webdriver.firefox.firefox_profile import FirefoxProfile
        if os.path.exists(log_path):
            os.remove(log_path)
        self.log_path = log_path
        self.headed = os.environ.get("MGC_HEADED") == "1"
        fp = FirefoxProfile()
        fp.set_preference("devtools.console.stdout.content", True)
        o = Options()
        if not self.headed:
            o.add_argument("-headless")
        o.profile = fp
        s = Service(executable_path="/usr/bin/geckodriver", log_output=log_path)
        self.d = webdriver.Firefox(options=o, service=s)
        try:
            self.d.install_addon(os.path.abspath(XPI), temporary=True)
        except Exception as e:
            print("XPI kurulum uyarısı:", e, flush=True)
        time.sleep(2)
        if self.headed:
            try:
                self.d.set_window_size(1366, 768)
            except Exception:
                pass
        self.d.set_page_load_timeout(25)
        self._pos = 0

    def goto(self, chapter_id):
        try:
            self.d.get(f"https://mangadex.org/chapter/{chapter_id}")
        except Exception:
            pass
        time.sleep(10)

    def js(self, expr):
        return self.d.execute_script(f"return ({expr})")

    def click_start(self):
        self.js("document.getElementById('mgc-hud-start').click()")

    def state(self):
        try:
            return self.js(
                "({started:document.documentElement.dataset.mgcStarted,"
                "cid:document.documentElement.dataset.mgcCid,"
                "dbg:document.documentElement.dataset.mgcDbg||'',"
                "trans:document.querySelectorAll('img[data-mgc-translated]').length})")
        except Exception as e:
            return {"driver_err": str(e)[:100]}

    def logs(self, pattern=None):
        out = []
        try:
            with open(self.log_path, encoding="utf-8", errors="replace") as f:
                f.seek(self._pos)
                for line in f:
                    m = re.match(r'console\.(log|warn|error|info|debug): (.*)', line.rstrip("\n"))
                    if m:
                        lvl, msg = m.group(1), m.group(2)
                        if pattern and not re.search(pattern, msg):
                            continue
                        out.append(f"[{lvl}] {msg}")
                self._pos = f.tell()
        except FileNotFoundError:
            pass
        return out

    def quit(self):
        try:
            self.d.quit()
        except Exception:
            pass

def cmd_smoke(secs=60):
    fx = FxConsole()
    try:
        ids = feed_ids()
        ch1 = ids[0]
    except Exception:
        ch1 = CH1_FALLBACK
    fx.goto(ch1)
    print("INIT:", json.dumps(fx.state()), flush=True)
    fx.click_start()
    t0 = time.time()
    while time.time() - t0 < secs:
        time.sleep(5)
        for l in fx.logs(r"MGC|Error|error"):
            print(l[:300], flush=True)
        print("STATE:", json.dumps(fx.state()), flush=True)
        st = fx.state()
        try:
            if json.loads(st.get("dbg", "{}")).get("ck"):
                if st.get("trans", 0) >= 1:
                    break
        except Exception:
            pass
    fx.quit()

def cmd_jump():
    fx = FxConsole()
    try:
        ids = feed_ids()
        ch1, ch60 = ids[0], ids[59]
    except Exception:
        print("feed alınamadı", flush=True)
        fx.quit()
        return
    fx.goto(ch1)
    fx.click_start()
    time.sleep(30)
    print("CH1:", json.dumps(fx.state()), flush=True)
    fx.goto(ch60)
    for _ in range(12):
        time.sleep(5)
        st = fx.state()
        print("CH60:", json.dumps(st), flush=True)
        for l in fx.logs(r"MGC"):
            print(l[:300], flush=True)
        if st.get("started") == "1" and st.get("cid") == ch60:
            break
    fx.quit()

def cmd_eval(expr):
    fx = FxConsole()
    try:
        ids = feed_ids(5)
        fx.goto(ids[0])
        print(json.dumps(fx.js(expr), ensure_ascii=False, default=str)[:2000], flush=True)
    finally:
        fx.quit()

def cmd_watch(secs, pattern=None):
    fx = FxConsole()
    try:
        ids = feed_ids(5)
        fx.goto(ids[0])
        t0 = time.time()
        while time.time() - t0 < int(secs):
            time.sleep(3)
            for l in fx.logs(pattern):
                print(l[:300], flush=True)
    finally:
        fx.quit()

def cmd_tessbtn(secs=560):
    # Tesseract modu + en küçük görselin G düğmesi, blok/çeviri örneklerini yakala
    fx = FxConsole()
    try:
        ids = feed_ids(5)
        fx.goto(ids[0])
        fx.js("(()=>{const s=document.getElementById('mgc-mode');s.value='tesseract';s.dispatchEvent(new Event('change'));})()")
        time.sleep(2)
        n = fx.js("(()=>{const btns=[...document.querySelectorAll('.mgc-translate-btn')];btns.sort((a,b)=>{const ai=a.parentElement?.querySelector('img'),bi=b.parentElement?.querySelector('img');return (ai?.naturalWidth||9e9)-(bi?.naturalWidth||9e9);});btns[0].click();return btns.length;})()")
        print("BTNS:", n, flush=True)
        t0 = time.time()
        while time.time() - t0 < int(secs):
            time.sleep(5)
            for l in fx.logs(r"MGC|tesseract|❌|Hata|hata"):
                print(l[:400], flush=True)
            st = fx.state()
            cv = fx.js("document.querySelectorAll('canvas.mgc-canvas-overlay').length")
            print("BTN-STATE trans=", st.get("trans"), "canvas=", cv, flush=True)
            if st.get("trans", 0) >= 1 or (cv or 0) >= 1:
                print("PASS-TESSBTN", flush=True)
                break
    finally:
        fx.quit()

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "smoke"
    if cmd == "smoke":
        cmd_smoke(int(sys.argv[2]) if len(sys.argv) > 2 else 60)
    elif cmd == "jump":
        cmd_jump()
    elif cmd == "eval":
        cmd_eval(sys.argv[2] if len(sys.argv) > 2 else "location.href")
    elif cmd == "watch":
        cmd_watch(sys.argv[2] if len(sys.argv) > 2 else 60,
                  sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "tessbtn":
        cmd_tessbtn(sys.argv[2] if len(sys.argv) > 2 else 560)
    else:
        print(__doc__)
    print("DONE", flush=True)
