# 003 — Tech stack & các quyết định đã chốt

Căn cứ: BRAINSTORM.md §3 (bảng tech stack), §5 (6 quyết định kỹ thuật quan trọng).
Mọi mục trong tài liệu này đều **[CHỐT]** trừ khi ghi khác; phần "Rủi ro / khi nào xem lại"
là **[ĐỀ XUẤT]** để theo dõi.

## Bảng tổng hợp

| Thành phần | Lựa chọn | Ghi chú |
|---|---|---|
| Physics | Rapier 2D/3D (WASM) | Chung API 2D/3D, snapshot built-in, flag `enhanced-determinism` |
| Transport | WebSocket qua uWebSockets.js | Nhanh hơn `ws` nhiều lần; expose trực tiếp, không proxy qua Cloudflare |
| Room framework | Colyseus | Room lifecycle + seat reservation; **bypass schema sync**, gửi snapshot binary qua `sendBytes()` |
| Serialization | Tự viết bit-packing (`DataView`/`ArrayBuffer`) | Quantize position (16-bit fixed point), delta compression |
| Runtime | Node.js | Bun là option thử nghiệm sau |
| Matchmaker | Node + Redis | Queue, pub/sub, server registry; REST/WS endpoint riêng |
| Client render | Agnostic | Core expose interpolated state; adapter mẫu cho Pixi/Three |

## Quyết định 1 — Rapier, không phải Planck/Matter/cannon-es

**Nội dung:** Physics engine là Rapier (WASM), cho cả 2D lẫn 3D.

**Lý do (từ tài liệu khởi tạo):** Reconciliation cần snapshot/restore **toàn bộ** world
state — bao gồm cả state ẩn: contact cache, solver warm-start, sleeping state. Engine JS
thuần không serialize được state ẩn đó → sau khi restore, world hành xử khác đi dù
position/velocity giống hệt → misprediction "giả" → correction loop không dứt.

Rapier có `takeSnapshot()` / `restoreSnapshot()` built-in, trả về `Uint8Array`
(memcpy-fast), bắt trọn state ẩn.

**Đã kiểm chứng trên repo (2026-07-11):** spike test
`packages/physics-2d/test/snapshot-spike.test.ts` — world 10 body có va chạm, snapshot
giữa chừng, hai nhánh chạy tiếp 60 bước → state identical **bit-perfect** (position,
rotation, velocity). Dùng `@dimforge/rapier2d-compat@^0.19.3` (bản compat nhúng WASM
base64 → cùng package chạy Node lẫn browser, không cần cấu hình loader).

**Rủi ro / khi nào xem lại:** kích thước snapshot tỉ lệ với world (benchmark ở
[008](008-roadmap.md) §4); nếu world lớn làm snapshot 30Hz quá đắt → chuyển sang snapshot
thủ công chỉ các dynamic body quan trọng (đã lường trước ở quyết định 5).

## Quyết định 2 — Không cần bit-perfect determinism

**Nội dung:** Không theo đuổi determinism tuyệt đối cross-platform.

**Lý do (từ tài liệu khởi tạo):** Server-authoritative + prediction chỉ cần "gần
deterministic": client dự đoán, server phán quyết, reconciliation tự sửa sai số nhỏ.
Determinism bit-perfect chỉ bắt buộc với lockstep/rollback (nơi mọi máy phải tính ra
cùng một kết quả) — mô hình đó nằm ngoài phạm vi.

**Hệ quả thực tế:** cùng một máy + cùng binary WASM thì Rapier replay identical (spike đã
xác nhận) — đủ cho reconciliation phía client (restore + replay trên chính máy client).
Sai khác nhỏ client/server (nếu có) thể hiện thành correction vài mm, được smoothing che.
Flag `enhanced-determinism` của Rapier để dành khi nào cần chặt hơn.

## Quyết định 3 — Matchmaker tách khỏi core

**Nội dung:** Matchmaker là service riêng, stateless, giao tiếp với game server qua Redis.

**Lý do (từ tài liệu khởi tạo):** Game room stateful phải sticky vào một process; matchmaker
stateless scale ngang thoải mái. Hai profile scale khác nhau → không trộn. Framework phải
dùng được **không cần** matchmaker (connect thẳng game server).

**Hệ quả:** matchmaker là Phase 3; Phase 1–2 client kết nối trực tiếp. Không API nào trong
`core`/`server`/`client` được giả định matchmaker tồn tại.

## Quyết định 4 — Colyseus cho room management, bypass schema sync

**Nội dung:** Dùng Colyseus (hiện `^0.17.10`) lấy room lifecycle, seat reservation,
matchmaking primitives; **không dùng** hệ thống `@colyseus/schema` state sync.

**Lý do (từ tài liệu khởi tạo):** Room lifecycle tự viết tốn thời gian mà không khác biệt;
nhưng schema sync của Colyseus không tối ưu cho physics snapshot 30Hz — mình cần binary
tự đóng gói + quantization + delta (quyết định ở dòng Serialization). Snapshot gửi qua
`sendBytes()`/broadcast bytes.

**Hệ quả:** room state (theo nghĩa Colyseus) để trống; toàn bộ state nằm trong Rapier world
+ cấu trúc riêng của tick loop. Transport dùng uWebSockets.js qua
`@colyseus/uwebsockets-transport` (lý do pnpm cần `blockExoticSubdeps: false` — xem
[002](002-repo-structure.md) §4).

**Rủi ro / khi nào xem lại:** nếu về sau phần Colyseus dùng đến chỉ còn là cái vỏ mỏng
(lifecycle + reservation) mà upgrade Colyseus gây ma sát, có thể tự viết phần vỏ đó —
nhưng chỉ cân nhắc khi ma sát thật sự xảy ra.

## Quyết định 5 — Snapshot strategy: ring buffer ~1 giây

**Nội dung:** Ring buffer chứa kết quả `takeSnapshot()` (Uint8Array), giới hạn ~1 giây.
Với 30Hz tick = 30 slot. Dùng cho: (a) reconciliation phía client — restore về tick cũ
rồi replay input; (b) lag compensation phía server — rewind khi hit detection (Phase 2).

**Đã lường trước:** world lớn → cân nhắc snapshot thủ công chỉ dynamic bodies quan trọng
thay vì cả world. Quyết định dựa trên benchmark 50/200/500 bodies ([008](008-roadmap.md) §4).

## Quyết định 6 — Render tách khỏi framework

**Nội dung:** Core chỉ expose interpolated state (position/rotation/custom fields đã nội
suy tại thời điểm render). Render adapter (Pixi/Three/Unity WebGL) là code mẫu ngoài core.

**Hệ quả:** API client dạng "pull": mỗi rAF frame, game gọi
`client.getRenderState(now)` → nhận danh sách entity + transform đã nội suy → tự vẽ.
Không callback render, không giả định game loop của engine nào.

## Các lựa chọn còn lại

- **Transport — uWebSockets.js:** nhanh hơn `ws` nhiều lần (đặc biệt broadcast nhiều
  connection); expose trực tiếp ra internet, **không** proxy qua Cloudflare (WS proxy thêm
  latency + buffering, vô nghĩa với game realtime).
- **Runtime — Node.js:** ổn định, Rapier WASM + uWS đều first-class. Bun chỉ là thử nghiệm
  sau khi mọi thứ chạy, không phải mục tiêu.
- **Serialization — tự viết:** chi tiết ở [005](005-serialization.md). Lý do không dùng
  msgpack/protobuf/schema có sẵn: cần quantization 16-bit fixed-point và delta compression
  bit-level — thứ các format tổng quát không làm được gọn.
