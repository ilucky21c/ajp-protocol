/**
 * AJP — Signing and Validation Utilities
 * Consistent with provenance-protocol SDK conventions.
 */

import crypto, { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'crypto';

// ── Signing ───────────────────────────────────────────────────────────────

/**
 * Canonical form for signing — sorts keys, excludes `signature` field.
 * Used by both HMAC and Ed25519 paths for consistency.
 */
function _canonical(body) {
  const { signature: _, ...rest } = body;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Sign a message body with HMAC-SHA256.
 * Used for human callers (no Provenance identity).
 */
export function sign(body, secret) {
  const hash = crypto.createHmac('sha256', secret).update(_canonical(body)).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Verify an HMAC-SHA256 signature. Returns true if valid.
 */
export function verify(body, secret) {
  if (!body.signature?.startsWith('sha256:')) return false;
  const expected = sign(body, secret);
  return crypto.timingSafeEqual(
    Buffer.from(body.signature),
    Buffer.from(expected)
  );
}

/**
 * Sign a message body with Ed25519.
 * Used by agents and orchestrators — consistent with provenance-protocol/keygen.js.
 *
 * @param {object} body             Message body (signature field excluded automatically)
 * @param {string} privateKeyBase64 Base64 PKCS8 DER private key (PROVENANCE_PRIVATE_KEY)
 * @returns {string}                Signature string: "ed25519:<base64>"
 */
export function signWithKey(body, privateKeyBase64) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = nodeSign(null, Buffer.from(_canonical(body), 'utf8'), privateKey);
  return `ed25519:${sig.toString('base64')}`;
}

/**
 * Verify an Ed25519 signature using a public key from the Provenance index.
 *
 * @param {object} body            Message body including signature field
 * @param {string} publicKeyBase64 Base64 SPKI DER public key (from Provenance profile)
 * @returns {boolean}
 */
export function verifyWithKey(body, publicKeyBase64) {
  if (!body.signature?.startsWith('ed25519:')) return false;
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const sigBuffer = Buffer.from(body.signature.slice('ed25519:'.length), 'base64');
  return nodeVerify(null, Buffer.from(_canonical(body), 'utf8'), publicKey, sigBuffer);
}

// ── Job ID generation ─────────────────────────────────────────────────────

/**
 * Generate a unique job ID.
 * Format: job_ + timestamp_ms (base36) + cryptographically random suffix (base36)
 * Sortable, URL-safe, no external deps.
 */
export function generateJobId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `job_${ts}${rand}`;
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Validate a JobOffer has required fields.
 * Returns { valid, errors }.
 */
export function validateOffer(offer) {
  const errors = [];

  if (!offer.ajp)          errors.push('missing: ajp');
  if (!offer.job_id)       errors.push('missing: job_id');
  if (!offer.from?.type)   errors.push('missing: from.type');
  else if (!['human', 'agent', 'orchestrator'].includes(offer.from.type)) errors.push('from.type must be human, agent, or orchestrator');
  if (!offer.to?.provenance_id) errors.push('missing: to.provenance_id');
  if (!offer.task?.type)   errors.push('missing: task.type');
  if (!offer.task?.instruction) errors.push('missing: task.instruction');
  if (!offer.budget?.max_usd && offer.budget?.max_usd !== 0) errors.push('missing: budget.max_usd');
  if (!offer.issued_at)    errors.push('missing: issued_at');
  if (!offer.expires_at)   errors.push('missing: expires_at');
  if (!offer.signature)    errors.push('missing: signature');

  if (offer.from?.type === 'agent' || offer.from?.type === 'orchestrator') {
    if (!offer.from.provenance_id) errors.push('from.provenance_id required when type is agent/orchestrator');
  }

  // Check expiry
  if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
    errors.push('offer has expired');
  }

  return { valid: errors.length === 0, errors };
}

// ── Status helpers ────────────────────────────────────────────────────────

export const JOB_STATUS = {
  ACCEPTED:  'accepted',
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  REJECTED:  'rejected',
  EXPIRED:   'expired',
};

export const FROM_TYPE = {
  HUMAN:        'human',
  AGENT:        'agent',
  ORCHESTRATOR: 'orchestrator',
};
