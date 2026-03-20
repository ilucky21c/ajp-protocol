# Agent Job Protocol (AJP)
**Version 0.1 — Provenance Protocol Family**

---

## What is AJP?

AJP is the standard interaction layer for the agent internet.

It defines how any party — a human, an agent, or an orchestrator — hands a job
to another agent, tracks its progress, and receives the result. The envelope is
always the same. The task inside varies by domain.

Think of it as HTTP for agent work. HTTP defines how messages travel across the
web without caring what the content is. AJP defines how jobs travel between
agents without caring what the job is.

It is intentionally minimal. Three endpoints. Three message types. JSON
throughout. Runs over standard HTTP. No new infrastructure required.

---

## Design principles

**One envelope, any task.** The JobOffer wrapper is universal. The `task` field
inside is yours to define. An agent that searches the web and an agent that
processes invoices use the same protocol.

**Trust is built in, not bolted on.** Every JobOffer is signed by the sender.
Every receiver verifies the sender against the Provenance index before accepting.
Trust verification is part of the protocol, not optional middleware.

**Three parties, same protocol.** A human hiring an agent, an agent hiring an
agent, and an orchestrator delegating to sub-agents all use identical message
types. The `from` field distinguishes them.

**Async by default.** Jobs are accepted and executed asynchronously. The
`callback` field tells the receiver where to send the result. Polling via
`GET /jobs/:id` is also supported for simpler implementations.

---

## The three use cases

### 1. Human hiring an agent

A human (or a platform acting on their behalf) sends a JobOffer to an agent.
The `from.type` is `human`. No Provenance verification of the sender is required
— humans are not indexed agents. Platform-level auth handles human identity.

```
Human / Platform  ──JobOffer──►  Agent
                  ◄──JobResult──
```

### 2. Agent hiring an agent

An agent sends a JobOffer to another agent. The `from.type` is `agent`. The
receiving agent MUST verify the sender's Provenance ID before accepting.
The sender must have `delegate:agents` in its declared capabilities.

```
Agent A  ──JobOffer──►  Agent B
         ◄──JobResult──
```

### 3. Orchestrator delegating to sub-agents

An orchestrator (itself an agent with a Provenance ID) breaks a task into
subtasks and delegates each to a specialist agent. The full chain is auditable —
every job references its `parent_job_id`, allowing reconstruction of the
complete execution tree.

```
Orchestrator ──JobOffer──► Sub-agent A
             ──JobOffer──► Sub-agent B
             ◄──JobResult── Sub-agent A
             ◄──JobResult── Sub-agent B
```

---

## Endpoints

Every AJP-compliant agent exposes three endpoints:

### POST /jobs
Receive a new job offer.

**Request body:** `JobOffer`
**Response 202:** `{ job_id, status: "accepted" }`
**Response 400:** `{ error, reason }` — malformed offer
**Response 403:** `{ error, reason }` — trust check failed
**Response 402:** `{ error, reason }` — budget insufficient
**Response 429:** `{ error, retry_after }` — agent busy

### GET /jobs/:job_id
Check the status of a job.

**Response 200:** `JobStatus`
**Response 404:** job not found

### POST /jobs/:job_id/ack
Confirm result received. Triggers payment settlement if applicable.

**Request body:** `{ received: true, feedback?: string }`
**Response 200:** `{ settled: true }`

---

## Message types

### JobOffer

```json
{
  "ajp": "0.1",
  "job_id": "job_01J8X2K9M3N4P5Q6R7S8T9U0V1",
  "parent_job_id": null,

  "from": {
    "type": "human",
    "id": "user_abc123",
    "provenance_id": null
  },

  "to": {
    "provenance_id": "provenance:github:alice/research-assistant"
  },

  "task": {
    "type": "research",
    "instruction": "Find the three most cited papers on transformer attention mechanisms published in 2024. Return titles, authors, citation counts, and a 2-sentence summary of each.",
    "input": {},
    "output_format": "json"
  },

  "context": {
    "credentials": {},
    "memory": [],
    "constraints": []
  },

  "budget": {
    "max_usd": 0.50,
    "max_seconds": 120,
    "max_llm_tokens": 10000
  },

  "callback": {
    "url": "https://clawmarket.com/api/jobs/job_01J8X2K9M3N4P5Q6R7S8T9U0V1/result",
    "headers": { "Authorization": "Bearer token_xyz" }
  },

  "issued_at": "2026-03-05T10:00:00Z",
  "expires_at": "2026-03-05T10:02:00Z",

  "signature": "sha256:a1b2c3d4..."
}
```

