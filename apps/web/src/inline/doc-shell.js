// Signed in: the header's "Sign in" becomes a link to the app.
(function () {
  fetch("/api/me", { credentials: "include" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    var a = document.querySelector(".doc-signin");
    if (!d || !d.user || !a) return;
    a.href = "/app";
    a.innerHTML = '<span lang="en">Dashboard</span><span lang="zh-CN">进入控制台</span>';
    a.title = d.user.email || "";
  }).catch(function () {});
})();
// Our own status page, when it exists.
(function () {
  var zh = document.documentElement.lang === "zh-CN";
  var txt = { operational: zh ? "所有系统运行正常" : "All systems operational", degraded: zh ? "部分服务降级" : "Partial degradation", outage: zh ? "服务中断" : "Major outage" };
  fetch("/api/public/status/montral").then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !txt[d.overall]) return;
    var a = document.getElementById("sf-status");
    a.className = "sf-status " + d.overall;
    document.getElementById("sf-status-t").textContent = txt[d.overall];
    a.hidden = false;
    var l = document.getElementById("sf-status-link");
    if (l) l.hidden = false;
  }).catch(function () {});
})();
// The examples name the hosted domain; on any other deployment they show this site's own address.
(function () {
  var host = "https://montral.invalid";
  if (location.origin === host) return;
  var w = document.createTreeWalker(document.querySelector("main.doc") || document.body, NodeFilter.SHOW_TEXT);
  var n;
  while ((n = w.nextNode())) {
    if (n.nodeValue.indexOf(host) >= 0) n.nodeValue = n.nodeValue.split(host).join(location.origin);
  }
})();
// Tiny syntax highlighter for the <pre> samples (curl commands, JSON, pseudo-schemas).
(function () {
  var esc = function (t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var re = /("(?:\\.|[^"\\\n])*"|'(?:[^'\n])*')(\s*:)?|(#[^\n]*)|(\b(?:true|false|null)\b)|(\b\d[\d.]*\b)|(^|\s)(-[A-Za-z]|--[a-z-]+)(?=\s)|\b(curl|GET|POST|PATCH|DELETE)\b|(\.\.\.)/gm;
  document.querySelectorAll(".doc pre code").forEach(function (el) {
    var src = el.textContent || "";
    var out = "", last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      var cls, txt = m[0];
      if (m[1]) { cls = m[2] ? "hk" : "hs"; out += '<span class="' + cls + '">' + esc(m[1]) + "</span>" + (m[2] ? esc(m[2]) : ""); last = re.lastIndex; continue; }
      if (m[3]) cls = "hc";
      else if (m[4]) cls = "hn";
      else if (m[5]) cls = "hn";
      else if (m[7]) { out += esc(m[6]) + '<span class="hf">' + esc(m[7]) + "</span>"; last = re.lastIndex; continue; }
      else if (m[8]) cls = "hf";
      else cls = "hc";
      out += '<span class="' + cls + '">' + esc(txt) + "</span>";
      last = re.lastIndex;
    }
    el.innerHTML = out + esc(src.slice(last));
  });
})();
(function () {
  var box = document.getElementById("doc-toc");
  if (!box) return;
  var hs = [].filter.call(document.querySelectorAll(".doc h2[id]"), function (h) { return h.getClientRects().length; });
  hs.forEach(function (h) {
    var a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = h.innerText.trim();
    box.appendChild(a);
  });
  if (!hs.length) { box.remove(); return; }
  var links = [].slice.call(box.querySelectorAll("a"));
  var mark = function () {
    var cur = 0;
    hs.forEach(function (h, i) { if (h.getBoundingClientRect().top < 120) cur = i; });
    links.forEach(function (a, i) { a.classList.toggle("on", i === cur); });
  };
  addEventListener("scroll", mark, { passive: true });
  mark();
})();
(function () {
  var btn = document.getElementById("lang"), menu = document.getElementById("lang-menu");
  if (!btn || !menu) return;
  var cur = document.documentElement.lang;
  menu.querySelectorAll("a").forEach(function (b) {
    var on = b.dataset.l === cur;
    b.setAttribute("aria-checked", String(on));
    if (on) document.getElementById("lang-cur").textContent = b.textContent;
  });
  function close() { menu.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }
  btn.addEventListener("click", function (e) { e.stopPropagation(); btn.setAttribute("aria-expanded", String(menu.classList.toggle("open"))); });
  menu.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-l]");
    if (!a) return;
    var l = a.dataset.l;
    document.cookie = "montral_lang=" + l + ";path=/;max-age=31536000;samesite=lax";
    // the link then navigates by itself; English and Chinese also keep the query and the section you are on
    if (l === "en" || l === "zh-CN") a.href = a.getAttribute("href").split(/[?#]/)[0] + location.search + location.hash;
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
})();
// Keyboard users must be able to scroll code samples and wide tables that overflow (WCAG 2.1.1): exactly the
// overflowing ones join the tab order, re-checked when the viewport changes.
(function () {
  var mark = function () {
    document.querySelectorAll(".doc pre, .doc table").forEach(function (el) {
      if (el.scrollWidth > el.clientWidth + 1) el.setAttribute("tabindex", "0");
      else if (el.getAttribute("tabindex") === "0") el.removeAttribute("tabindex");
    });
  };
  mark();
  addEventListener("resize", mark);
})();
