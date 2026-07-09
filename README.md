# gm-net

Thư viện multiplayer **state-sync** cho game web 2D/3D — client-server authoritative, TypeScript, engine-agnostic (Phaser, Three.js, Babylon.js, canvas thuần).

> Đang phát triển theo roadmap 5 phase. Hiện tại: Phase 0–1 hoàn tất (kết nối, phòng, lobby, reconnect+resume), Phase 2 (state sync) đã có đặc tả đầy đủ, chờ triển khai.

## Packages

| Package | Vai trò |
|---|---|
| `@gm-net/core` | Binary encoding, schema, protocol, network simulator — isomorphic |
| `@gm-net/server` | NetServer, Room/SyncRoom, lobby, rate limit (Node) |
| `@gm-net/client` | NetClient, reconnect+resume, interpolation, prediction (browser) |
| `@gm-net/transport-ws` | WebSocket adapter — client entry + `./server` entry |

## Bắt đầu

```bash
pnpm install
pnpm build
pnpm test
pnpm --filter example-chat-node start   # demo chat qua WebSocket thật
```

## Tài liệu

- **Người triển khai tiếp**: đọc [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — thứ tự đọc, quy tắc, trình tự làm Phase 2.
- **Bối cảnh & roadmap**: [BRAINSTORM.md](BRAINSTORM.md)
- **Đặc tả kỹ thuật**: [docs/design/](docs/design/) — 001 schema API · 002 wire protocol · 003 repo · 004 serialization · 005 state sync · 006 prediction · 007 3D/AOI · 008 physics (Rapier)
