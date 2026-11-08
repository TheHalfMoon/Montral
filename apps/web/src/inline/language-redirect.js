// Language comes from the URL (/zh-Hans/...); English is unprefixed. A visit remembers the choice in `montral_lang`,
// and later visits to an unprefixed page jump to the remembered language. Without a remembered choice the page
// stays English: the browser language is never used to move a visitor.
try {
  var lm = document.cookie.match(/(?:^|; )montral_lang=([^;]+)/);
  var ck = lm ? lm[1] : "";
  var pm = location.pathname.match(/^\/(zh-Hans|ja|es)(?=\/|$)/);
  var lg = "en";
  if (pm) {
    lg = pm[1] === "zh-Hans" ? "zh-CN" : "en";
    if (ck !== "zh-CN" && pm[1] === "zh-Hans") document.cookie = "montral_lang=zh-CN;path=/;max-age=31536000;samesite=lax";
  } else {
    var pub = /^\/status(\/|$)/.test(location.pathname);
    lg = pub ? "en" : ck === "zh-CN" ? "zh-CN" : "en";
    if (lg === "zh-CN") {
      location.replace("/zh-Hans" + (location.pathname === "/" ? "" : location.pathname) + location.search + location.hash);
    }
    if (lg !== "zh-CN") lg = "en";
  }
  document.documentElement.lang = lg;
  if (pm && pm[1] === "zh-Hans") {
    // links written as /app, /login ... keep the visitor inside their language; a link with hreflang (the language
    // menu) already names its language
    var skip = /^\/(zh-Hans|ja|es|api|_astro)(\/|$|\?|#)|\.[a-z0-9]+([?#]|$)/i;
    var fix = function (a) {
      var h = a.getAttribute("href");
      if (h && !a.hasAttribute("hreflang") && h.charAt(0) === "/" && h.charAt(1) !== "/" && !skip.test(h)) a.setAttribute("href", "/zh-Hans" + (h === "/" ? "" : h));
    };
    var sweep = function (n) {
      if (n.nodeType !== 1) return;
      if (n.tagName === "A") fix(n);
      var l = n.querySelectorAll ? n.querySelectorAll("a[href]") : [];
      for (var i = 0; i < l.length; i++) fix(l[i]);
    };
    new MutationObserver(function (ms) {
      ms.forEach(function (r) {
        if (r.type === "attributes") fix(r.target);
        else r.addedNodes.forEach(sweep);
      });
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    document.addEventListener("DOMContentLoaded", function () { sweep(document.documentElement); });
  }
} catch (e) {}
try {
  var th = localStorage.getItem("montral_theme");
  if (th) document.documentElement.dataset.theme = th;
} catch (e) {}
// soft navigation replaces <html>'s attributes: carry the theme over
document.addEventListener("astro:before-swap", function (e) {
  try {
    var t = localStorage.getItem("montral_theme");
    if (t) e.newDocument.documentElement.dataset.theme = t;
  } catch (err) {}
});
