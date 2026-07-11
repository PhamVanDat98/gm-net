/**
 * @gm-net/client — client runtime: clock sync, input pipeline (redundancy +
 * adaptive lead), snapshot receiver, quanh một transport trừu tượng; prediction +
 * reconciliation (M4: `PredictionWorld`/`Reconciler` cắm qua `onSnapshot`, kèm
 * `TransformSmoother`/`PredictionMetrics`). Interpolation remote là M5. Không
 * import DOM — chạy cả Node (headless bot) lẫn browser.
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
export {
  PredictionWorld,
  type PredictionWorldOptions,
  type PredictedState,
} from './prediction.js';
export {
  Reconciler,
  quantizedDiff,
  type ReconcilerOptions,
  type ReconcileOutcome,
  type QuantizedDiff,
} from './reconcile.js';
export {
  TransformSmoother,
  type TransformSmootherOptions,
  type RenderTransform,
} from './render-state.js';
export {
  PredictionMetrics,
  type PredictionMetricsOptions,
  type PredictionMetricsSnapshot,
} from './metrics.js';
export type { ClientTransport } from './transport.js';
export {
  colyseusTransport,
  connectGameRoom,
  type ConnectOptions,
} from './colyseus-transport.js';
