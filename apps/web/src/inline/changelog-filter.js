// Edition filter plus paging: every entry stays in the HTML (search engines, anchors); the page shows the newest ones first.
(function () {
  var PAGE = 15;
  var items = [].slice.call(document.querySelectorAll(".cl-e"));
  var more = document.getElementById("cl-more");
  var filter = "all";
  var shown = PAGE;
  function render() {
    var n = 0, rest = 0;
    items.forEach(function (el) {
      var ok = filter === "all" || el.getAttribute("data-ed") === filter;
      var vis = ok && n < shown;
      if (ok) n++;
      if (ok && !vis) rest++;
      el.hidden = !vis;
    });
    if (more) more.hidden = rest === 0;
  }
  function reveal() {
    var id = decodeURIComponent(location.hash.slice(1));
    var el = id && document.getElementById(id);
    if (el && el.hidden) { shown = items.length; render(); el.scrollIntoView(); }
  }
  var bar = document.querySelector(".cl-bar");
  if (bar) bar.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-f]");
    if (!b) return;
    filter = b.getAttribute("data-f");
    shown = PAGE;
    [].forEach.call(bar.querySelectorAll("button"), function (x) {
      var on = x === b;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", String(on));
    });
    render();
  });
  if (more) more.addEventListener("click", function () { shown += PAGE; render(); });
  window.addEventListener("hashchange", reveal);
  render();
  reveal();
})();
