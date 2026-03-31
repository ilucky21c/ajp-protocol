#!/usr/bin/env node
/**
 * ajp-cli — Agent Job Protocol CLI
 *
 * Requires Provenance identity (PROVENANCE_ID + PROVENANCE_PRIVATE_KEY).
 * For identity setup: npx provenance keygen / npx provenance register
 *
 * Usage:
 *   ajp hire <provenance_id> --instruction <text> [--budget <usd>] [--timeout <s>]
 *   ajp jobs <job_id> --endpoint <url>
 */

import { createPrivateKey, sign as nodeSign, randomBytes } from 'crypto';

const API     = process.env.PROVENANCE_API_URL || 'https://provenance-web-mu.vercel.app';
const VERSION = '0.1.0';

// ── Colours ───────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m', white: '\x1b[97m',
};
const ok  = s => `${c.green}✓${c.reset} ${s}`;
const err = s => `${c.red}✗${c.reset} ${s}`;
const dim = s => `${c.dim}${s}${c.reset}`;
const hi  = s => `${c.white}${c.bold}${s}${c.reset}`;
const amb = s => `${c.amber}${s}${c.reset}`;

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i += 2; }
      else { args[key] = true; i++; }
    } else { args._.push(a); i++; }
  }
  return args;
}

// ── Signing ───────────────────────────────────────────────────────────────────

function generateJobId() {
  return `job_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

function signOffer(offer, privateKeyBase64) {
  const { signature: _, ...rest } = offer;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
  return `ed25519:${nodeSign(null, Buffer.from(canonical, 'utf8'), key).toString('base64')}`;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdHire(args) {
  const targetId     = args._[1];
  const instruction  = args.instruction || args.i;
  const budget       = parseFloat(args.budget  || args.b || '1.0');
  const timeout      = parseInt(args.timeout   || args.t || '120');
  const privateKey   = args['private-key'] || process.env.PROVENANCE_PRIVATE_KEY;
  const provenanceId = args['from-id']     || process.env.PROVENANCE_ID;

  if (!targetId)     { console.error(err('Usage: ajp hire <provenance_id> --instruction <text>')); process.exit(1); }
  if (!instruction)  { console.error(err('--instruction required')); process.exit(1); }
  if (!privateKey)   { console.error(err('PROVENANCE_PRIVATE_KEY not set. Run: npx provenance keygen')); process.exit(1); }
  if (!provenanceId) { console.error(err('PROVENANCE_ID not set. Run: npx provenance register')); process.exit(1); }

  console.log(`\n${amb('Hiring')} ${hi(targetId)}...\n`);

  // Resolve endpoint
  process.stdout.write(dim('  Resolving endpoint...'));
  const agentRes  = await fetch(`${API}/api/agent/${targetId.replace('provenance:', '').replace(':', '/')}`);
  const agentData = await agentRes.json();
  if (!agentData?.ajp?.endpoint) {
    console.log('\n' + err('Agent has no AJP endpoint. Ask them to add ajp.endpoint to PROVENANCE.yml.'));
    process.exit(1);
  }
  const endpoint = agentData.ajp.endpoint.replace(/\/$/, '');
  console.log(` ${c.green}${endpoint}${c.reset}`);

  // Build and sign offer
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + timeout * 1000);
  const jobId     = generateJobId();

  const offer = {
    ajp: '0.1', job_id: jobId, parent_job_id: null,
    from: { type: 'orchestrator', id: null, provenance_id: provenanceId },
    to:   { provenance_id: targetId },
    task: { type: 'task', instruction, input: {}, output_format: 'json' },
    context: { credentials: {}, memory: [], constraints: [] },
    budget:  { max_usd: budget, max_seconds: timeout, max_llm_tokens: 10000 },
    callback: null,
    issued_at:  now.toISOString(),
    expires_at: expiresAt.toISOString(),
    signature: '',
  };
  offer.signature = signOffer(offer, privateKey);

  // Submit
  process.stdout.write(dim('  Submitting job...'));
  const submitRes  = await fetch(`${endpoint}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(offer),
  });
  const submitData = await submitRes.json().catch(() => ({}));

  if (!submitRes.ok) {
    console.log('\n' + err(submitData.error || submitData.reason || `HTTP ${submitRes.status}`));
    process.exit(1);
  }
  console.log(` ${c.green}${jobId}${c.reset}`);

  // Poll
  const deadline = Date.now() + timeout * 1000;
  const frames   = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let   fi       = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes  = await fetch(`${endpoint}/jobs/${jobId}`);
    const pollData = await pollRes.json().catch(() => ({}));

    process.stdout.write(`\r  ${c.blue}${frames[fi++ % frames.length]}${c.reset} ${dim(pollData.status || 'polling...')}   `);

    if (pollData.status === 'completed') {
      await fetch(`${endpoint}/jobs/${jobId}/ack`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ received: true }),
      }).catch(() => {});

      const dur = pollData.usage?.duration_seconds?.toFixed(1);
      process.stdout.write(`\r${ok(`Completed${dur ? ` in ${dur}s` : ''}`)}                    \n\n`);

      const out = pollData.output;
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));

      if (pollData.usage) {
        const u = pollData.usage;
        const parts = [];
        if (u.duration_seconds != null) parts.push(`${u.duration_seconds.toFixed(1)}s`);
        if (u.cost_usd > 0)             parts.push(`$${u.cost_usd.toFixed(4)}`);
        if (u.llm_tokens > 0)           parts.push(`${u.llm_tokens} tokens`);
        if (parts.length) console.log('\n' + dim(parts.join(' · ')));
      }
      console.log();
      return;
    }

    if (['failed','expired','rejected'].includes(pollData.status)) {
      process.stdout.write(`\r${err(pollData.status + (pollData.message ? ': ' + pollData.message : ''))}                    \n\n`);
      process.exit(1);
    }
  }

  console.log('\n' + err(`Timed out after ${timeout}s`));
  process.exit(1);
}

