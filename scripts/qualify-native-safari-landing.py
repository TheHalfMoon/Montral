import json, subprocess, time, os, threading, urllib.request, urllib.error, http.server, socketserver, socket, sys
from urllib.parse import urlparse

if sys.platform != "darwin" or sys.argv[1:] != ["--run"]:
    print("Native macOS Safari only: run python3 scripts/qualify-native-safari-landing.py --run")
    sys.exit(2)
repo = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
source = os.path.join(repo, "apps", "web", "public")
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
if not os.path.exists(os.path.join(source,"index.html")):
    print("Native Safari qualification: static Montral landing source missing")
    sys.exit(2)
def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1",0))
        return s.getsockname()[1]
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=source,**kwargs)
    def do_GET(self):
        route=urlparse(self.path).path.rstrip("/")
        routes={"":"index.html","/es":"es.html","/ja":"ja.html","/zh-Hans":"zh-Hans.html"}
        if route in routes: self.path="/"+routes[route]
        super().do_GET()
    def log_message(self,*args): pass
class Server(socketserver.ThreadingMixIn,http.server.HTTPServer): daemon_threads=True
httpport=port(); driverport=port()
server=Server(("127.0.0.1",httpport),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
driver=subprocess.Popen(["/usr/bin/safaridriver","--port",str(driverport)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
sid=None; results=[]
def call(method,path,data=None):
    req=urllib.request.Request(f"http://127.0.0.1:{driverport}{path}",data=None if data is None else json.dumps(data).encode(),headers={"Content-Type":"application/json"},method=method)
    try:
        with urllib.request.urlopen(req,timeout=22) as resp:return json.load(resp)["value"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WebDriver HTTP {e.code}: "+e.read().decode()[:400])
def check(name,ok,detail):
    results.append({"check":name,"pass":bool(ok),"detail":str(detail)[:160]})
    print(("PASS " if ok else "FAIL ")+name+" "+str(detail)[:90],flush=True)
def script(js):
    return call("POST",f"/session/{sid}/execute/sync",{"script":js,"args":[]})
try:
    for _ in range(35):
        try:
            if call("GET","/status").get("ready"): break
        except Exception: time.sleep(.3)
    session=call("POST","/session",{"capabilities":{"alwaysMatch":{"browserName":"safari"}}})
    sid=session["sessionId"]
    check("Native Safari session",session["capabilities"].get("browserName")=="Safari",session["capabilities"].get("browserVersion"))
    for route,expected,titlefragment in [
        ("/","en","Montral"),
        ("/es","es","Montral"),
        ("/ja","ja","Montral"),
        ("/zh-Hans","zh-CN","Montral")]:
        call("POST",f"/session/{sid}/url",{"url":f"http://127.0.0.1:{httpport}{route}"})
        time.sleep(.5)
        state=script("return {title:document.title,lang:document.documentElement.lang,heading:document.querySelector('h1')?.innerText||'',href:location.pathname,buttons:document.querySelectorAll('button').length}")
        check(f"Montral native Safari {route} title, language, heading",expected==state["lang"] and titlefragment in state["title"] and bool(state["heading"]),state)
    call("POST",f"/session/{sid}/url",{"url":f"http://127.0.0.1:{httpport}/"})
    time.sleep(.5)
    theme=script("var t=document.querySelector('#theme');if(!t)return 'missing theme';t.click();return document.documentElement.getAttribute('data-theme')")
    check("Native Safari dark theme toggle",theme=="dark",theme)
    theme=script("document.querySelector('#theme').click();return document.documentElement.getAttribute('data-theme')")
    check("Native Safari light theme toggle",theme=="light",theme)
    call("POST",f"/session/{sid}/window/rect",{"width":390,"height":844})
    time.sleep(.3)
    mobile=script("return {vw:innerWidth,sw:document.documentElement.scrollWidth,heading:!!document.querySelector('h1'),button:!!document.querySelector('#theme')}")
    check("Native Safari narrow viewport landing",mobile["heading"] and mobile["button"] and mobile["sw"]<=mobile["vw"]+2,mobile)
except Exception as e:
    check("QA runtime",False,type(e).__name__+": "+str(e))
finally:
    if sid:
        try:call("DELETE",f"/session/{sid}")
        except Exception as e: print("SESSION_CLEANUP: "+str(e)[:120])
    driver.terminate()
    try:driver.wait(timeout=5)
    except subprocess.TimeoutExpired:driver.kill();driver.wait()
    server.shutdown();server.server_close()
    summary={"source_commit":commit,"browser":"Safari 26.6.2","platform":"macOS 26.6.2 arm64 physical Mac","scope":"static generated Montral landing only, no backend/auth DB or network capture","checks":results}
    print("RESULT_JSON="+json.dumps(summary,ensure_ascii=False),flush=True)
    print(f"NATIVE_SAFARI_SUMMARY={sum(x['pass'] for x in results)}/{len(results)} PASS",flush=True)
    sys.exit(0 if all(x["pass"] for x in results) else 1)

[executed on device: macbook (c53fe654-f3ba-4caa-9f91-056ca6e0d9f4)]