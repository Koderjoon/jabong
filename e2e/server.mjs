// 브라우저 테스트용 가짜 Supabase.
// /rest/v1/rpc/<함수> 요청을 로컬 Postgres 함수 호출로 바꿔 anon 역할로 실행하고(Supabase의 PostgREST와 같은 권한),
// 그 밖의 경로에는 빌드한 화면(dist)을 준다. Realtime(웹소켓)은 흉내 내지 않는다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export function startServer({ port, dist, database }) {
  const pool = new pg.Pool({ database });
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const m = req.url.match(/^\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) {
      let body = '';
      for await (const c of req) body += c;
      const args = body ? JSON.parse(body) : {};
      const keys = Object.keys(args);
      // uuid[] 인자(p_sids)는 Postgres 배열로, 나머지 객체·배열은 jsonb로 넘긴다
      const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && k !== 'p_sids' ? JSON.stringify(args[k]) : args[k]));
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role anon');
        // Supabase는 앱(anon)의 요청을 약 3초에 끊는다
        await client.query("set local statement_timeout = '3s'");
        const r = await client.query(`select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, vals);
        await client.query('commit');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.rows[0].r));
      } catch (e) {
        await client.query('rollback').catch(() => {});
        res.writeHead(e.code === '42883' ? 404 : 400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: e.code, message: e.message, details: null, hint: null }));
      } finally {
        client.release();
      }
      return;
    }
    let f = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  // Realtime 웹소켓 연결은 바로 끊는다 (앱은 알림 없이도 동작해야 한다)
  server.on('upgrade', (req, socket) => socket.destroy());
  return new Promise((resolve) =>
    server.listen(port, () =>
      resolve({
        close: async () => {
          server.closeAllConnections?.();
          await new Promise((r) => server.close(r));
          await pool.end();
        },
      }),
    ),
  );
}
