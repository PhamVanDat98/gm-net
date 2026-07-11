# gm-net — Bộ tài liệu thiết kế

Bộ tài liệu này diễn giải chi tiết [BRAINSTORM.md](../BRAINSTORM.md) — tài liệu khởi tạo
dự án (2026-07-11) — thành mức đủ để bắt tay vào code. **BRAINSTORM.md là nguồn sự thật
gốc**; khi hai bên mâu thuẫn, sửa design doc theo BRAINSTORM hoặc cập nhật cả hai một cách
có chủ đích.

## Quy ước đánh dấu

Mỗi tài liệu phân biệt rõ hai loại nội dung:

- **[CHỐT]** — điều đã được quyết định trong tài liệu khởi tạo. Không đổi nếu chưa thảo luận lại.
- **[ĐỀ XUẤT]** — diễn giải kỹ thuật thêm để đủ chi tiết triển khai (con số cụ thể, format,
  thuật toán). Có thể chỉnh khi code va thực tế, nhưng đổi thì cập nhật doc.

## Kế hoạch triển khai

[IMPLEMENTATION.md](IMPLEMENTATION.md) — bản đồ milestone M1–M14 với task mức file/module,
tiêu chí nghiệm thu, test đi kèm, rủi ro & điểm thoát. Đây là tài liệu điều phối khi code;
các design doc dưới đây là đặc tả mà kế hoạch tham chiếu.

## Danh sách tài liệu

| # | Tài liệu | Nội dung | Phase liên quan |
|---|---|---|---|
| 001 | [Kiến trúc tổng thể](design/001-architecture.md) | Thành phần, luồng dữ liệu, nguyên tắc cốt lõi | Tất cả |
| 002 | [Monorepo & tooling](design/002-repo-structure.md) | Cấu trúc package, dependency graph, toolchain | Tất cả |
| 003 | [Tech stack & quyết định](design/003-tech-stack.md) | 6 quyết định đã chốt + lý do + rủi ro | Tất cả |
| 004 | [Core netcode](design/004-netcode.md) | Fixed timestep, input, prediction, reconciliation, interpolation, clock sync | Phase 1 |
| 005 | [Binary serialization](design/005-serialization.md) | Bit-packing, quantization, delta compression | Phase 1–2 |
| 006 | [Server & rooms](design/006-server-rooms.md) | Colyseus, tick loop, lag compensation, AOI, reconnect | Phase 1–2 |
| 007 | [Matchmaker](design/007-matchmaker.md) | Queue, server registry, Redis | Phase 3 |
| 008 | [Roadmap & kiểm chứng](design/008-roadmap.md) | Phase checklist, tuần đầu, definition of done, benchmark | Tất cả |

## Trạng thái hiện tại (2026-07-11)

- Scaffold monorepo xong, build/test/typecheck xanh.
- Spike Rapier `takeSnapshot`/`restoreSnapshot` **PASS** — replay identical bit-perfect
  (`packages/physics-2d/test/snapshot-spike.test.ts`).
- `FixedTimestep` accumulator trong `@gm-net/core` đã có + test.
- Tiếp theo: bước 3–4 tuần đầu (input sequence protocol, demo 1 box prediction + reconciliation)
  — xem [008](design/008-roadmap.md).
