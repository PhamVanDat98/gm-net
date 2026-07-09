# Design 008 — Tích hợp Physics (2D/3D, hướng tới game kiểu Roblox)

Trạng thái: **Nguyên tắc đã chốt (2026-07-09) — chi tiết hóa API sau Phase 3.** Phụ thuộc: 005, 006, 007 (quat, AOI).

## 0. Yêu cầu gốc (từ product owner)

Ngoài các game không tương tác vật lý, mục tiêu là làm được **game 3D kiểu Roblox**: thế giới nhiều vật thể động (thùng, bóng, xe...), người chơi va chạm và tương tác vật lý với chúng. Vật lý phía server phải "khớp" với những gì client thấy/predict.

## 1. Nguyên tắc kiến trúc số 1: MỘT physics engine, hai đầu

**Không** dùng physics tích hợp của render engine (Havok của Babylon, hay bất kỳ plugin nào gắn với Three). Hai engine vật lý khác nhau ở client và server không bao giờ cho cùng kết quả — mỗi engine giải contact/friction khác nhau → prediction sai liên tục, không sửa được bằng tinh chỉnh.

Thay vào đó:

```
           ┌────────────── shared/ ──────────────┐
           │  physics-world.js (Rapier)          │
           │  schema.js (gm-net state)           │
           └──────┬────────────────────┬─────────┘
                  │                    │
   Server (Node): Rapier steps    Client (browser): Rapier steps
   trong SyncRoom.onTick          character controller (prediction)
                  │                    │
            gm-net sync  ────────►  StateView
                                       │
                          Three.js / Babylon.js CHỈ RENDER
                          (đọc transform, không mô phỏng gì)
```

Render engine trở thành lớp vẽ thuần túy — đúng tinh thần engine-agnostic của toàn dự án.

## 2. Chọn engine: Rapier

| Tiêu chí bắt buộc (rút từ 006) | Rapier | Jolt JS | Havok (Babylon) | cannon-es / matter |
|---|---|---|---|---|
| Chạy cả Node + browser | ✅ WASM | ✅ WASM | ⚠️ chủ yếu Babylon | ✅ JS thuần |
| Kết quả giống nhau 2 đầu | ✅ cùng 1 binary WASM (float ops cố định theo đặc tả WASM) | ✅ tương tự | ❓ closed-source | ⚠️ JS engine khác nhau vẫn ổn, nhưng trôi nhanh vì solver kém ổn định |
| **Snapshot/restore world** (bắt buộc cho replay reconciliation) | ✅ `world.takeSnapshot()` / `World.restoreSnapshot()` | ❌ bindings JS chưa có | ❌ | ❌ |
| Kinematic character controller sẵn | ✅ | ⚠️ tự viết | ✅ | ❌ |
| 2D và 3D | ✅ rapier2d + rapier3d | 3D | 3D | riêng lẻ |
| License / bảo trì | Apache-2, active | MIT, active | closed | MIT, chậm |

**Chốt: Rapier.** Dùng package `@dimforge/rapier3d-compat` (WASM nhúng base64 — chạy Node không cần cấu hình bundler) cho server + example; browser có thể dùng bản `-compat` luôn cho đơn giản. 2D: `rapier2d-compat`.

Lưu ý determinism (liên kết 006 §0): cùng một binary WASM cho kết quả như nhau trên mọi máy vì đặc tả WASM cố định IEEE 754 cho float ops — đây là "thực dụng deterministic", cộng với reconciliation tự sửa lệch nên KHÔNG cần chế độ determinism tuyệt đối.

## 3. Chia đôi thế giới vật lý (quyết định quan trọng nhất)

Mỗi body thuộc đúng một trong hai nhóm:

**Nhóm A — Nhân vật người chơi: kinematic character controller, được predict.**
- Logic di chuyển (collide-and-slide) nằm trong `shared/physics-world.js`, chạy ở cả server (`onInput` + `onTick`) và client (Predictor của 006).
- Va chạm với địa hình tĩnh + ghost bodies (xem dưới) → phân kỳ gần 0.

