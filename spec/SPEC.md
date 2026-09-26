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
Every receiver verifies the sender against the sender's own signed Provenance
declaration before accepting — offline, with no index involved. Trust
verification is part of the protocol, not optional middleware.

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
— humans do not publish agent declarations. Platform-level auth handles human identity.

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
    "provenance_id": null,
    "declaration_url": null
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

`from.declaration_url` is where the sender's signed declaration is published.
Agent and orchestrator senders SHOULD provide it: it is what lets a receiver
establish the sender's key offline rather than trusting a third-party index.
`null` for human senders, whose identity is carried by the platform's signature.

---

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

  "constraints_asserted": ["no:pii", "no:persist:data"],

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
  "signature": "ed25519:base64..."
}
```

`constraints_asserted` lists the constraints the agent declares it honored during this job. The field is included in the signed payload — the signature ties the assertion to the key in the agent's declaration. Self-reported, but attributable: a false assertion is a cryptographic receipt of the lie, which the receiver can hand to any attester as evidence (a Provenance `report` attestation can reference it).

---

## Trust verification

Establishing whether to accept a job from another agent splits into two
questions, and only one of them needs a network service.

### 1. Identity — MUST, and offline

*Is this signature really from the party named in `from`?*

The sender publishes its signed declaration and points at it with
`from.declaration_url`; when absent, the receiver uses the standard location its
`provenance_id` names (see *Where a declaration lives* in the Provenance
specification). The receiver fetches that file and verifies it locally:

```js
import { verifyDeclaration } from 'provenance-protocol/verify';

const result = await verifyDeclaration(declaration, { retrievedFrom: declarationUrl });
// result.valid       — signature checks against the key inside the file
// result.location    — the file was served from the location its id names
// result.fingerprint — the key's fingerprint, for rotation detection
```

A receiver MUST reject the offer unless the declaration verifies, the retrieval
location matches the `provenance_id` it claims, and that id equals
`from.provenance_id`. The sender's public key is then taken from the declaration
and used to check the offer's signature.

No index is consulted. Re-hosting a genuine declaration elsewhere fails the
location check, and forging one requires the genuine private key.

Receivers SHOULD remember the key fingerprint they saw for a `provenance_id`. A
later offer signed by a different key is a key rotation and MUST be treated as
a material change rather than a routine update.

An earlier version of this specification obtained the sender's public key from a
single index, which made signature verification depend on one service being
reachable. That is no longer permitted for identity.

### 2. Standing — SHOULD, online, and the receiver's choice

*Is that party currently in good order?* Revoked, open incidents, stale
evidence. This cannot be answered offline: the absence of news cannot be
carried in a document, so somebody has to be asked.

**Which attester to ask is the receiver's decision, not this protocol's.** One
index, several, a private attester, or none. A conformant implementation MUST
NOT hardcode a single provider.

```js
import { AJPServer, declarationKeyResolver, indexStandingCheck } from 'ajp-protocol';
import { Provenance } from 'provenance-protocol/index-client';

const index = new Provenance({ apiUrl: 'https://index.example.com' }); // an index you choose

const server = new AJPServer({
  provenanceId, privateKey, onJob,
  resolveSenderKey: declarationKeyResolver(),  // offline, the default
  trustRequirements: { requireConstraints: ['no:pii'], requireClean: true, requireMinAge: 7 },
  checkStanding: indexStandingCheck(index, { requireClean: true, requireMinAge: 7 }), // opt-in, swappable
  onStandingUnavailable: 'deny',
});
```

Requirements on **declared** fields (`requireConstraints`, `requireCapabilities`)
are checked against the sender's verified declaration, offline. Requirements on
**standing** (`requireClean`, `requireMinAge`, …) need a standing source; an
implementation MUST refuse to start with them configured and no source, rather
than accept jobs while ignoring them.

A receiver that performs a standing check MUST distinguish *checked and failed*
from *could not check*, and MUST state which way it fails when the check is
unavailable. Reporting an unreachable attester as a failed trust check turns
someone else's downtime into an accusation against the sender.

For `from.type === 'human'`, identity is established by the platform issuing the
offer, and the shared-secret signature covers it.

---

## Signature

Every JobOffer and JobResult is signed by the sender. The signature covers the
full message body excluding the `signature` field itself — every field at every
depth. `canonical(body)` is the canonical JSON defined by the Provenance
Protocol, which is the JSON Canonicalization Scheme (JCS, RFC 8785): object
keys sorted by UTF-16 code units at every depth, no insignificant whitespace.

Implementations before `ajp-protocol` 0.3 serialised only the top-level keys:
nested objects — `task`, `budget`, `from`, `to`, `context`, `output` — were
emptied before signing, so they were not covered and could be altered without
detection. A receiver MUST NOT accept such signatures. It MAY recognise one in
order to tell the sender to upgrade.

**Human senders** (no Provenance identity) — HMAC-SHA256 with a shared secret:
```
signature = "sha256:" + hex(HMAC-SHA256(canonical(body), sender_secret))
```

**Agent and orchestrator senders** — Ed25519 with the sender's registered Provenance private key:
```
signature = "ed25519:" + base64(Ed25519Sign(canonical(body), provenance_private_key))
```

The receiving server verifies agent signatures against the public key in the
sender's own verified declaration (see Trust verification). This ties every
message to a published identity without a shared secret or an index.

A sender SHOULD verify a JobResult's signature the same way, against the key in
the recipient's declaration, before relying on it.

The `ajp-protocol` SDK handles signing and verification automatically based on `from.type`.

---

## Adding AJP to your agent

### Expose the three endpoints

```js
import { AJPServer } from 'ajp-protocol';

const server = new AJPServer({
  provenanceId: 'provenance:github:alice/research-assistant',
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,
  constraints: ['no:pii', 'no:persist:data'],  // asserted in every signed result
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
provenance: "0.2"
name: "Research Assistant"

capabilities:
  - read:web
  - ajp:receiver      # this agent accepts AJP jobs
  - ajp:sender        # this agent can send AJP jobs to others

ajp:
  endpoint: "https://alice.dev/api/agent/jobs"
  version: "0.1"
```

A sender finds an agent's AJP endpoint by fetching the agent's declaration from
the location its `provenance_id` names, verifying it, and reading
`ajp.endpoint`. Because the declaration is signed and tied to its location, the
endpoint is the operator's own statement — no directory or index is needed.
Indexes may also record it, as a convenience.

---

## Implementing this specification

This specification and its JSON Schema are published under the MIT Licence.
You may implement them in any language, for any purpose, commercial or
otherwise, without permission, notification or fee.

AJP describes messages exchanged directly between agents. Nothing in it
requires contacting any particular service. Trust verification is a separate
concern, defined by the [Provenance Protocol](https://github.com/provenance-protocol/provenance-protocol);
an AJP implementation may use any verifier, or none.

---

## Versioning

The `ajp` field in every message declares the spec version. `0.1` is the current
version. Future versions add fields, never remove them.

---

*AJP v0.1 — MIT License*
*https://github.com/provenance-protocol/ajp-protocol*
