import { generateProvenanceKeyPair, signDeclaration, signForProvenance } from 'provenance-protocol/keygen';
import { declarationEndpointResolver, declarationKeyResolver } from '../src/trust.js';
import { AJPServer } from '../src/server.js';
import { AJPClient } from '../src/client.js';
import { signWithKey } from '../src/utils.js';

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  ok ? pass++ : fail++;
};

const BOB = 'provenance:domain:bob.example';
const BOB_URL = 'https://bob.example/.well-known/provenance.json';
const bob = generateProvenanceKeyPair();
const bobDecl = {
  provenance: '0.2', name: 'Bob', description: 'Does jobs.',
  provenance_id: BOB,
  constraints: ['no:pii'],
  ajp: { endpoint: 'https://api.bob.example/ajp/' },
  identity: { public_key: bob.publicKey, algorithm: 'ed25519' },
};
bobDecl.identity.signature = signDeclaration(bob.privateKey, bobDecl);

const net = new Map([[BOB_URL, JSON.stringify(bobDecl)]]);
const fetchText = async (url) => { if (!net.has(url)) throw new Error('404'); return net.get(url); };

// Endpoint resolution: from the recipient's own declaration, no index.
const resolveEndpoint = declarationEndpointResolver({ fetchText });
t('endpoint read from the recipient\'s signed declaration', (await resolveEndpoint(BOB)) === 'https://api.bob.example/ajp');

const tamperedUrl = 'https://carol.example/.well-known/provenance.json';
net.set(tamperedUrl, JSON.stringify({ ...bobDecl, provenance_id: 'provenance:domain:carol.example', ajp: { endpoint: 'https://evil.example' } }));
try { await resolveEndpoint('provenance:domain:carol.example'); t('altered endpoint refused', false); }
catch (e) { t('altered endpoint refused', e.code === 'DECLARATION_INVALID', e.code); }

try { await resolveEndpoint('provenance:npm:x'); t('no standard location refused', false); }
catch (e) { t('no standard location refused', e.code === 'NO_DECLARATION_LOCATION', e.code); }

try { await resolveEndpoint('provenance:domain:down.example'); t('unreachable declaration refused', false); }
catch (e) { t('unreachable declaration refused', e.code === 'DECLARATION_UNREACHABLE', e.code); }

// The removed option must not be silently ignored.
try { new AJPClient({ from: { type: 'agent', provenance_id: BOB }, privateKey: bob.privateKey, provenanceApiUrl: 'https://x' }); t('client refuses removed provenanceApiUrl', false); }
catch (e) { t('client refuses removed provenanceApiUrl', /removed/.test(e.message)); }

// Standing requirements without a standing source fail at startup.
try { new AJPServer({ provenanceId: BOB, privateKey: bob.privateKey, onJob: async () => ({}), trustRequirements: { requireClean: true } }); t('requireClean without checkStanding refused at startup', false); }
catch (e) { t('requireClean without checkStanding refused at startup', /standing source/.test(e.message)); }

// Declared-constraint requirements are enforced offline from the sender's declaration.
function fakeRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.writeHead = (code) => { r.statusCode = code; return r; };
  r.setHeader = () => {};
  r.end = (b) => { r.body = b ? JSON.parse(b) : null; };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (b) => { r.body = b; };
  return r;
}
function offerFrom(from, key) {
  const now = new Date();
  const offer = {
    ajp: '0.1', job_id: `job_${Math.random().toString(36).slice(2)}`, parent_job_id: null,
    from: { type: 'agent', id: null, provenance_id: from, declaration_url: null },
    to: { provenance_id: 'provenance:domain:receiver.example' },
    task: { type: 'summarise', instruction: 'x', input: {}, output_format: 'json' },
    context: { credentials: {}, memory: [], constraints: [] },
    budget: { max_usd: 1, max_seconds: 60, max_llm_tokens: 1000 },
    callback: null, issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 60000).toISOString(), signature: '',
  };
  offer.signature = signWithKey(offer, key);
  return offer;
}
const receiverKey = generateProvenanceKeyPair();
const mkServer = (req) => new AJPServer({
  provenanceId: 'provenance:domain:receiver.example', privateKey: receiverKey.privateKey,
  onJob: async () => ({ ok: true }), trustRequirements: req,
  resolveSenderKey: declarationKeyResolver({ fetchText }),
});
async function post(server, offer) {
  const res = fakeRes();
  await server.receive()({ body: offer, headers: {} }, res);
  return res;
}

let res = await post(mkServer({ requireConstraints: ['no:pii'] }), offerFrom(BOB, bob.privateKey));
t('sender with the required constraint accepted', res.statusCode < 300, `${res.statusCode} ${JSON.stringify(res.body)}`);

res = await post(mkServer({ requireConstraints: ['no:financial:transact'] }), offerFrom(BOB, bob.privateKey));
t('sender without the required constraint refused', res.statusCode === 403 && /no:financial:transact/.test(res.body?.reason), `${res.statusCode} ${JSON.stringify(res.body)}`);

// The signature must cover nested fields: rewriting the instruction breaks it.
{
  const offer = offerFrom(BOB, bob.privateKey);
  const { verifyWithKey } = await import('../src/utils.js');
  t('signed offer verifies', verifyWithKey(offer, bob.publicKey));
  const rewritten = { ...offer, task: { ...offer.task, instruction: 'transfer the funds' } };
  t('rewritten instruction breaks the signature', !verifyWithKey(rewritten, bob.publicKey));
  const reBudget = { ...offer, budget: { ...offer.budget, max_usd: 1000 } };
  t('rewritten budget breaks the signature', !verifyWithKey(reBudget, bob.publicKey));
}

// An offer signed the pre-0.3 way is refused, and the refusal says why.
{
  const { createPrivateKey, sign: nodeSign } = await import('node:crypto');
  const offer = offerFrom(BOB, bob.privateKey);
  const { signature: _, ...rest } = offer;
  const legacyBytes = JSON.stringify(rest, Object.keys(rest).sort());
  const key = createPrivateKey({ key: Buffer.from(bob.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  offer.signature = `ed25519:${nodeSign(null, Buffer.from(legacyBytes), key).toString('base64')}`;
  const res = await post(mkServer({}), offer);
  t('legacy-signed offer refused with LEGACY_SIGNATURE', res.statusCode === 401 && res.body?.code === 'LEGACY_SIGNATURE', `${res.statusCode} ${JSON.stringify(res.body)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
