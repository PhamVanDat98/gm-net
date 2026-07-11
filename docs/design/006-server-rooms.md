# 006 — Server & rooms

Căn cứ: BRAINSTORM.md §1 (game server stateful), §3 (Colyseus, uWebSockets.js), §4 Phase 1
(tick loop) + Phase 2 (lag compensation, AOI, reconnection), §5 (quyết định 4, 5).

## 1. Vai trò của Colyseus

**[CHỐT]** (quyết định 4): dùng Colyseus (`^0.17.10`) cho **room lifecycle + seat
reservation**, bypass hoàn toàn schema sync; dữ liệu game đi qua `sendBytes()`/broadcast bytes.

**[ĐỀ XUẤT]** ánh xạ cụ thể:

- `@gm-net/server` expose lớp `GameRoom extends colyseus.Room`:
  - `onCreate`: khởi tạo Rapier world (qua physics adapter), tick loop, đăng ký handler
    message binary.
  - `onJoin`: cấp entity cho player (gọi hook của game), gửi **full snapshot** đầu tiên
    + thông tin handshake (protocolVersion, tickRate, worldBounds, entityId của mình).
  - `onLeave`: despawn hoặc treo entity chờ reconnect (§5).
  - `state` Colyseus: **không dùng** (để trống) — toàn bộ state nằm trong Rapier world.
- Game kế thừa/cấu hình `GameRoom` bằng hooks: `onPlayerJoin/Leave`, `applyInput`,
  `simulate` (mặc định = world.step), `encodeCustomState`.
- Transport: `@colyseus/uwebsockets-transport` (uWebSockets.js — nhanh hơn `ws` nhiều lần,
  expose trực tiếp, không proxy qua Cloudflare). Đây là chỗ duy nhất đụng uWS; phần còn
  lại của server code không biết transport là gì.
  - **Trạng thái M2 [ĐỀ XUẤT]**: `createGameServer({ transport })` nhận transport
    injectable, **mặc định `WebSocketTransport`** (bundled trong `colyseus`, chạy mọi nơi
    kể cả Windows/CI). uWS là opt-in production (truyền vào) — đúng điểm thoát ở bảng rủi
    ro. Interface không đổi khi chuyển transport.

## 2. Tick loop phía server

**[CHỐT]** fixed-tick 30Hz. **[ĐỀ XUẤT]** hiện thực:

- Dùng timer drift-corrected: `setTimeout` tự căn lại theo `expectedNext - now` thay vì
  `setInterval` (setInterval trôi và dồn cục khi event loop nghẽn).
  - **Kết luận M2**: `Room.setSimulationInterval` chạy trên `ClockTimer` kiểu setInterval
    (bù delta chứ không căn thời điểm fire) → **tự quản timer** trong `TickScheduler`
    (`server/src/tick.ts`), timer injectable để unit-test bằng đồng hồ ảo (đo 100 tick,
    drift < 1 tick). Nghiệm thu "echo simulation, 2 client thấy nhau" test ở tầng
    `RoomEngine` (tách khỏi socket); e2e qua socket + proxy để dành M5.
- Một tick T:
  1. Rút input `tick == T` từ jitter buffer per-client ([004](004-netcode.md) §4);
     client thiếu input → lặp input cuối (config).
  2. `applyInput` cho từng player (code trong `shared` của game).
  3. Step Rapier world đúng 1 bước.
  4. `takeSnapshot()` → đẩy ring buffer (30 slot ~1s — quyết định 5; phục vụ lag comp §4
     và làm baseline delta [005](005-serialization.md) §4).
  5. Đóng gói + gửi snapshot cho từng client (`lastProcessedSeq` riêng từng người;
     Phase 2: lọc AOI + delta).
- Đo `tickDuration` mỗi tick từ ngày đầu; cảnh báo khi p99 tiến gần 33ms.
- **Snapshot rate = tick rate (30Hz) ở Phase 1** — đơn giản trước; tách send rate thấp
  hơn (15–20Hz) là việc tối ưu sau nếu bandwidth thành vấn đề.

## 3. Kiểm soát input (chống gian lận mức giao thức)

**[ĐỀ XUẤT]** — hệ quả của server-authoritative ([001](001-architecture.md) §5):

- Clamp payload: trục analog vào [-1,1], độ dài vector ≤ 1.
- Cửa sổ tick hợp lệ: bỏ input có tick lệch quá ±1s so với tick hiện tại.
- Ngân sách: tối đa ~2 input mới/tick/client (đề phòng flood); vượt → drop + đếm.
- Mọi input bị bỏ đều tăng counter có thể quan sát được ([004](004-netcode.md) §8).

## 4. Lag compensation (Phase 2)

**[CHỐT]** cơ chế: giữ position history ~1 giây; khi hit detection, rewind về thời điểm
người bắn *nhìn thấy* rồi kiểm tra trúng.

**[ĐỀ XUẤT]** chi tiết:

- Thời điểm rewind = tick mà người bắn đang render remote entities lúc bấm cò
  = `inputTick - interpolationDelayTicks(client)` (client báo delay hiện tại của nó trong
  packet input, server clamp ≤ 200ms — không cho client tự khai delay khổng lồ để "bắn
  vào quá khứ xa").
- Hai lựa chọn hiện thực, chọn khi code bằng benchmark:
  a. Rewind bằng `restoreSnapshot` từ ring buffer (chính xác tuyệt đối nhưng restore cả
     world); hoặc
  b. Giữ history riêng position/rotation per entity (mảng vòng 30 phần tử), raycast thủ
     công trên hình học tại thời điểm cũ — rẻ hơn nhiều, đủ cho hitscan.
  Thiên về (b) cho hitscan; (a) để dành khi cần rewind cả tương tác vật lý.

## 5. Reconnection + state resync (Phase 2)

**[CHỐT]** grace period giữ session. **[ĐỀ XUẤT]** chi tiết:

- `onLeave` với lỗi mạng (không phải chủ động thoát): `allowReconnection(client, grace)`
  của Colyseus, grace mặc định 30s (config). Entity của player: giữ nguyên trong world
  (đứng yên hoặc rule của game quyết — hook `onPlayerDisconnected`).
- Reconnect thành công: coi như join lại về mặt dữ liệu — **full snapshot** mới, client
  vứt toàn bộ prediction/interpolation buffer cũ, reset seq về seq cuối được ack + 1.
- Quá grace: despawn thật, giải phóng seat.

## 6. Interest management / AOI (Phase 2)

**[CHỐT]** grid hoặc quadtree. **[ĐỀ XUẤT]**: bắt đầu bằng **uniform grid** (đơn giản,
predictable, phù hợp top-down shooter); cell size ≈ bán kính quan tâm / 2; entity đăng ký
cell theo AABB; tập quan tâm của client = 3×3 cell quanh camera + hysteresis (vào tập ở
bán kính r, ra ở r×1.2) để tránh flapping spawn/despawn ở mép. Quadtree chỉ khi mật độ
entity chênh lệch lớn giữa các vùng map. AOI đổi tập → gửi spawn/despawn event trong
snapshot ([005](005-serialization.md) §4 đã chừa chỗ).

## 7. Headless client (Phase 2)

**[CHỐT]** bot fill room + load testing. Ghi chú thiết kế: `@gm-net/client` không được
import DOM ngay từ Phase 1 (điều kiện để chạy trên Node không sửa gì); headless mode chỉ
là "client không gọi getRenderState + input do script bơm". Load test = N headless client
+ netem/proxy delay, đo metrics server ([008](008-roadmap.md) §5).
