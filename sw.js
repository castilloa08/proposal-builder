// Minimal offline cache for the S.T.O.P. Proposal Builder.
// Caches the app shell and the pdf-lib script as they're used, so the app
// (including PDF generation) keeps working with no connection after the
// first successful load. API calls are always sent to the network live,
// since cached sync data could otherwise go stale.

const CACHE_NAME = "stop-proposal-builder-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // never cache live sync data

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => cache.match(event.request))
    )
  );
});