### JobStatus

```json
{
  "ajp": "0.1",
  "job_id": "job_01J8X2K9M3N4P5Q6R7S8T9U0V1",
  "status": "running",
  "progress": 0.4,
  "message": "Found 2 of 3 papers, searching for third",
  "started_at": "2026-03-05T10:00:01Z",
  "updated_at": "2026-03-05T10:00:08Z",
  "estimated_completion": "2026-03-05T10:00:20Z"
}
```

Status values: `accepted` `running` `completed` `failed` `rejected` `expired`

### JobResult

```json
{
  "ajp": "0.1",
  "job_id": "job_01J8X2K9M3N4P5Q6R7S8T9U0V1",
  "status": "completed",

  "output": {
    "papers": [
      {
        "title": "Flash Attention 3",
        "authors": ["Tri Dao", "Daniel Y. Fu"],
        "citations": 412,
        "summary": "..."
      }
    ]
  },

  "usage": {
    "llm_tokens": 4821,
    "duration_seconds": 18,
    "cost_usd": 0.12
  },

  "agent": {
    "provenance_id": "provenance:github:alice/research-assistant",
    "version": "1.2.0",
    "model": { "provider": "anthropic", "model_id": "claude-sonnet-4-5" }
  },

  "completed_at": "2026-03-05T10:00:19Z",
  "signature": "sha256:e5f6g7h8..."
}
```

---

## Trust verification

When `from.type` is `agent`, the receiving agent MUST run a trust check before
accepting the job. Using the `provenance-protocol` SDK:

```js
import { provenance } from 'provenance-protocol';

const result = await provenance.gate(offer.from.provenance_id, {
  requireDeclared: true,
  requireConstraints: [],        // add what your agent requires
  requireClean: true,
  requireMinAge: 7,              // don't accept jobs from brand-new agents
});

if (!result.allowed) {
  return res.status(403).json({ error: 'Trust check failed', reason: result.reason });
}
```

For `from.type === 'human'`, trust verification is handled by the platform
(ClawMarket, SkillsMP, etc.) before the JobOffer is issued.

---

## Signature

Every JobOffer and JobResult is signed by the sender. The signature covers the
full message body excluding the `signature` field itself.

```
signature = "sha256:" + hex(HMAC-SHA256(JSON.stringify(body_without_signature), sender_secret))
```

Receiving agents verify signatures before processing. The `ajp-protocol` SDK
handles signing and verification automatically.

---

## Adding AJP to your agent

### Expose the three endpoints

```js
import { AJPServer } from 'ajp-protocol';

const server = new AJPServer({
  provenanceId: 'provenance:github:alice/research-assistant',
  secret: process.env.AJP_SECRET,
  onJob: async (job) => {
    // your agent logic here
    return { papers: [...] };
  },
});

// Express / Next.js / any HTTP framework
app.post('/jobs',         server.receive());
app.get('/jobs/:id',      server.status());
app.post('/jobs/:id/ack', server.ack());
```

### Send a job to another agent

```js
import { AJPClient } from 'ajp-protocol';

const client = new AJPClient({
  from: { type: 'agent', provenance_id: 'provenance:github:alice/orchestrator' },
  secret: process.env.AJP_SECRET,
});

const result = await client.send(
  'provenance:github:bob/pdf-extractor',
  {
    type: 'extract',
    instruction: 'Extract all tables from this PDF',
    input: { url: 'https://example.com/report.pdf' },
  },
  { max_usd: 0.25, max_seconds: 60 }
);
```

---

## PROVENANCE.yml integration

Agents that implement AJP should declare it:

```yaml
provenance: "0.1"
name: "Research Assistant"

capabilities:
  - read:web
  - ajp:receiver      # this agent accepts AJP jobs
  - ajp:sender        # this agent can send AJP jobs to others

ajp:
  endpoint: "https://alice.dev/api/agent/jobs"
  version: "0.1"
```

The Provenance crawler reads the `ajp.endpoint` field and indexes it. Senders
can discover an agent's AJP endpoint without out-of-band communication.

---

## Versioning

The `ajp` field in every message declares the spec version. `0.1` is the current
version. Future versions add fields, never remove them.

---

*AJP v0.1 — Provenance Protocol Family — MIT License*
*https://provenance.dev/ajp*
*https://github.com/provenance-protocol/ajp*
