// Example 2: Agent hiring an agent
// A data pipeline agent needs PDF extraction.
// It hires a specialist PDF agent to handle that step.
//
// Key difference from human→agent: the receiving agent
// MUST verify the sender's Provenance ID before accepting — offline, against
// the sender's own signed declaration.

import { AJPClient } from 'ajp-protocol';

// ── Sending side (data pipeline agent) ───────────────────────────────────

const client = new AJPClient({
  from: {
    type: 'agent',
    provenance_id: 'provenance:github:alice/data-pipeline',
  },
  // Agents sign with their own key; the recipient checks it against the
  // declaration Alice publishes in her repository.
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,
});

// Send job to a specialist PDF extractor. Its endpoint is read from its own
// signed declaration at https://pdf.bob.example/.well-known/provenance.json.
const result = await client.send(
  'provenance:domain:pdf.bob.example',
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
  provenanceId: 'provenance:domain:pdf.bob.example',
  privateKey: process.env.PROVENANCE_PRIVATE_KEY,   // signs results

  // Checked offline against the sender's verified declaration.
  trustRequirements: {
    requireConstraints: ['no:pii'],
  },
  // Standing (incidents, age) needs someone to ask — add checkStanding with
  // an attester you choose if you want requireClean or requireMinAge.

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