async function cmdJobs(args) {
  const jobId    = args._[1];
  const endpoint = args.endpoint;
  if (!jobId)    { console.error(err('Usage: ajp jobs <job_id> --endpoint <url>')); process.exit(1); }
  if (!endpoint) { console.error(err('--endpoint required')); process.exit(1); }

  const res  = await fetch(`${endpoint.replace(/\/$/, '')}/jobs/${jobId}`);
  const data = await res.json();

  const statusColor = { completed: c.green, failed: c.red, expired: c.red, running: c.blue, accepted: c.amber }[data.status] || c.dim;
  console.log(`\n${dim('job_id:')} ${data.job_id}`);
  console.log(`${dim('status:')} ${statusColor}${data.status}${c.reset}`);
  if (data.output)  console.log(`\n${JSON.stringify(data.output, null, 2)}`);
  if (data.message) console.log(`${c.red}${data.message}${c.reset}`);
  console.log();
}

function cmdHelp() {
  console.log(`
${hi('ajp')} ${dim(`v${VERSION}`)} — Agent Job Protocol CLI

${amb('Commands:')}
  ${hi('hire')}  <provenance_id>            Send a job to an agent via AJP
         --instruction <text>       What you want the agent to do
         [--budget <usd>]           Max cost ceiling (default: 1.00)
         [--timeout <seconds>]      Max wait time (default: 120)
         [--from-id <id>]           Your Provenance ID (default: $PROVENANCE_ID)
         [--private-key <key>]      Your private key (default: $PROVENANCE_PRIVATE_KEY)

  ${hi('jobs')}  <job_id>                   Check status of a job
         --endpoint <url>           The agent's AJP endpoint URL

${amb('Environment variables:')}
  PROVENANCE_ID           Your Provenance ID  (set up with: npx provenance register)
  PROVENANCE_PRIVATE_KEY  Your Ed25519 private key  (set up with: npx provenance keygen)
  PROVENANCE_API_URL      Override Provenance API base URL

${amb('Examples:')}
  ajp hire provenance:github:alice/summarizer \\
    --instruction "Summarize https://arxiv.org/abs/2501.00001" \\
    --budget 0.50 --timeout 60

  ajp jobs job_m0abc123 --endpoint https://alice-agent.example.com/api/agent

${amb('Identity setup (first time):')}
  npx provenance keygen
  npx provenance register --id provenance:github:your-org/your-agent --url <url>
  ${dim('Then set PROVENANCE_ID and PROVENANCE_PRIVATE_KEY in your environment.')}
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const cmd  = args._[0];

try {
  if (!cmd || cmd === 'help' || args.help) cmdHelp();
  else if (cmd === 'hire') await cmdHire(args);
  else if (cmd === 'jobs') await cmdJobs(args);
  else { console.error(err(`Unknown command: ${cmd}\nRun \`ajp help\` for usage.`)); process.exit(1); }
} catch (e) {
  console.error(err(e.message));
  process.exit(1);
}
