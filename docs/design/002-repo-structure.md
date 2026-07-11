# 002 — Monorepo & tooling

Căn cứ: BRAINSTORM.md §2 (cấu trúc monorepo, tooling).

## 1. Cấu trúc

**[CHỐT]**

```
gm-net/
├── packages/
│   ├── core/           # netcode: prediction, reconciliation,
│   │                   # interpolation, clock sync, serialization
│   ├── physics-2d/     # adapter @dimforge/rapier2d
│   ├── physics-3d/     # adapter @dimforge/rapier3d (Phase 3)
│   ├── shared/         # simulation logic, input schema, constants
│   ├── server/         # room framework (trên Colyseus), tick loop,
│   │                   # lag compensation, AOI
│   ├── client/         # client runtime, headless mode (bot/load test)
│   └── matchmaker/     # optional: queue, server registry (Redis, Phase 3)
├── examples/
│   ├── demo-2d/        # game test kiểu top-down shooter
│   └── demo-3d/        # port sau khi 2D ổn định (Phase 3)
├── docs/               # bộ tài liệu này
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Tooling: **pnpm workspaces + TypeScript**, build bằng tsup (esbuild), test bằng vitest.

## 2. Dependency graph giữa packages

**[ĐỀ XUẤT]** — quy tắc: mũi tên chỉ được đi từ ngoài vào trong, `core` và `shared`
không phụ thuộc gì ngoài chính nó (và Rapier với physics adapter).

```
                    ┌──────────┐
                    │   core    │  ← netcode thuần, không I/O, không Colyseus
                    └─▲───▲───▲─┘
          ┌───────────┘   │   └───────────┐
    ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
    │ physics-2d │   │ physics-3d │   │  shared*   │
    └─────▲─────┘   └───────────┘   └─▲───────▲─┘
          │                           │       │
          │         ┌─────────────────┘       │
    ┌─────┴─────────┴──┐              ┌───────┴────┐
    │      server       │              │   client    │
    │ (colyseus, uWS)   │              │             │
    └───────────────────┘              └────────────┘

    matchmaker: độc lập, không phụ thuộc package nào ở trên (chỉ Redis).
    examples/demo-2d: phụ thuộc client + server + shared + physics-2d.
```

\* `shared` của **framework** chứa input schema + constants dùng chung. Simulation logic
của *từng game* sẽ nằm trong package shared *của game đó* (với demo-2d: trong example).
Framework cung cấp khuôn (interface `Simulation`), game cung cấp ruột.

Điểm cần giữ nghiêm:

- `core` **không** import Colyseus, uWebSockets, Redis, DOM — netcode thuần + serialization,
  chạy được ở mọi môi trường JS. Đây là điều kiện để client (browser) dùng chung code với server.
- `client` không import `server` và ngược lại. Thứ dùng chung phải rơi xuống `core`/`shared`.
- `matchmaker` không import gì từ game stack (quyết định 3 — tách rời hoàn toàn).

## 3. Chuẩn package

**[ĐỀ XUẤT]** (đã áp dụng khi scaffold):

- ESM-only (`"type": "module"`), TypeScript strict, target ES2022.
- `exports` trỏ thẳng `src/index.ts` trong giai đoạn dev → vitest và tsc typecheck
  cross-package chạy từ source, không cần build trước. Khi publish npm sẽ chuyển
  `exports` sang `dist/` (hoặc dùng `publishConfig`).
- Build: `tsup src/index.ts --format esm --dts --sourcemap --clean` cho mọi package.
- Test đặt tại `packages/<tên>/test/*.test.ts`, vitest config ở root gom tất cả.
- Typecheck: một `tsconfig.json` root include toàn bộ `packages/*/src|test` — một lệnh
  `pnpm typecheck` quét cả repo.

## 4. Ghi chú toolchain (kinh nghiệm thực tế trên repo này)

Những điều đã va phải khi scaffold — **đừng lặp lại**:

- **TypeScript phải ghim `^5.x`** (hiện `^5.9.3`). TypeScript 7 (compiler Go) làm
  `rollup-plugin-dts` trong tsup crash (`useCaseSensitiveFileNames` undefined) → hỏng
  bước sinh `.d.ts`. Chỉ nâng khi tsup đã hỗ trợ.
- `pnpm-workspace.yaml` có `blockExoticSubdeps: false` — **bắt buộc**, vì uWebSockets.js
  phân phối qua git (không lên npm) và là dependency của `@colyseus/uwebsockets-transport`.
- `allowBuilds`: `esbuild` và `msgpackr-extract` cần chạy postinstall script (native binding).
  Thêm dep native mới thì phải duyệt tương tự.
- Node 22, pnpm 11 (ghim qua trường `packageManager` — CI đọc từ đây).

## 5. CI

**[CHỐT — kế thừa]** `.github/workflows/ci.yml` giữ từ repo cũ vì vẫn khớp: mỗi push/PR
chạy `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm test` trên ubuntu, Node 22.
Lưu ý CI chạy Linux còn máy dev là Windows — uWebSockets.js có prebuilt cho cả hai,
nhưng khi thêm native dep mới cần kiểm tra cả hai nền tảng.
