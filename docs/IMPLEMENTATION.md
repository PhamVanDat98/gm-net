# Sổ tay triển khai gm-net (dành cho AI agent / dev tiếp quản)

Bạn đang tiếp quản một codebase có nền móng chạy được và một bộ đặc tả đã chốt. Nhiệm vụ của bạn là triển khai các phase tiếp theo **đúng theo đặc tả**, không phải thiết kế lại.

## 0. Đọc theo thứ tự này (bắt buộc, ~20 phút)

1. `BRAINSTORM.md` — bối cảnh, scope, roadmap 5 phase, danh sách NGOÀI scope.
2. `docs/design/001-schema-api.md` — schema API + 3 quyết định đã chốt ở cuối.
3. `docs/design/002-wire-protocol.md` — protocol tổng thể (bảng message, handshake, clock sync).
4. `docs/design/003-repo-structure.md` — layout, quy tắc phụ thuộc, lệnh.
5. `docs/design/004-schema-serialization.md` — **đặc tả Phase 2 phần 1** (schema, encode, diff) — có checklist test.
6. `docs/design/005-state-sync.md` — **đặc tả Phase 2 phần 2** (tick loop, snapshot/delta pipeline, StateView) — có checklist test + definition of done.
7. `docs/design/006-prediction.md`, `007-interest-3d.md`, `008-physics.md` — Phase 3/4/5, đọc để không thiết kế Phase 2 chặn đường chúng. Riêng 006 §0 (determinism) và 008 §1/§3 (một physics engine hai đầu, chia đôi nhóm body) là các nguyên tắc nền — vi phạm là sai kiến trúc.

Code hiện có (Phase 0+1, 41 test xanh): đọc `packages/core/src/` (binary, transport, netsim, protocol/messages), `packages/server/src/` (server, room), `packages/client/src/client.ts` trước khi viết gì.

## 1. Trạng thái hiện tại

| Phase | Trạng thái | Bằng chứng |
|---|---|---|
| 0 — nền móng | ✅ | binary.ts, netsim.ts + tests |
| 1 — kết nối & phòng | ✅ | protocol/messages.ts, NetServer, NetClient, transport-ws; demo `examples/chat-node` |
| 2 — state sync | ⬜ **← bạn làm phần này** | đặc tả: 004 + 005 |
| 3 — prediction | ⬜ | đặc tả: 006 |
| 4 — 3D + AOI + docs site | ⬜ | phác thảo: 007 |
| 5 — physics (Rapier adapter, demo roblox-mini) | ⬜ | nguyên tắc: 008 |

## 2. Quy tắc bất di bất dịch

1. **Wire format và public API đã chốt trong design docs là hợp đồng.** Thấy vấn đề → sửa design doc trước (ghi rõ lý do), rồi mới sửa code. Không "tiện tay" đổi.
2. **Ranh giới package**: `core` cấm import Node API (chạy browser). `client` cũng vậy. Chỉ `server` và `transport-ws/server` được đụng Node. Phụ thuộc một chiều: mọi package → core; không package nào import lẫn nhau ngoài core.
3. **Không thêm dependency runtime mới** nếu chưa ghi vào design doc (hiện chỉ có `ws`). Dev-dependency cần lý do trong PR/commit message.
4. **Danh sách NGOÀI scope trong BRAINSTORM.md là ranh giới cứng** — không implement lockstep, ELO, multi-node "cho vui".
5. **Mỗi module mới phải có test cùng lúc** — checklist test trong 004 §11 và 005 §7 là mức tối thiểu, không phải gợi ý.
6. TypeScript strict, ESM-only, import nội bộ dùng đuôi `.js` (NodeNext). Public API của package đi qua duy nhất `src/index.ts`.
7. Code comment và docs nội bộ: tiếng Việt hoặc tiếng Anh đều được, nhất quán trong file. Identifier luôn tiếng Anh.

## 3. Lệnh

```bash
pnpm install        # một lần
pnpm build          # tsc -b (project references, đúng thứ tự)
pnpm test           # vitest run — PHẢI xanh 100% trước mỗi commit
pnpm --filter example-chat-node start   # demo Phase 1 (cần build trước)
```

- Test import cross-package qua alias `@gm-net/*` → `packages/*/src` (cấu hình sẵn trong `vitest.config.ts`) — không cần build trước khi test.
- Test netcode phải dùng `withSimulation` + `mulberry32(seed)` (core/netsim) để tất định. Timer thật với latency nhỏ (≤ 100ms) chấp nhận được trong e2e; fake timers (`vi.useFakeTimers`) cho unit test thuần logic thời gian.

## 4. Trình tự triển khai Phase 2 (khuyến nghị)

Mỗi bước xanh test rồi mới sang bước sau; commit theo bước:

1. `core/src/schema/` — descriptor, entity(), state(), flatten leaves, validate, hash (004 §2–6, test §11 nhóm schema/hash).
2. `core/src/schema/codec.ts` — full encode/decode, delta encode/decode, EntitySnapshot + diff (004 §7–9, test nhóm delta/diff + perf gate).
3. `core/protocol/messages.ts` — thêm SNAPSHOT/DELTA/INPUT với DecodeContext (005 §1, test protocol-sync).
4. `server/src/sync-room.ts` — SyncRoom: state, spawn/despawn, tick loop, ring buffer, per-client ack→DELTA/SNAPSHOT (005 §2). Nối `NetServer.dispatch` case 'input'.
5. `client/src/state-sync.ts` — history + áp delta + ack; `StateView` interpolation (005 §4–5).
6. Sửa footgun event-trước-listener trong `ClientRoom` (005 §6).
7. E2E `sync-e2e.test.ts` (005 §7) — đây là bài kiểm tra thật sự của cả phase.
8. `examples/vanilla-2d` (005 §8) — definition of done của milestone.
9. Cập nhật: bảng trạng thái ở trên (§1), marker trong design 003, BRAINSTORM nếu lệch kế hoạch.

## 5. Bẫy đã biết (đừng dẫm lại)

- **Close semantics**: transport giao message-gửi-trước-close rồi mới bắn onClose (graceful, như WS thật) — test netsim đã cover, đừng "sửa" nó.
- **Alias thứ tự**: trong vitest.config.ts, alias subpath (`@gm-net/transport-ws/server`) phải đứng trước alias package.
- **`noUncheckedIndexedAccess` đang bật** — indexing trả `T | undefined`, dùng `!` có chủ đích hoặc kiểm tra.
- **pnpm chặn build script**: dependency mới cần postinstall → thêm vào `allowBuilds` trong pnpm-workspace.yaml.
- **Event đến trước listener** (backlog): server gửi EVENT ngay trong onJoin thì client chưa kịp gắn handler — chính là mục 005 §6 phải sửa.
- Windows: repo dùng `.gitattributes` ép LF; PowerShell 5.1 không có `&&`.

## 6. Git

Remote: `https://github.com/PhamVanDat98/gm-net.git`, branch `main`. Commit theo mốc có ý nghĩa (mỗi bước ở §4), message tiếng Anh, thân bài liệt kê thay đổi chính. Luôn `pnpm build && pnpm test` xanh trước khi push.
