/**
 * Startup gate on the secrets this server signs with.
 *
 * `config.ts` gives `JWT_SECRET` a development fallback so `npm run dev` needs no `.env`. That
 * fallback is a published constant: a deployment that runs on it hands anyone who has read this
 * repository the ability to mint a session cookie for any account — including an admin one, because
 * `requireAdmin` trusts whatever row the forged `userId` resolves to. Nothing downstream can detect
 * that, so the only place to stop it is before the server opens a port.
 *
 * Hence: **production must fail to start**, rather than warn and serve. The failure is loud,
 * immediate and fixed by setting one variable; the alternative is a deployment that looks healthy
 * while being unauthenticated.
 *
 * `ROOMS_JWT_SECRET` is checked only when it is set explicitly. Left unset it *is* `JWT_SECRET`
 * (`config.ts`), which this function has already ruled on — validating the resolved value would
 * report the same problem twice under a name the operator never configured.
 */

/** The development fallback in `config.ts`. Never valid in production. */
export const DEFAULT_JWT_SECRET = 'change-me-in-production';

/**
 * Minimum secret length. Matches what the Room Fabric requires of the HS256 key it verifies with
 * (`Rooms__Auth__JwtSecret`, >= 32 bytes), so a secret this server accepts is one the fabric will
 * too — a shorter one would pass here and then fail over there, at runtime, per token.
 */
export const MIN_SECRET_BYTES = 32;

/** The environment slice the check reads. Passed in so it can be tested without touching `process`. */
export interface PreflightEnv {
  readonly NODE_ENV?: string | undefined;
  readonly JWT_SECRET?: string | undefined;
  readonly ROOMS_JWT_SECRET?: string | undefined;
}

/** Raised when production configuration is unsafe. Carries every problem, not just the first. */
export class ConfigPreflightError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      `Refusing to start: unsafe production configuration.\n` +
        problems.map(problem => `  - ${problem}`).join('\n')
    );
    this.name = 'ConfigPreflightError';
  }
}

function describeSecret(name: string, value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return `${name} is not set.`;
  }

  if (value === DEFAULT_JWT_SECRET) {
    return `${name} is still the development default ("${DEFAULT_JWT_SECRET}").`;
  }

  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < MIN_SECRET_BYTES) {
    return `${name} is ${bytes} bytes; at least ${MIN_SECRET_BYTES} are required.`;
  }

  return null;
}

/**
 * Every problem with the given environment, or an empty array when it is safe to start.
 *
 * Outside production this is always empty: the development fallback exists precisely so a fresh
 * checkout runs without an `.env`, and turning that into a hard failure would only teach people to
 * copy the default secret into their shell.
 */
export function checkProductionConfig(env: PreflightEnv): string[] {
  if (env.NODE_ENV !== 'production') {
    return [];
  }

  const problems: string[] = [];

  const jwtProblem = describeSecret('JWT_SECRET', env.JWT_SECRET);
  if (jwtProblem) {
    problems.push(jwtProblem);
  }

  // Only when overridden — see the file comment.
  if (env.ROOMS_JWT_SECRET !== undefined) {
    const roomsProblem = describeSecret('ROOMS_JWT_SECRET', env.ROOMS_JWT_SECRET);
    if (roomsProblem) {
      problems.push(roomsProblem);
    }
  }

  return problems;
}

/** {@link checkProductionConfig}, as a gate. Throws {@link ConfigPreflightError} on any problem. */
export function assertProductionConfig(env: PreflightEnv = process.env): void {
  const problems = checkProductionConfig(env);
  if (problems.length > 0) {
    throw new ConfigPreflightError(problems);
  }
}
