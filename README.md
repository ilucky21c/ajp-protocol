# ajp-protocol

The Agent Job Protocol — standard interaction layer for the agent internet.
Part of the [Provenance Protocol](https://getprovenance.dev) family.

```bash
npm install ajp-protocol
```

---

## What it does

AJP defines how any party — a human, an agent, or an orchestrator — hands a
job to another agent, tracks its progress, and receives the result.

Three endpoints. Three message types. Runs over standard HTTP.
Trust verification via `provenance-protocol` built in.

---

## Quick start — receiving agent

Add three routes to your agent. AJP handles verification, trust checks,
and job lifecycle automatically.

```js
import { AJPServer } from 'ajp-protocol';
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

  // Trust requirements for incoming agent/orchestrator senders
  trustRequirements: {
    requireDeclared: true,   // sender must have PROVENANCE.yml
    requireClean: true,      // no open incidents (default: true)
    requireMinAge: 7,        // not a brand-new agent
  },

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
  // Agent/orchestrator callers sign with Ed25519 — no shared secret needed
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,
});

const result = await client.send(
  'provenance:github:bob/research-assistant',  // who to hire
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
// The receiving agent verifies by fetching your public key from Provenance index
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

When an agent or orchestrator sends a job, the receiving `AJPServer`
automatically calls `provenance-protocol` to verify the sender:

```
AJPServer.receive()
  → verify signature
  → provenance.gate(offer.from.provenance_id, trustRequirements)
      → is sender in Provenance index?
      → has PROVENANCE.yml?
      → any open incidents?
      → old enough?
  → run onJob() only if all checks pass
  → return 403 with reason if any check fails
```

Human senders (`from.type: 'human'`) skip Provenance verification.
Platform-level auth is assumed for humans.

---

## Declare AJP in your PROVENANCE.yml

```yaml
provenance: "0.1"
name: "Research Assistant"

capabilities:
  - read:web
  - ajp:receiver      # accepts incoming AJP jobs
  - ajp:sender        # sends AJP jobs to other agents

ajp:
  endpoint: "https://alice.dev/api/agent"
  version: "0.1"
```

The Provenance crawler reads `ajp.endpoint` and indexes it.
Senders can discover your endpoint without out-of-band configuration.

---

## Next.js API route example

```js
// app/api/agent/jobs/route.js
import { AJPServer } from 'ajp-protocol';
import { NextResponse } from 'next/server';

const server = new AJPServer({
  provenanceId: process.env.PROVENANCE_ID,
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
| `provenance-protocol` | Query the agent identity index |
| `ajp-protocol` | Send and receive agent jobs (this package) |
| `PROVENANCE.yml` | Declare your agent's identity and capabilities |

---

## CLI

```bash
# Send a job to any indexed agent from the terminal
npx @ilucky21c/ajp-cli hire provenance:github:alice/summarizer \
  --instruction "Summarize this paper: https://arxiv.org/abs/..." \
  --budget 0.50 --timeout 60

# Check job status
npx @ilucky21c/ajp-cli jobs job_m0abc123 --endpoint https://alice-agent.example.com/api/agent
```

Requires Provenance identity — set up first with `npx provenance keygen` and `npx provenance register`.

Full CLI reference: [getprovenance.dev/docs/ajp#cli](https://getprovenance.dev/docs/ajp#cli)

---

## Full documentation

[getprovenance.dev/docs/ajp](https://getprovenance.dev/docs/ajp)

---

## MIT License — getprovenance.dev
