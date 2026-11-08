// Unlock a password-protected status page, then reload it. The slug and messages come from data attributes, so this
// script's text (and its CSP hash) is the same on every page.
var form = document.getElementById("unlock");
form.addEventListener("submit", async function (e) {
  e.preventDefault();
  var msg = document.getElementById("unlock-msg");
  var btn = form.querySelector("button");
  btn.disabled = true;
  msg.textContent = "";
  try {
    var r = await fetch("/api/public/status/_/unlock", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: form.dataset.slug, password: form.password.value }),
    });
    if (r.status === 204) { location.reload(); return; }
    msg.textContent = r.status === 429 ? form.dataset.slow : form.dataset.wrong;
    form.password.value = "";
    form.password.focus();
  } catch (x) {
    msg.textContent = form.dataset.wrong;
  }
  btn.disabled = false;
});
