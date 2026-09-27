import { parentPort, workerData } from 'node:worker_threads';

import type { SmokeJob } from './report.ts';
import { runSmokeJob } from './smoke.ts';

/**
 * Worker-thread entry of the smoke bundle (`bundle.ts`). The CLI runs the game here rather than in
 * its own thread so a script stuck in an endless loop can still be stopped: `Worker.terminate()`
 * interrupts synchronous JavaScript, a timer in the same thread never fires.
 */

// Compiled project scripts carry inline source maps: stacks name `scripts/Foo.ts:12`.
process.setSourceMapsEnabled(true);

const imports = {
  runtime: new URL('./runtime.mjs', import.meta.url).href,
  three: new URL('./three.mjs', import.meta.url).href,
};

const outcome = await runSmokeJob(workerData as SmokeJob, imports);
parentPort?.postMessage(outcome);
