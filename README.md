# ajp-protocol

The Agent Job Protocol — standard interaction layer for the agent internet.
Built on the [Provenance Protocol](https://github.com/provenance-protocol/provenance-protocol):
agents find and verify each other from their own signed declarations, with no
directory or index in between.

```bash
npm install ajp-protocol
```

---

## What it does

AJP defines how any party — a human, an agent, or an orchestrator — hands a
job to another agent, tracks its progress, and receives the result.

Three endpoints. Three message types. Runs over standard HTTP.
Every message is signed in full; identity is checked offline.

---

## Quick start — receiving agent

Add three routes to your agent. AJP handles verification, trust checks,
and job lifecycle automatically.

```js
import { AJPServer, declarationKeyResolver, indexStandingCheck } from 'ajp-protocol';
import { Provenance } from 'provenance-protocol/index-client';
import express from 'express';

const app = express();
app.use(express.json());

const server = new AJPServer({
  provenanceId: 'provenance:github:alice/research-assistant',
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,  // signs results with Ed25519

  // Constraints from your PROVENANCE.yml — asserted in every signed JobResult.
  // Creates a cryptographic receipt: "this agent declared it honored these constraints for this job."
  constraints: ['no:pii', 'no:persist:data'],

  // Optional: accept human callers (platforms) with a shared HMAC secret
  secret: process.env.AJP_SECRET,

  // Identity: resolved from the sender's own signed declaration, offline.
  // This is the default — no index is consulted to check a signature.
  resolveSenderKey: declarationKeyResolver(),

  // Requirements on what the sender declares are checked offline, against
  // its verified declaration.
  trustRequirements: { requireCapabilities: ['delegate:agents'] },

  // Standing (revocation, incidents, freshness) cannot be checked offline, so
  // it is opt-in and you choose whom to ask. Omit it entirely to accept any
  // sender whose identity verifies.
  checkStanding: indexStandingCheck(
    new Provenance({ apiUrl: 'https://index.example.com' }),   // an index you choose
    { requireClean: true, requireMinAge: 7 }
  ),
  onStandingUnavailable: 'deny',   // an unreachable attester is not an accusation

  // Your agent logic — receives the job, returns the result
  onJob: async (job) => {
    const papers = await searchPapers(job.task.instruction);
    return { papers };
  },
});

app.post('/jobs',         server.receive());
app.get('/jobs/:id',      server.status());
app.post('/jobs/:id/ack', server.ack());

app.listen(3000);
```

---

## Quick start — sending agent or platform

```js
import { AJPClient } from 'ajp-protocol';

const client = new AJPClient({
  from: {
    type: 'agent',   // 'human' | 'agent' | 'orchestrator'
    provenance_id: 'provenance:github:alice/orchestrator',
  },
  // Where the recipient's endpoint comes from: by default its own signed
  // declaration, found from its provenance id. No index involved.
  // Agent/orchestrator callers sign with Ed25519 — no shared secret needed
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,
});

const result = await client.send(
  'provenance:domain:research.bob.example',     // who to hire
  {
    type: 'research',
    instruction: 'Find the top 3 papers on transformer attention in 2024.',
    output_format: 'json',
  },
  {
    max_usd: 0.50,       // budget cap
    max_seconds: 120,    // timeout
  }
);

console.log(result.output);
// { papers: [...] }
```

---

## Three use cases, one protocol

### Human hiring an agent
```js
// Human callers use a shared HMAC secret (agreed out of band with the agent)
const client = new AJPClient({
  from: { type: 'human', id: 'user_alice_123' },
  secret: process.env.AJP_SECRET,
});
const result = await client.send(agentId, task, budget);
```

### Agent hiring an agent
```js
// Agent callers sign with Ed25519 — no shared secret, no prior setup
// The receiving agent verifies against the key in your published declaration
const client = new AJPClient({
  from: { type: 'agent', provenance_id: 'provenance:github:alice/pipeline' },
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,
});
const result = await client.send(agentId, task, budget);
```

### Orchestrator delegating to sub-agents (with audit chain)
```js
const [resultA, resultB] = await Promise.all([
  client.send(agentA, taskA, budget, { parentJobId: parentJobId }),
  client.send(agentB, taskB, budget, { parentJobId: parentJobId }),
]);
// All sub-jobs linked to parent — full execution tree is auditable
```

---

## How trust works

Two separate questions, and only one of them needs a network service.

```
AJPServer.receive()
  → validate the offer's shape
  → IDENTITY  (offline, always)
      fetch the sender's declaration (from.declaration_url, or the
      standard location its provenance id names)
      → does it verify against the key inside it?
      → was it served from the location its provenance id names?
      → is that id the one the offer claims?
      → has this sender's key changed since last time?
      then check the offer's signature with that key
      → does the declaration promise what trustRequirements ask?
  → STANDING  (online, optional, you choose the attester)
      → revoked? open incidents? evidence stale? old enough?
      → unreachable attester → your policy, not a failed trust check
  → run onJob() only if both pass
  → 403 with a reason and a code if either does not
```

Identity never depends on anyone's uptime. Only standing does, and you decide
whose — one index, several, your own attester, or none at all.

Human senders (`from.type: 'human'`) skip Provenance verification.
Platform-level auth is assumed for humans.

---

## Declare AJP in your PROVENANCE.yml

```yaml
provenance: "0.2"
name: "Research Assistant"

capabilities:
  - read:web
  - ajp:receiver      # accepts incoming AJP jobs
  - ajp:sender        # sends AJP jobs to other agents

ajp:
  endpoint: "https://alice.dev/api/agent"
  version: "0.1"
```

Senders read `ajp.endpoint` from your signed declaration, so they can find
you without out-of-band configuration — and without trusting anyone's copy of
it. Sign the declaration with `npx provenance-protocol sign`.

---

## Next.js API route example

```js
// app/api/agent/jobs/route.js
import { AJPServer } from 'ajp-protocol';
import { NextResponse } from 'next/server';

const server = new AJPServer({
  provenanceId: process.env.PROVENANCE_ID,
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,   // signs results
  secret: process.env.AJP_SECRET,
  onJob: async (job) => {
    // your agent logic
    return { result: '...' };
  },
});

export async function POST(req) {
  return server.receive()(req, NextResponse);
}
```

---

## The protocol family

| Package | Purpose |
|---|---|
| [`provenance-protocol`](https://github.com/provenance-protocol/provenance-protocol) | Declarations and attestations: sign, verify, locate — offline |
| `ajp-protocol` | Send and receive agent jobs (this package) |
| [`provenance-middleware`](https://github.com/provenance-protocol/provenance-middleware) | Serve and sign your declaration from your own service |

---

## CLI

```bash
# Send a job to any agent that publishes a declaration with ajp.endpoint
npx @ilucky21c/ajp-cli hire provenance:domain:summarizer.example.com \
  --instruction "Summarize this paper: https://arxiv.org/abs/..." \
  --budget 0.50 --timeout 60

# Check job status
npx @ilucky21c/ajp-cli jobs job_m0abc123 --endpoint https://alice-agent.example.com/api/agent
```

Requires a Provenance identity — `npx provenance-protocol keygen`, then publish a
signed declaration. `--endpoint <url>` skips resolution; `--index <url>`
resolves through an index you choose instead.

---

## Upgrading from 0.2

- **Signatures now cover the whole message.** Before 0.3 only top-level keys were
  signed and every nested field — the task, budget, sender, recipient, result —
  was left out, so a signed job could be rewritten in transit. Old and new
  versions do not interoperate; upgrade both sides. A 0.3 receiver answers an
  old-style signature with `LEGACY_SIGNATURE`.
- `AJPClient` finds the recipient from its own declaration by default.
  `provenanceApiUrl` is gone (passing it throws); use
  `resolveEndpoint: indexEndpointResolver(new Provenance({ apiUrl }))` to keep
  using an index, or `send(..., { endpoint })` to skip resolution.
- `trustRequirements.requireConstraints` / `requireCapabilities` are enforced
  offline against the sender's declaration. Standing requirements
  (`requireClean`, `requireMinAge`, …) without `checkStanding` now fail at
  startup instead of being silently ignored.

---

## Full specification

[spec/SPEC.md](./spec/SPEC.md)

---

## MIT License
