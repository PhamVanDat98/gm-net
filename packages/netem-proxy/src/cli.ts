/**
 * CLI netem-proxy — chạy proxy giả lập mạng từ dòng lệnh (bài nghiệm thu
 * Phase 1: 200ms RTT + 5% loss = `--delay 100 --drop 0.05`).
 *
 *   pnpm --filter @gm-net/netem-proxy cli -- --listen 2568 --target 2567 --delay 100 --drop 0.05
 */
import { createNetemProxy } from './index.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const listenPort = Number(arg('listen', '2568'));
const targetPort = Number(arg('target', '2567'));
const targetHost = arg('host', '127.0.0.1')!;
const delayMs = Number(arg('delay', '100')); // mỗi chiều → RTT +2×delay
const dropRate = Number(arg('drop', '0.05'));

const proxy = createNetemProxy({ listenPort, targetHost, targetPort, delayMs, dropRate });
const port = await proxy.listen();
console.log(
  `[netem-proxy] ws://127.0.0.1:${port} → ws://${targetHost}:${targetPort} | delay ${delayMs}ms/chiều (RTT +${2 * delayMs}ms) | drop ${(dropRate * 100).toFixed(1)}%`,
);
setInterval(() => {
  const s = proxy.stats();
  console.log(
    `[netem-proxy] fwd →S ${s.forwarded.toServer} →C ${s.forwarded.toClient} | drop →S ${s.dropped.toServer} →C ${s.dropped.toClient} | conn ${s.connections}`,
  );
}, 5000).unref();
