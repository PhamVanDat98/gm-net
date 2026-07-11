# Multiplayer Framework — Tài liệu khởi tạo dự án

Framework multiplayer cho game JS 2D & 3D: server-authoritative physics, client-side prediction, server reconciliation, snapshot interpolation. Render-agnostic.

---

## 1. Kiến trúc tổng thể

```
┌─────────────┐         ┌──────────────────┐
│  Matchmaker  │◄──────►│  Redis            │
│  (stateless) │         │  (queue/registry) │
└──────┬──────┘         └──────────────────┘
       │ assign room
       ▼
┌─────────────────────────────┐
│  Game Servers (stateful)     │
│  - Room lifecycle (Colyseus) │
│  - Fixed-tick physics loop   │
│  - Binary snapshot broadcast │
└──────┬──────────────────────┘
       │ WebSocket (binary)
       ▼
┌─────────────────────────────┐
│  Client                      │
│  - Prediction (local player) │
│  - Reconciliation            │
│  - Interpolation (remote)    │
│  - Render adapter (Pixi/Three/Unity WebGL) │
└─────────────────────────────┘
```

**Nguyên tắc cốt lõi:**
- Simulation logic nằm trong package `shared`, import cả client lẫn server → đảm bảo prediction khớp authoritative simulation.
- Physics engine: **Rapier** (WASM) — cùng binary chạy Node + browser, có `takeSnapshot()/restoreSnapshot()` cho reconciliation.
- Core netcode **không phụ thuộc** matchmaker và render — hai thứ này là optional/pluggable.

---

## 2. Cấu trúc monorepo

```
gm-net/
├── packages/
│   ├── core/           # netcode: prediction, reconciliation,
│   │                   # interpolation, clock sync, serialization
│   ├── physics-2d/     # adapter @dimforge/rapier2d
│   ├── physics-3d/     # adapter @dimforge/rapier3d
│   ├── shared/         # simulation logic, input schema, constants
│   ├── server/         # room framework (trên Colyseus), tick loop,
│   │                   # lag compensation, AOI
│   ├── client/         # client runtime, headless mode (bot/load test)
│   └── matchmaker/     # optional: queue, server registry (Redis)
├── examples/
│   ├── demo-2d/        # game test kiểu top-down shooter
│   └── demo-3d/        # port sau khi 2D ổn định
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Tooling: **pnpm workspaces + TypeScript**, build bằng tsup/esbuild, test bằng vitest.

---

## 3. Tech stack

| Thành phần | Lựa chọn | Ghi chú |
|---|---|---|
| Physics | Rapier 2D/3D (WASM) | Chung API 2D/3D, snapshot built-in, flag `enhanced-determinism` |
| Transport | WebSocket qua uWebSockets.js | Nhanh hơn `ws` nhiều lần; expose trực tiếp, không proxy qua Cloudflare |
| Room framework | Colyseus | Dùng room lifecycle + seat reservation; **bypass schema sync**, gửi snapshot binary qua `sendBytes()` |
| Serialization | Tự viết bit-packing (`DataView`/`ArrayBuffer`) | Quantize position (16-bit fixed point), delta compression |
| Runtime | Node.js | Bun là option thử nghiệm sau |
| Matchmaker | Node + Redis | Queue, pub/sub, server registry; REST/WS endpoint riêng |
| Client render | Agnostic | Core expose interpolated state; adapter mẫu cho Pixi/Three |

---

## 4. Tính năng theo phase

### Phase 1 — Core netcode (2D)
- [ ] Fixed timestep loop (server 30Hz sim, client 60Hz render)
- [ ] Input schema + input buffer (client gửi input kèm sequence number)
- [ ] Client-side prediction cho local player
- [ ] Server reconciliation: ring buffer snapshot Rapier (~1s), restore + replay input
- [ ] Snapshot interpolation cho remote entities (render delay ~100ms)
- [ ] Binary serialization + quantization
- [ ] Clock sync + RTT estimation, adaptive input buffer

### Phase 2 — Production features
- [ ] Delta compression (chỉ gửi field thay đổi so với baseline đã ack)
- [ ] Lag compensation server-side (position history ~1s, rewind khi hit detection)
- [ ] Interest management / AOI (grid hoặc quadtree)
- [ ] Reconnection + state resync (grace period giữ session)
- [ ] Headless client API — bot fill room + load testing

### Phase 3 — Mở rộng
- [ ] Port sang 3D (rapier3d, core netcode giữ nguyên)
- [ ] Matchmaker service (queue, skill-based optional, server allocation)
- [ ] Metrics: tick duration, mispredictions/s, bandwidth/client
- [ ] Replay recording (log input + seed)
- [ ] Spectator mode

---

## 5. Các quyết định kỹ thuật quan trọng (đã chốt)

1. **Rapier thay vì Planck/Matter/cannon-es** — vì reconciliation cần snapshot/restore toàn bộ world state (bao gồm contact cache, solver warm-start, sleeping state). Engine JS thuần không serialize được state ẩn → misprediction giả, correction loop.
2. **Không cần bit-perfect determinism** — server-authoritative + prediction chỉ cần "gần deterministic", reconciliation tự sửa sai số nhỏ. Determinism tuyệt đối chỉ cần cho lockstep/rollback.
3. **Matchmaker tách khỏi core** — game room stateful (sticky process), matchmaker stateless (scale khác nhau). Giao tiếp qua Redis. Framework dùng được mà không cần matchmaker.
4. **Dùng Colyseus cho room management, bypass schema sync** — tiết kiệm thời gian room lifecycle nhưng schema của Colyseus không tối ưu cho physics snapshot 30Hz.
5. **Snapshot strategy**: ring buffer `takeSnapshot()` (Uint8Array, memcpy-fast) giới hạn ~1 giây; với world lớn cân nhắc snapshot thủ công chỉ dynamic bodies quan trọng.
6. **Render tách khỏi framework** — core chỉ expose interpolated state.

---

## 6. Bước khởi động (tuần đầu)

1. `pnpm init` monorepo, scaffold packages, tsconfig references.
2. Spike: Rapier2D chạy trên Node + browser, verify `takeSnapshot/restoreSnapshot` cho kết quả replay identical.
3. Viết fixed timestep loop + input sequence protocol (chưa cần physics).
4. Demo tối giản: 1 box di chuyển, prediction + reconciliation hoạt động, đo misprediction khi giả lập lag (dùng `tc netem` hoặc proxy delay).
5. Benchmark: snapshot size & thời gian restore với 50/200/500 bodies.

**Định nghĩa "core hoạt động"**: chơi được demo 2D với 200ms RTT giả lập + 5% packet loss mà local player không giật, remote players mượt.
