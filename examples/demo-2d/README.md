# demo-2d — nghiệm thu Phase 1

Demo box top-down 2+ người chơi: local player prediction + reconciliation, remote
interpolation ~100ms, HUD RTT/misprediction/correction. Canvas 2D thuần, Rapier
`-compat` chạy WASM ngay trong browser.

## Chạy

```sh
pnpm --filter demo-2d server   # game server ws://localhost:2567
pnpm --filter demo-2d dev      # vite → http://localhost:5173
```

Mở nhiều tab để thấy nhiều box. Di chuyển bằng WASD / phím mũi tên.

## Bài nghiệm thu Phase 1 ([008 §1](../../docs/design/008-roadmap.md))

Chạy thêm proxy giả lập mạng xấu (RTT +200ms, drop 5% mỗi chiều):

```sh
pnpm --filter demo-2d proxy    # ws://localhost:2568 → 2567
```

rồi trỏ trang vào proxy:

```
http://localhost:5173/?server=ws://localhost:2568
```

Tiêu chí: local không giật (misprediction/s ~0 khi không va chạm), remote mượt
(không teleport, `buffer cạn` trên HUD < 1%). Bản tự động của bài này chạy trong
[test/e2e.test.ts](test/e2e.test.ts) (server thật + 2 client headless qua proxy).