**Nhóm B — Vật thể động (thùng, bóng, ragdoll...): CHỈ server mô phỏng.**
- Server: Rapier world đầy đủ step trong `onTick`; sau step, copy transform → state entity (`pos: vec3(quantized(0.01))`, `rot: quat()` từ 007).
- Client: KHÔNG chạy dynamics cho nhóm B. Mỗi body nhóm B tồn tại trong world client dưới dạng **ghost** — `kinematicPositionBased`, được teleport tới transform nội suy (`view.sample()`) mỗi frame. Nhờ đó character controller của client vẫn đứng lên được thùng đang trôi, bị nó đẩy, v.v.
- Hệ quả chấp nhận được: đẩy một thùng sẽ thấy nó phản hồi trễ ~RTT/2 + interpDelay (server mới là người mô phỏng cú đẩy). Đây cũng là hành vi của Roblox khi phần vật lý thuộc quyền server.

**Synergy có sẵn, không cần code thêm**: body ngủ (sleeping) → transform không đổi → per-tick diff (004 §9) tự động không phát byte nào. Thế giới 200 thùng đứng yên tốn ~0 băng thông.

## 4. Reconciliation khi có physics

Replay input (006 §4) với character controller:
- **v1 (đơn giản, chấp nhận sai số nhỏ)**: replay các pending input với ghost bodies ở vị trí MỚI NHẤT. Sai số chỉ xuất hiện khi đứng trên/va vào vật đang di chuyển nhanh — được error smoothing hấp thụ.
- **v2 (chính xác, làm khi cần)**: client đã lưu history tick state (005 §4) → khi replay input ứng với tick t, teleport ghosts về transform tại tick t trước khi step. Không cần snapshot Rapier world cho v1/v2 vì chỉ replay character kinematic.
- `world.takeSnapshot()` của Rapier để dành cho tương lai nếu predict cả dynamics (không nằm trong kế hoạch hiện tại).

## 5. Package mới: `@gm-net/physics-rapier` (adapter mỏng)

KHÔNG wrap API Rapier (user dùng Rapier trực tiếp). Adapter chỉ lo đường biên physics ↔ sync:

```ts
// server
const binder = bindWorld(room, world, {
  bodies: {                       // map collection ↔ rigid body
    crates: { applyTo: (entity, body) => {...mặc định: pos+rot...} },
  },
})
binder.track('crates', body, entityInit)   // spawn entity + gắn body handle
binder.sync()                              // gọi cuối onTick: copy transforms → state
// client
const ghosts = bindGhosts(view, clientWorld, { crates: {...} })  // tạo/teleport/hủy ghost theo onAdd/onRemove/sample
```

- `core`/`server`/`client` **không** phụ thuộc Rapier — adapter là package riêng, optional. Quy tắc phụ thuộc 003 giữ nguyên.
- Peer dependency: `@dimforge/rapier3d-compat` (hoặc 2d) do user cài.

## 6. Hướng Roblox thật sự: network ownership (backlog Phase 6+, ghi để không quên)

Roblox scale được vật lý nhờ **chuyển quyền mô phỏng** (network ownership): body gần người chơi nào thì client đó mô phỏng và stream transform lên, server chỉ validate thô (giới hạn vận tốc/teleport). Đổi anti-cheat lấy scale + độ phản hồi. Với gm-net đây là mode tương lai: entity có `owner`, client owner được phép ghi một số field — cần thêm cơ chế "client-writable fields" vào schema. **Không làm trước khi Phase 2–5 vững.**

## 7. Ảnh hưởng lên roadmap

- `quat()` (007 §1) trở thành tiền đề cho physics 3D — giữ ở Phase 4 như kế hoạch.
- AOI (007 §2) bắt buộc trước khi làm world kiểu Roblox nhiều entity.
- Thêm **Phase 5: physics** vào BRAINSTORM: adapter `@gm-net/physics-rapier` + demo `examples/roblox-mini` (three.js): sân chơi 3D, người chơi đi lại nhảy (predicted), đẩy thùng, ném bóng (server-simulated, nội suy mượt). Definition of done: chơi được ở 150ms ping, thùng ngủ không tốn băng thông (đo bằng metrics hook).
