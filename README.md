# gm-net

Multiplayer framework cho game JS 2D & 3D: server-authoritative physics (Rapier),
client-side prediction, server reconciliation, snapshot interpolation. Render-agnostic.

Xem [BRAINSTORM.md](./BRAINSTORM.md) (tài liệu khởi tạo — nguồn sự thật gốc) và
[docs/](./docs/README.md) (bộ design docs chi tiết 001–008: kiến trúc, netcode,
serialization, server/rooms, matchmaker, roadmap).

## Cấu trúc

| Package | Vai trò |
|---|---|
| `@gm-net/core` | Netcode: prediction, reconciliation, interpolation, clock sync, serialization |
| `@gm-net/physics-2d` | Adapter `@dimforge/rapier2d` |
| `@gm-net/physics-3d` | Adapter `@dimforge/rapier3d` (Phase 3) |
| `@gm-net/shared` | Simulation logic, input schema, constants — import cả client lẫn server |
| `@gm-net/server` | Room framework (trên Colyseus), tick loop, lag compensation, AOI |
| `@gm-net/client` | Client runtime, headless mode (bot/load test) |
| `@gm-net/matchmaker` | Optional: queue, server registry (Redis, Phase 3) |
| `examples/demo-2d` | Top-down shooter demo |

## Phát triển

```sh
pnpm install
pnpm build        # build tất cả packages (tsup)
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit toàn repo
```
