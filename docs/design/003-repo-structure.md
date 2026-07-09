# Design 003 — Cấu trúc repo & tooling

Trạng thái: **Đã áp dụng**

## Nguyên tắc

Tooling tối thiểu — mỗi công cụ thêm vào phải trả lời được "thiếu nó thì đau ở đâu". Chưa dùng: bundler (tsc đủ cho library), changesets (chưa publish), lint/format phức tạp (thêm khi có >1 contributor).

## Stack

| Việc | Công cụ | Lý do |
|---|---|---|
| Workspace | pnpm workspaces | chuẩn de-facto cho monorepo lib JS |
| Build | `tsc -b` (project references) | library thuần TS, không cần bundler; incremental build |
| Test | vitest | chạy TS trực tiếp, fake timers tốt (cần cho netsim) |
| Module format | ESM only (`"type": "module"`) | 2026 rồi; game dev toàn Vite/bundler, Node 20+ đều ăn ESM |
| Node tối thiểu | >= 20 | |

## Layout

```
gm-net/
├── BRAINSTORM.md              # kết quả brainstorm — bối cảnh & quyết định gốc
├── docs/design/               # design docs đánh số, có trạng thái Draft/Chốt
├── packages/
│   ├── core/                  # @gm-net/core — isomorphic (chạy cả Node lẫn browser)
│   │   ├── src/
│   │   │   ├── binary.ts      # ByteWriter/ByteReader, varint       [Phase 0 ✓]
│   │   │   ├── transport.ts   # Transport interface + memory pair   [Phase 0 ✓]
│   │   │   ├── netsim.ts      # giả lập lag/jitter/loss             [Phase 0 ✓]
│   │   │   ├── schema/        # entity(), state(), types            [Phase 2]
│   │   │   └── protocol/      # message encode/decode               [Phase 1 ✓]
│   │   └── test/
│   ├── server/                # @gm-net/server — NetServer, Room, lobby [Phase 1 ✓] tick loop [Phase 2]
│   ├── client/                # @gm-net/client — NetClient, reconnect+resume [Phase 1 ✓] interp/prediction [Phase 2/3]
│   └── transport-ws/          # @gm-net/transport-ws — client (WebSocket chuẩn) + ./server (ws) [Phase 1 ✓]
├── examples/
│   ├── chat-node/             # milestone Phase 1 — chat qua WS thật [✓]
│   └── ...                    # vanilla-2d, phaser-2d, three-3d, babylon-3d [Phase 2+]
└── docs/                      # docs site cho người dùng [Phase 4]
```

Quy tắc phụ thuộc (một chiều, không vòng):

```
transport-ws ──▶ core ◀── server
                 ▲
                 └────── client
```

`core` không được import gì từ Node API (phải chạy trong browser). `server` được phép.

## Quy ước

- Test đặt tại `packages/<p>/test/*.test.ts`, import từ `../src/...` (không qua package name — vitest chạy thẳng source, không cần build trước khi test).
- Cross-package import trong test/example: alias `@gm-net/*` → `packages/*/src/index.ts` trong `vitest.config.ts`.
- Public API của mỗi package đi qua duy nhất `src/index.ts` — cái gì không re-export ở đó là private.
- Publish (sau này): `exports` trỏ `dist/`, `files: ["dist"]`, đã cấu hình sẵn trong package.json.

## Lệnh

```
pnpm build      # tsc -b — build tất cả packages theo dependency order
pnpm test       # vitest run — toàn bộ test
pnpm test:watch
```
