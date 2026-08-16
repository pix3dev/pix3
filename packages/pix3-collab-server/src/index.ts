import 'dotenv/config';
import { config } from './config.js';
import { assertProductionConfig, ConfigPreflightError } from './core/config-preflight.js';

console.log(`[pix3-collab] Starting server...`);
console.log(`[pix3-collab] Unified port: ${config.PORT}`);
console.log(`[pix3-collab] Collaboration path: ${config.COLLABORATION_PATH}`);

// Before anything opens a port or touches the database: a production deployment running on the
// development JWT fallback is unauthenticated, and nothing further downstream can notice.
try {
  assertProductionConfig(process.env);
} catch (error) {
  if (error instanceof ConfigPreflightError) {
    // Printed on its own, not through the generic handler below: this is an operator's checklist,
    // not a crash, and a stack trace would bury the one line that says what to set.
    console.error(`[pix3-collab] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

try {
  // Dynamic import to ensure dotenv is loaded first
  const { startServer } = await import('./server.js');
  await startServer();
} catch (error) {
  console.error('[pix3-collab] Fatal startup error', error);
  process.exit(1);
}
