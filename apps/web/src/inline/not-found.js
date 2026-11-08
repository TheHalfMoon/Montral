var p = location.pathname.replace(/^\/zh-Hans(?=\/|$)/, "") || "/";
if (p.length > 60) p = p.slice(0, 57) + "...";
["nf-path", "nf-path-zh"].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = p; });
