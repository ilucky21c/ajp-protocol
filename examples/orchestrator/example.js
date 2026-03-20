// Example 3: Orchestrator delegating to sub-agents
// A research orchestrator breaks a complex task into parallel sub-tasks.
// Each sub-job references parent_job_id — creating a full audit chain.

import { AJPClient } from 'ajp-protocol';

const client = new AJPClient({
  from: {
    type: 'orchestrator',
    provenance_id: 'provenance:github:alice/research-orchestrator',
  },
  secret: process.env.AJP_SECRET,
});

const PARENT_JOB_ID = 'job_parent_01J8X2K9M3N4P5Q6';

// ── Dispatch sub-tasks in parallel ───────────────────────────────────────

const [webResults, pdfResults] = await Promise.all([

  // Sub-task 1: web research agent
  client.send(
    'provenance:github:alice/research-assistant',
    {
      type: 'research',
      instruction: 'Find recent papers on transformer attention mechanisms (2024).',
      output_format: 'json',
    },
    { max_usd: 0.25, max_seconds: 60 },
    { parentJobId: PARENT_JOB_ID }   // links to parent for audit trail
  ),

  // Sub-task 2: PDF extraction agent
  client.send(
    'provenance:pypi:bob-pdf-extractor',
    {
      type: 'extract',
      instruction: 'Extract tables from the provided PDF.',
      input: { url: 'https://example.com/survey.pdf' },
      output_format: 'json',
    },
    { max_usd: 0.25, max_seconds: 60 },
    { parentJobId: PARENT_JOB_ID }
  ),

]);

// ── Audit chain: all three jobs are linked ────────────────────────────────
//
// job_parent_01J8X2K9M3N4P5Q6       ← orchestrator job (from human)
//   ├── job_sub_A_...               ← web research   (parent_job_id set)
//   └── job_sub_B_...               ← PDF extraction (parent_job_id set)
//
// Anyone querying the Provenance log can see the full chain.
// What was delegated, to whom, when, and what it cost.
