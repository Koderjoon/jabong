// 전치25 서비스 워커: 브라우저가 "앱 설치"를 띄우는 데 필요한 최소한만 한다.
// 아무것도 캐시하지 않는다 — 화면과 데이터는 늘 서버의 최신 것이다.
// 페이지 이동만 거쳐 가고, 인터넷이 끊겼을 때만 안내 화면을 보여 준다. 서버(Supabase) 요청은 건드리지 않는다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const OFFLINE = '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>전치25</title><body style="font-family:system-ui,sans-serif;padding:32px 20px;color:#333"><h1 style="font-size:20px">인터넷에 연결되지 않았어요</h1><p>연결된 뒤 다시 열어 주세요.</p></body></html>';
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
