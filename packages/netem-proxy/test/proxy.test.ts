/**
 * netem-proxy (IMPLEMENTATION 5.3): delay mỗi chiều, drop theo tỉ lệ (PRNG
 * seed → tái lập), grace window không drop, forward HTTP (matchmaking).
 * Test dùng socket thật trên loopback — thời lượng giữ ngắn.
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createNetemProxy, type NetemProxy } from '../src/index.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Echo server WS trên port ephemeral. */
function startEchoServer(): Promise<{ port: number; wss: WebSocketServer }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      resolve({ port: (wss.address() as { port: number }).port, wss });
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => ws.send(data as Buffer, { binary: isBinary }));
    });
    cleanups.push(() => new Promise((r) => wss.close(() => r())));
  });
}

async function startProxy(opts: Omit<Parameters<typeof createNetemProxy>[0], 'listenPort'>): Promise<NetemProxy> {
  const proxy = createNetemProxy({ listenPort: 0, ...opts });
  await proxy.listen();
  cleanups.push(() => proxy.close());
  return proxy;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    cleanups.push(() => ws.terminate());
  });
}

describe('netem-proxy', () => {
  it('chèn delay mỗi chiều: echo round-trip ≥ tổng hai chiều', async () => {
    const { port } = await startEchoServer();
    const proxy = await startProxy({ targetPort: port, delayMs: 60 });
    const ws = await connect(proxy.port);

    const t0 = Date.now();
    const rtt = await new Promise<number>((resolve) => {
      ws.once('message', () => resolve(Date.now() - t0));
      ws.send('ping');
    });
    expect(rtt).toBeGreaterThanOrEqual(110); // 2×60ms − sai số timer Windows
    expect(rtt).toBeLessThan(500);
  });

  it('drop theo tỉ lệ (seed tái lập), forwarded + dropped = tổng gửi', async () => {
    const { port } = await startEchoServer();
    const proxy = await startProxy({ targetPort: port, dropRate: 0.5, graceMs: 0, seed: 42 });
    const ws = await connect(proxy.port);

    const N = 200;
    let received = 0;
    ws.on('message', () => received++);
    for (let i = 0; i < N; i++) ws.send(`m${i}`);
    // Chờ ống rỗng: echo hai chiều, không delay → 300ms là dư.
    await new Promise((r) => setTimeout(r, 300));

    const s = proxy.stats();
    expect(s.forwarded.toServer + s.dropped.toServer).toBe(N);
    // Mỗi chiều xúc xắc riêng: ~50% ± biên rộng (PRNG cố định nên ổn định).
    expect(s.dropped.toServer).toBeGreaterThan(N * 0.3);
    expect(s.dropped.toServer).toBeLessThan(N * 0.7);
    // Chiều về chỉ thấy message đã sống sót chiều đi.
    expect(s.forwarded.toClient + s.dropped.toClient).toBe(s.forwarded.toServer);
    expect(received).toBe(s.forwarded.toClient);
  });

  it('grace window đầu kết nối không drop (join/handshake an toàn)', async () => {
    const { port } = await startEchoServer();
    const proxy = await startProxy({ targetPort: port, dropRate: 1, graceMs: 60_000 });
    const ws = await connect(proxy.port);

    let received = 0;
    ws.on('message', () => received++);
    for (let i = 0; i < 20; i++) ws.send(`m${i}`);
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toBe(20);
    expect(proxy.stats().dropped.toServer).toBe(0);
  });

  it('forward HTTP thường (matchmaking) nguyên vẹn', async () => {
    const httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((r) => httpServer.listen(0, () => r()));
    cleanups.push(() => new Promise((r) => httpServer.close(() => r())));
    const port = (httpServer.address() as { port: number }).port;

    const proxy = await startProxy({ targetPort: port });
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxy.port}/matchmake/joinOrCreate/game`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    expect(JSON.parse(body)).toEqual({ path: '/matchmake/joinOrCreate/game' });
  });
});
