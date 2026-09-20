import { appState } from '@/state';

/**
 * True while the turn on screen was started by the Flow autopilot rather than typed by a human.
 *
 * `phase === 'running'` is the supervisor's own claim, not a mirror of the chat status: a turn the
 * user sent leaves the autopilot at `idle` even while it is armed (see `FlowAutopilotService`). So
 * this reads as exactly what it needs to mean — "there is nobody to answer a question right now".
 *
 * A module of its own because two services need the answer — the chat loop (to keep `ask_user`
 * from ending the turn) and the tool registry (to file a `record_decision` the agent made on its
 * own as such) — and neither may import the other for it without closing an import cycle.
 */
export const isAutopilotDrivenTurn = (): boolean => {
  const autopilot = appState.ui.flowAutopilot;
  return autopilot.mode !== 'off' && autopilot.phase === 'running';
};
