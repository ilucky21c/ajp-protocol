/**
 * AJP — Signing and Validation Utilities
 * Consistent with provenance-protocol SDK conventions.
 */

import crypto from 'crypto';

// ── Signing ───────────────────────────────────────────────────────────────

/**
 * Sign a message body with HMAC-SHA256.
 * Excludes the `signature` field from the hash input.
 */
export function sign(body, secret) {
  const { signature: _, ...rest } = body;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  const hash = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Verify a signed message. Returns true if valid.
 */
export function verify(body, secret) {
  if (!body.signature) return false;
  const expected = sign(body, secret);
  return crypto.timingSafeEqual(
    Buffer.from(body.signature),
    Buffer.from(expected)
  );
}

// ── Job ID generation ─────────────────────────────────────────────────────

/**
 * Generate a unique job ID.
 * Format: job_ + timestamp_ms (base36) + random (base36)
 * Sortable, URL-safe, no external deps.
 */
export function generateJobId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
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
