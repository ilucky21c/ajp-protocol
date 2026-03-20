// Example 2: Agent hiring an agent
// A data pipeline agent needs PDF extraction.
// It hires a specialist PDF agent to handle that step.
//
// Key difference from human→agent: the receiving agent
// MUST verify the sender's Provenance ID before accepting.

import { AJPClient } from 'ajp-protocol';
import { provenance } from 'provenance-protocol';

// ── Sending side (data pipeline agent) ───────────────────────────────────

const client = new AJPClient({
  from: {
    type: 'agent',
    provenance_id: 'provenance:github:alice/data-pipeline',
  },
  secret: process.env.AJP_SECRET,
});

// Send job to a specialist PDF extractor
const result = await client.send(
  'provenance:pypi:bob-pdf-extractor',
  {
    type: 'extract',
    instruction: 'Extract all tables from this PDF and return them as structured JSON.',
    input: { url: 'https://example.com/annual-report.pdf' },
    output_format: 'json',
  },
  {
    max_usd: 0.25,
    max_seconds: 60,
  }
);

console.log(result.output.tables);

// ── Receiving side (PDF extractor agent) ─────────────────────────────────
// This runs inside the PDF extractor's server

import { AJPServer } from 'ajp-protocol';

const server = new AJPServer({
  provenanceId: 'provenance:pypi:bob-pdf-extractor',
  secret: process.env.AJP_SECRET,

  // Trust requirements for incoming agent jobs
  trustRequirements: {
    requireDeclared: true,    // sender must have PROVENANCE.yml
    requireClean: true,       // no open incidents
    requireMinAge: 7,         // not a brand-new agent
  },

  onJob: async (job) => {
    // job.from.provenance_id already verified by AJPServer
    // before this function is called

    const tables = await extractTablesFromPdf(job.task.input.url);
    return { tables };
  },
});

// Wire up to your HTTP framework
// Express:
app.post('/jobs',         server.receive());
app.get('/jobs/:id',      server.status());
app.post('/jobs/:id/ack', server.ack());
