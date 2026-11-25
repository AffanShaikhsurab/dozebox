// The wake page and its Home Screen app files (part 5 §5.3): `GET /`, `/manifest.webmanifest`, `/sw.js`,
// `/icons/icon.svg`. Public: they hold no secret. The token arrives in the URL fragment (`#t=<token>`), which
// browsers never send to a server; the script moves it into this origin's storage, strips it from the address bar,
// and sends it only in the `x-dozebox-token` header. Everything rendered goes through `textContent`, so a hostile
// status string cannot inject markup. The CSP pins the inline script and style by SHA-256 (no `unsafe-inline`).
import { createHash } from "node:crypto";
import type { FunctionUrlResult } from "../event.ts";
import { respond } from "../respond.ts";

const STYLE = `:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}
main{width:min(30rem,92vw);padding:1.5rem}
h1{font-size:1.25rem;margin:0 0 1rem}
#state{font-size:1.5rem;font-weight:600;margin:0}
#detail{margin:.25rem 0 1.25rem;opacity:.75;overflow-wrap:anywhere}
button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem;border-radius:.5rem;border:1px solid currentColor;background:none;color:inherit;cursor:pointer}
button[disabled]{opacity:.4;cursor:default}`;

const SCRIPT = `(function () {
  var KEY = "dozebox.token";
  var memory = "";
  var timer = null;
  var stateEl = document.getElementById("state");
  var detailEl = document.getElementById("detail");
  var wakeBtn = document.getElementById("wake");
  var parkBtn = document.getElementById("park");
  function readStored() { try { return localStorage.getItem(KEY) || memory; } catch (e) { return memory; } }
  function writeStored(v) {
    memory = v;
    try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* memory only */ }
  }
  var hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("t")) { writeStored(hash.get("t")); history.replaceState(null, "", location.pathname + location.search); }
  var token = readStored();
  function show(state, detail, actions) {
    stateEl.textContent = state;
    detailEl.textContent = detail || "";
    wakeBtn.disabled = actions.indexOf("wake") < 0;
    parkBtn.disabled = actions.indexOf("park") < 0;
  }
  function call(path, method) {
    var headers = { "x-dozebox-token": token };
    if (method === "POST") headers["idempotency-key"] = "page-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    return fetch(new URL(path, location.href), { method: method, headers: headers, cache: "no-store" });
  }
  function render(body) {
    var s = body.summary || {};
    var detail = [s.detail, s.next].filter(Boolean).join(" ");
    show(s.headline || body.state || "Unknown", detail, Array.isArray(s.actions) ? s.actions : []);
  }
  function handle(res) {
    if (res.status === 401) { writeStored(""); token = ""; show("Token rejected", "Open the link printed by setup or status.", []); return null; }
    return res.json().then(function (body) {
      if (res.ok) return render(body);
      var e = body && body.error ? body.error : {};
      show("Not done", e.message || ("HTTP " + res.status), ["wake", "park"]);
    });
  }
  function fail() { show("Status unknown", "Could not reach the control endpoint.", []); }
  function refresh() {
    if (!token) { show("No token", "Open the link printed by setup or status.", []); return Promise.resolve(); }
    return call("v1/status", "GET").then(handle).catch(fail);
  }
  function schedule() {
    clearInterval(timer);
    timer = null;
    if (document.visibilityState === "visible") { refresh(); timer = setInterval(refresh, 10000); }
  }
  function act(path) { return function () { wakeBtn.disabled = true; parkBtn.disabled = true; call(path, "POST").then(handle).catch(fail); }; }
  wakeBtn.addEventListener("click", act("v1/wake"));
  parkBtn.addEventListener("click", act("v1/park"));
  document.addEventListener("visibilitychange", schedule);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  schedule();
})();`;

/** Caches the page shell so the Home Screen app opens offline; never caches the API. */
const SERVICE_WORKER = `const SHELL = "dozebox-shell-v1";
const FILES = ["./", "./manifest.webmanifest", "./icons/icon.svg"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES))));
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))),
);
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/v1/")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
`;

const MANIFEST = JSON.stringify({
  name: "Cloud box",
  short_name: "Box",
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#1f2937",
  icons: [{ src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f2937"/><path d="M40 16a18 18 0 1 0 8 30 14 14 0 0 1-8-30z" fill="#facc15"/></svg>`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${hash(SCRIPT)}`,
  `style-src ${hash(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<title>Cloud box</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Cloud box</h1>
<p id="state">Loading\u2026</p>
<p id="detail"></p>
<button id="wake" type="button" disabled>Wake</button><button id="park" type="button" disabled>Park</button>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

const ASSETS: Readonly<Record<string, { readonly type: string; readonly body: string; readonly csp?: string }>> = {
  "/": { type: "text/html; charset=utf-8", body: PAGE_HTML, csp: PAGE_CSP },
  "/manifest.webmanifest": { type: "application/manifest+json", body: MANIFEST },
  "/sw.js": { type: "text/javascript; charset=utf-8", body: SERVICE_WORKER },
  "/icons/icon.svg": { type: "image/svg+xml", body: ICON },
};

/** The public asset at `path` for a GET, or null. */
export function publicAsset(method: string, path: string): FunctionUrlResult | null {
  const asset = method === "GET" ? ASSETS[path] : undefined;
  if (asset === undefined) return null;
  return respond(200, asset.body, {
    "content-type": asset.type,
    ...(asset.csp === undefined ? {} : { "content-security-policy": asset.csp }),
  });
}
