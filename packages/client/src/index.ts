/**
 * @gm-net/client — client runtime: clock sync, input pipeline (redundancy +
 * adaptive lead), snapshot receiver, quanh một transport trừu tượng. Prediction
 * (M4), reconciliation (M4) và interpolation (M5) cắm lên trên qua `onSnapshot`
 * + `unackedInputs()`. Không import DOM — chạy cả Node (headless bot) lẫn browser.
 */
export { GameClient, type GameClientOptions, type ClientMetrics } from './client.js';
export { ClockSync, type ClockSyncOptions } from './clock.js';
export {
  InputPipeline,
  InputLeadController,
  type InputPipelineOptions,
  type InputLeadOptions,
  type SampledInput,
} from './input.js';
export { SnapshotReceiver, type SnapshotListener } from './snapshot.js';
export type { ClientTransport } from './transport.js';
export {
  colyseusTransport,
  connectGameRoom,
  type ConnectOptions,
} from './colyseus-transport.js';
