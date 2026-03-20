/**
 * AJPServer — Receive and process jobs from any sender.
 *
 * Handles: signature verification, trust checks, job lifecycle.
 * Returns standard HTTP handler functions compatible with
 * Express, Next.js API routes, Fastify, or any Node HTTP framework.
 */

import { verify, validateOffer, JOB_STATUS, FROM_TYPE } from './utils.js';
import { Provenance } from 'provenance-protocol';

export class AJPServer {

  /**
   * @param {object} opts
   * @param {string} opts.provenanceId    — this agent's Provenance ID
   * @param {string} opts.secret          — HMAC verification secret (must match client)
   * @param {Function} opts.onJob         — async (job) => result — your agent logic
   * @param {object} [opts.trustRequirements] — applied to all agent/orchestrator senders
   * @param {boolean} [opts.trustRequirements.requireDeclared]
   * @param {string[]} [opts.trustRequirements.requireConstraints]
   * @param {boolean} [opts.trustRequirements.requireClean]
   * @param {number} [opts.trustRequirements.requireMinAge]
   * @param {number} [opts.trustRequirements.requireMinConfidence]
   * @param {string} [opts.provenanceApiUrl] — override Provenance API URL
   */
  constructor({
    provenanceId,
    secret,
    onJob,
    trustRequirements = {},
    provenanceApiUrl,
  }) {
    this.provenanceId = provenanceId;
    this.secret = secret;
    this.onJob = onJob;
    this.trustRequirements = trustRequirements;
    this.provenance = new Provenance({ apiUrl: provenanceApiUrl });

    // In-memory job store — replace with DB for production
    this.jobs = new Map();
  }

  // ── POST /jobs — receive a new job ────────────────────────────────────

  receive() {
    return async (req, res) => {
      try {
        const offer = await this._parseBody(req);

        // 1. Validate structure
        const { valid, errors } = validateOffer(offer);
        if (!valid) {
          return this._json(res, 400, { error: 'Invalid JobOffer', errors });
        }

        // 2. Verify signature
        if (!verify(offer, this.secret)) {
          return this._json(res, 401, { error: 'Invalid signature' });
        }

        // 3. Trust check — required for agent/orchestrator senders
        if (offer.from.type === FROM_TYPE.AGENT || offer.from.type === FROM_TYPE.ORCHESTRATOR) {
          const trustResult = await this.provenance.gate(
            offer.from.provenance_id,
            {
              requireDeclared: this.trustRequirements.requireDeclared ?? false,
              requireConstraints: this.trustRequirements.requireConstraints ?? [],
              requireClean: this.trustRequirements.requireClean ?? true,
              requireMinAge: this.trustRequirements.requireMinAge ?? 0,
              requireMinConfidence: this.trustRequirements.requireMinConfidence ?? 0,
            }
          );

          if (!trustResult.allowed) {
            return this._json(res, 403, {
              error: 'Trust check failed',
              reason: trustResult.reason,
            });
          }
        }

        // 4. Accept the job
        const job = {
          ...offer,
          status: JOB_STATUS.ACCEPTED,
          accepted_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          output: null,
          error: null,
          usage: { llm_tokens: 0, duration_seconds: 0, cost_usd: 0 },
        };

        this.jobs.set(offer.job_id, job);

        // 5. Respond immediately — execution is async
        this._json(res, 202, { job_id: offer.job_id, status: JOB_STATUS.ACCEPTED });

        // 6. Execute in background
        this._execute(offer.job_id);

      } catch (e) {
        this._json(res, 500, { error: e.message });
      }
    };
  }

  // ── GET /jobs/:id — status check ─────────────────────────────────────

  status() {
    return async (req, res) => {
      try {
        const jobId = this._extractJobId(req);
        const job = this.jobs.get(jobId);

        if (!job) {
          return this._json(res, 404, { error: 'Job not found', job_id: jobId });
        }

        const response = {
          ajp: '0.1',
          job_id: job.job_id,
          status: job.status,
          started_at: job.started_at,
          updated_at: job.updated_at || job.accepted_at,
        };

        if (job.status === JOB_STATUS.COMPLETED) {
          response.output = job.output;
          response.usage = job.usage;
          response.agent = {
            provenance_id: this.provenanceId,
          };
          response.completed_at = job.completed_at;
        }

        if (job.status === JOB_STATUS.FAILED) {
          response.message = job.error;
        }

        this._json(res, 200, response);
      } catch (e) {
        this._json(res, 500, { error: e.message });
      }
    };
  }

  // ── POST /jobs/:id/ack — confirm receipt ──────────────────────────────

  ack() {
    return async (req, res) => {
      try {
        const jobId = this._extractJobId(req);
        const job = this.jobs.get(jobId);

        if (!job) {
          return this._json(res, 404, { error: 'Job not found' });
        }

        job.acknowledged_at = new Date().toISOString();
        this.jobs.set(jobId, job);

        // Payment settlement hook — implement when integrating with ClawMarket
        // await this._settlePayment(job);

        this._json(res, 200, { settled: true, job_id: jobId });
      } catch (e) {
        this._json(res, 500, { error: e.message });
      }
    };
  }

  // ── Execution ─────────────────────────────────────────────────────────

  async _execute(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const startTime = Date.now();
    job.status = JOB_STATUS.RUNNING;
    job.started_at = new Date().toISOString();
    job.updated_at = job.started_at;
    this.jobs.set(jobId, job);

    try {
      const output = await this.onJob(job);

      const durationSeconds = (Date.now() - startTime) / 1000;
      job.status = JOB_STATUS.COMPLETED;
      job.output = output;
      job.completed_at = new Date().toISOString();
      job.updated_at = job.completed_at;
      job.usage.duration_seconds = durationSeconds;
      this.jobs.set(jobId, job);

      // Deliver result via callback if set
      if (job.callback?.url) {
        await this._deliverCallback(job);
      }

    } catch (e) {
      job.status = JOB_STATUS.FAILED;
      job.error = e.message;
      job.updated_at = new Date().toISOString();
      this.jobs.set(jobId, job);
    }
  }

  async _deliverCallback(job) {
    try {
      await fetch(job.callback.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...job.callback.headers,
        },
        body: JSON.stringify({
          ajp: '0.1',
          job_id: job.job_id,
          status: job.status,
          output: job.output,
          usage: job.usage,
          agent: { provenance_id: this.provenanceId },
          completed_at: job.completed_at,
        }),
      });
    } catch (e) {
      console.error(`[AJP] Callback delivery failed for ${job.job_id}:`, e.message);
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────

  _json(res, status, body) {
    // Works with Express (res.status().json()) and Next.js (NextResponse)
    if (typeof res.status === 'function' && typeof res.json === 'function') {
      return res.status(status).json(body);
    }
    // Raw Node http.ServerResponse
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async _parseBody(req) {
    // Next.js App Router: req.json()
    if (typeof req.json === 'function') return req.json();
    // Express: req.body already parsed
    if (req.body) return req.body;
    // Raw Node: read stream
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
  }

  _extractJobId(req) {
    // Express: req.params.id
    if (req.params?.id) return req.params.id;
    // Next.js: params from route segment
    if (req.nextUrl) {
      const parts = req.nextUrl.pathname.split('/');
      return parts[parts.length - 1] === 'ack'
        ? parts[parts.length - 2]
        : parts[parts.length - 1];
    }
    // Fallback: parse URL
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    return parts[parts.length - 1] === 'ack' ? parts[parts.length - 2] : parts[parts.length - 1];
  }
}
