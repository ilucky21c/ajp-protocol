/**
 * AJPClient — Send jobs to other agents.
 *
 * Used by: humans (via platforms), agents, orchestrators.
 * Consistent with provenance-protocol SDK class structure.
 */

import { sign, generateJobId, validateOffer } from './utils.js';
import { Provenance } from 'provenance-protocol';

export class AJPClient {

  /**
   * @param {object} opts
   * @param {object} opts.from          — sender identity
   * @param {string} opts.from.type     — 'human' | 'agent' | 'orchestrator'
   * @param {string} [opts.from.id]     — platform user ID (human only)
   * @param {string} [opts.from.provenance_id] — required for agent/orchestrator
   * @param {string} opts.secret        — HMAC signing secret
   * @param {string} [opts.provenanceApiUrl]   — override Provenance API URL
   * @param {number} [opts.defaultTimeoutMs]   — default job timeout in ms (30s)
   */
  constructor({ from, secret, provenanceApiUrl, defaultTimeoutMs = 30000 }) {
    this.from = from;
    this.secret = secret;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.provenance = new Provenance({ apiUrl: provenanceApiUrl });

    if ((from.type === 'agent' || from.type === 'orchestrator') && !from.provenance_id) {
      throw new Error('from.provenance_id required when type is agent or orchestrator');
    }
  }

  // ── Main send method ──────────────────────────────────────────────────

  /**
   * Send a job to an agent and wait for the result.
   *
   * @param {string} toProvenanceId   — receiving agent's Provenance ID
   * @param {object} task             — { type, instruction, input?, output_format? }
   * @param {object} [budget]         — { max_usd, max_seconds?, max_llm_tokens? }
   * @param {object} [opts]
   * @param {string} [opts.parentJobId]  — set for sub-tasks in orchestration
   * @param {object} [opts.context]      — { credentials?, memory?, constraints? }
   * @param {object} [opts.callback]     — { url, headers? } for async delivery
   * @param {number} [opts.pollIntervalMs] — how often to poll for result (2000)
   * @returns {Promise<JobResult>}
   */
  async send(toProvenanceId, task, budget = {}, opts = {}) {
    // Resolve the agent's AJP endpoint from Provenance
    const endpoint = await this._resolveEndpoint(toProvenanceId);

    // Build the job offer
    const jobId = generateJobId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (budget.max_seconds || 120) * 1000);

    const offer = {
      ajp: '0.1',
      job_id: jobId,
      parent_job_id: opts.parentJobId || null,

      from: {
        type: this.from.type,
        id: this.from.id || null,
        provenance_id: this.from.provenance_id || null,
      },

      to: { provenance_id: toProvenanceId },

      task: {
        type: task.type,
        instruction: task.instruction,
        input: task.input || {},
        output_format: task.output_format || 'json',
      },

      context: {
        credentials: opts.context?.credentials || {},
        memory: opts.context?.memory || [],
        constraints: opts.context?.constraints || [],
      },

      budget: {
        max_usd: budget.max_usd ?? 1.0,
        max_seconds: budget.max_seconds ?? 120,
        max_llm_tokens: budget.max_llm_tokens ?? 10000,
      },

      callback: opts.callback || null,
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      signature: '',
    };

    // Sign it
    offer.signature = sign(offer, this.secret);

    // Validate before sending
    const { valid, errors } = validateOffer(offer);
    if (!valid) throw new Error(`Invalid JobOffer: ${errors.join(', ')}`);

    // Send
    const res = await fetch(`${endpoint}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offer),
    });

    if (res.status === 403) {
      const body = await res.json();
      throw new Error(`Agent rejected job (trust check failed): ${body.reason}`);
    }
    if (res.status === 402) {
      const body = await res.json();
      throw new Error(`Agent rejected job (budget insufficient): ${body.reason}`);
    }
    if (res.status === 429) {
      const body = await res.json();
      throw new Error(`Agent busy. Retry after ${body.retry_after}s`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Agent returned ${res.status}: ${body.error || 'unknown error'}`);
    }

    const accepted = await res.json();

    // If async (callback provided), return the acceptance immediately
    if (opts.callback) return { job_id: accepted.job_id, status: 'accepted' };

    // Otherwise poll for result
    return this._poll(endpoint, accepted.job_id, {
      pollIntervalMs: opts.pollIntervalMs || 2000,
      timeoutMs: this.defaultTimeoutMs,
    });
  }

  // ── Polling ──────────────────────────────────────────────────────────

  async _poll(endpoint, jobId, { pollIntervalMs, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await this._sleep(pollIntervalMs);

      const res = await fetch(`${endpoint}/jobs/${jobId}`);
      if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

      const status = await res.json();

      if (status.status === 'completed') {
        // Acknowledge receipt
        await fetch(`${endpoint}/jobs/${jobId}/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ received: true }),
        }).catch((e) => {
          console.warn(`[AJP] Ack failed for ${jobId} — payment settlement may not trigger:`, e.message);
        });
        return status;
      }

      if (status.status === 'failed') {
        throw new Error(`Job failed: ${status.message || 'unknown reason'}`);
      }

      if (status.status === 'rejected') {
        throw new Error(`Job rejected: ${status.message || 'unknown reason'}`);
      }
    }

    throw new Error(`Job timed out after ${timeoutMs}ms`);
  }

  // ── Endpoint resolution ───────────────────────────────────────────────

  async _resolveEndpoint(provenanceId) {
    try {
      const profile = await this.provenance.check(provenanceId);
      if (!profile.found) throw new Error(`Agent not found in Provenance index: ${provenanceId}`);

      // AJP endpoint is stored in the agent's PROVENANCE.yml
      const endpoint = profile.provenance_yml?.ajp?.endpoint;
      if (endpoint) return endpoint.replace(/\/$/, '');

      // Fallback: derive from agent URL — unreliable, agent should declare ajp.endpoint in PROVENANCE.yml
      if (profile.url) {
        console.warn(`[AJP] No ajp.endpoint declared for ${provenanceId} — falling back to ${profile.url}/api/agent. Add ajp.endpoint to PROVENANCE.yml for reliability.`);
        return `${profile.url.replace(/\/$/, '')}/api/agent`;
      }

      throw new Error(`No AJP endpoint found for ${provenanceId}`);
    } catch (e) {
      if (e.message.includes('No AJP endpoint')) throw e;
      throw new Error(`Could not resolve endpoint for ${provenanceId}: ${e.message}`);
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
