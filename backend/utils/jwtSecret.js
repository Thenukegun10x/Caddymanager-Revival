/**
 * Single source of truth for JWT secret validation.
 * Covers PLAN.md C1 / AGENTS.md §7: never fall back to a hardcoded secret,
 * never accept the placeholder values that ship in compose/.env examples.
 */
const MIN_SECRET_LENGTH = 32;

const PLACEHOLDERS = new Set([
  'your_jwt_secret_key_here',
  'your_jwt_secret_key_for_development',
  'your_jwt_secret',
  'jwt_secret',
  'changeme',
  'change-me',
  'secret',
]);

// Used only by the test runner (NODE_ENV=test). Never reachable in prod.
const TEST_FALLBACK = 'test-jwt-secret-for-ci-only-not-for-prod';

function getJwtSecret() {
  const isTest = process.env.NODE_ENV === 'test';
  const secret = (process.env.JWT_SECRET || '').trim();

  if (!secret) {
    if (isTest) return TEST_FALLBACK;
    throw new Error(
      'JWT_SECRET must be set (32+ characters, e.g. `openssl rand -hex 32`) — refusing to start with an insecure default'
    );
  }

  if (!isTest) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET is too short (${secret.length} chars, minimum ${MIN_SECRET_LENGTH}) — generate one with \`openssl rand -hex 32\``
      );
    }
    if (PLACEHOLDERS.has(secret.toLowerCase())) {
      throw new Error('JWT_SECRET is a known placeholder — generate a real secret with `openssl rand -hex 32`');
    }
  }

  return secret;
}

module.exports = { getJwtSecret, MIN_SECRET_LENGTH, PLACEHOLDERS };
