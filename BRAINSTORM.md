# gm-net — Kết quả phiên brainstorm (2026-07-09)

Thư viện multiplayer cho game 2D/3D trên web, dùng lại được cho các dự án greenfield, tài liệu đầy đủ.

## Quyết định đã chốt

| Trục | Quyết định | Ghi chú |
|---|---|---|
| Game target | Action nhịp nhanh 2–16 người + co-op/casual 2–8 người | Action là bài toán khó nhất → thiết kế cho nó, co-op hưởng lợi theo |
| Phạm vi | State-sync framework + lobby/matchmaking cơ bản | Không phải transport wrapper, cũng không phải game engine |
| Topology | Client-server authoritative | Server Node chạy game logic, client gửi input |
| Ngôn ngữ | TypeScript, phát hành JS + `.d.ts` | Người dùng JS thuần vẫn dùng bình thường |
| Matchmaking | Lobby + room listing (tạo phòng, list public, join bằng mã, quick-join) | Skill-based/queue: ngoài scope, chừa hook |
| Transport v1 | WebSocket; transport là interface để thêm WebRTC/WebTransport ở phase sau | Chấp nhận TCP head-of-line blocking ở v1 |
| Engine examples | Canvas vanilla, Phaser (2D), Three.js (3D), Babylon.js (3D) | Core hoàn toàn engine-agnostic |

## Ngoài scope (ghi rõ trong docs kèm lý do)

- **Lockstep deterministic** — JS không đảm bảo determinism floating-point giữa các máy.
- **Skill-based matchmaking (ELO/MMR)** — thuộc về game cụ thể; thư viện chỉ cung cấp metadata hook trên room.
- **Multi-node scaling / MMO** — v1 chạy 1 process nhiều room; thiết kế không chặn đường mở rộng sau.
- **Voice/video** — không liên quan.

## Kiến trúc package (monorepo)

```
packages/
  core/            # schema, binary serialization, delta encoding, clock sync,
                   # message protocol — chạy cả client lẫn server (isomorphic)
  server/          # Room, game loop/tick, broadcast, lobby/room listing,
                   # input queue, validation, rate limiting (Node)
  client/          # connect/reconnect, snapshot buffer, interpolation,
                   # client prediction + reconciliation (browser)
  transport-ws/    # WebSocket adapter (v1)
  transport-webrtc/# WebRTC DataChannel adapter (phase sau)
examples/
  vanilla-2d/      # Canvas thuần — dùng để dạy concepts trong docs
  phaser-2d/
  three-3d/
  babylon-3d/
docs/              # concepts guide, getting started, recipes, API reference (TSDoc)
```

## Trái tim kỹ thuật: mô hình đồng bộ

1. **Nền tảng: snapshot interpolation** (mô hình Quake/Valve)
   - Server tick cố định (mặc định 20–30Hz), gửi snapshot state.
   - Client buffer 2–3 snapshot, render trễ ~100ms, nội suy giữa các snapshot.
2. **Tầng trên: client prediction + server reconciliation** cho entity của chính người chơi
   - Client mô phỏng ngay input của mình, đánh số thứ tự input.
   - Server xác nhận → client so khớp, replay các input chưa xác nhận nếu lệch.
3. **Delta compression**: schema-based, chỉ gửi field thay đổi so với snapshot đã ACK.
4. **Interest management** (phase sau): grid 2D / octree 3D — điểm khác biệt 2D/3D duy nhất trong core.

Serialization: binary, schema khai báo kiểu (`float32`, `int16`, quantization cho position/rotation, quaternion compression cho 3D).

## Roadmap

### Phase 0 — Nền móng (thiết kế trước khi code)
- Monorepo setup (pnpm workspaces + TS project references), CI, vitest.
- Thiết kế wire protocol + schema API trên giấy (đây là API khó sửa nhất sau này).
- **Network condition simulator** (lag/jitter/loss/reorder) — làm ngay từ đầu, không có nó thì không test được netcode.

### Phase 1 — Kết nối & phòng
- transport-ws + transport interface, connect/disconnect/reconnect có resume.
- Room lifecycle: create/join/leave, join bằng mã, room listing, quick-join.
- Reliable messaging (event/RPC) client↔server.
- Milestone demo: chat room nhiều phòng.

### Phase 2 — State sync
- Schema + binary serialization + delta encoding.
- Server tick loop, snapshot broadcast, clock sync.
- Client snapshot buffer + interpolation.
- Milestone demo: vanilla-2d — nhiều người di chuyển mượt quanh map.

### Phase 3 — Netcode cho action game
- Client prediction + server reconciliation.
- Input pipeline chuẩn hóa (sequence number, input buffer phía server).
- Milestone demo: phaser-2d game bắn nhau nhỏ, chơi được ở 150ms ping + 5% loss.

### Phase 4 — 3D + hoàn thiện
- Quaternion compression, ví dụ three-3d và babylon-3d.
- Interest management (grid/octree) cho phòng đông.
- Docs site hoàn chỉnh: concepts, getting started per-engine, recipes, API reference.

### Phase 5 — Physics (thêm 2026-07-09, xem design 008)
- Adapter `@gm-net/physics-rapier` (package riêng, optional): MỘT Rapier world chạy cả server lẫn client; render engine chỉ vẽ.
- Chia đôi thế giới: nhân vật = kinematic controller (predicted), vật thể động = server-simulated + ghost nội suy phía client.
- Milestone demo `roblox-mini` (three.js): đi lại/nhảy predicted, đẩy thùng ném bóng server-simulated, chơi được ở 150ms ping.
- Mục tiêu sản phẩm mở rộng: game 3D kiểu Roblox (nhiều vật thể động tương tác).

### Phase 6+ (backlog)
- transport-webrtc (kênh unreliable), WebTransport.
- Lag compensation (server rewind cho hit detection).
- Network ownership kiểu Roblox: client sở hữu mô phỏng body gần mình, server validate thô (design 008 §6) — cần "client-writable fields" trong schema.
- Queue-based matchmaking, persistence adapter, multi-node.

## Backlog "dễ quên"
- Event tới ngay sau ROOM_JOINED có thể đến trước khi user code kịp gắn listener (thấy trong demo chat-node) → cân nhắc buffer event cho tới lần gắn listener đầu / microtask kế tiếp (Phase 2).
- Rate limiting + server-side validation mọi message từ client.
- Heartbeat/timeout, xử lý tab bị throttle khi background.
- Metrics hook: RTT, bandwidth, snapshot size — expose cho dev.
- Versioning protocol (client cũ gặp server mới).

## Rủi ro chính
| Rủi ro | Giảm thiểu |
|---|---|
| Schema/wire protocol thiết kế sai → sửa là breaking change | Dành riêng Phase 0 để thiết kế + review; đánh version protocol từ đầu |
| WebSocket TCP không đủ cho action nhịp nhanh | Chấp nhận ở v1 (nhiều game .io thành công vẫn dùng WS); transport interface mở đường WebRTC |
| Prediction/reconciliation khó debug | Network simulator + demo playground có visualizer (hiển thị server state vs predicted state) |
| Scope phình (matchmaking, physics…) | Danh sách "ngoài scope" ở trên là ranh giới cứng |

## Tham chiếu nên đọc
- Colyseus (schema + room model), nengi (interest management), geckos.io (WebRTC transport)
- Gabriel Gambetta — "Fast-Paced Multiplayer" series (nền tảng prediction/reconciliation)
- Valve Developer Wiki — "Source Multiplayer Networking" (snapshot interpolation)
- Glenn Fiedler — gafferongames.com (mọi thứ về netcode)
