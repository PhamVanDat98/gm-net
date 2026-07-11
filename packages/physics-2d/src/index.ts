/**
 * @gm-net/physics-2d — adapter cho @dimforge/rapier2d.
 *
 * Dùng bản `-compat` (WASM inline base64): cùng một package chạy được cả
 * Node lẫn browser mà không cần cấu hình loader — đúng yêu cầu "simulation
 * logic chạy hai nơi" của prediction/reconciliation.
 */
import RAPIER from '@dimforge/rapier2d-compat';

let initialized: Promise<typeof RAPIER> | undefined;

/** Khởi tạo WASM module của Rapier (idempotent). */
export function initPhysics2D(): Promise<typeof RAPIER> {
  initialized ??= RAPIER.init().then(() => RAPIER);
  return initialized;
}

export { RAPIER };
