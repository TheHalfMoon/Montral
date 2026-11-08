// Values come from the JSON block below, so this script's text (and its CSP hash) is the same on every page.
const { slug, sending, ok, bad, slow } = JSON.parse(document.getElementById("sub-vars").textContent);
document.getElementById("sub").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("sub-msg");
  const btn = e.target.querySelector("button");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = sending;
  msg.textContent = "";
  try {
    const r = await fetch(`/api/public/status/${slug}/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e.target.email.value, monitorIds: [...e.target.querySelectorAll("input[name=monitorId]:checked")].map((x) => x.value) }) });
    msg.textContent = r.ok ? ok : r.status === 429 ? slow : bad;
    if (r.ok) e.target.reset();
  } catch { msg.textContent = bad; }
  btn.disabled = false;
  btn.textContent = label;
});
