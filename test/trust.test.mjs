import { generateProvenanceKeyPair, signForProvenance } from 'provenance-protocol/keygen';
import { declarationKeyResolver, SenderIdentityError } from '../src/trust.js';

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  ok ? pass++ : fail++;
};

// Alice publishes a signed declaration in her own repo.
const ALICE = 'provenance:github:alice/research-agent';
const alice = generateProvenanceKeyPair();
const aliceDecl = {
  provenance: '0.1', name: 'Research Agent', description: 'Searches and summarises.',
  provenance_id: ALICE,
  identity: {
    public_key: alice.publicKey,
    signature: signForProvenance(alice.privateKey, ALICE, alice.publicKey),
    algorithm: 'ed25519',
  },
};
const ALICE_URL = 'https://raw.githubusercontent.com/alice/research-agent/main/PROVENANCE.json';

// A fake network: url -> body
const net = new Map([[ALICE_URL, JSON.stringify(aliceDecl)]]);
const fetchText = async (url) => {
  if (!net.has(url)) throw new Error('404');
  return net.get(url);
};

const resolve = declarationKeyResolver({ fetchText });

// 1. Honest sender resolves offline, no index anywhere.
const ok1 = await resolve(ALICE, { declaration_url: ALICE_URL });
t('honest sender resolves offline', ok1.publicKey === alice.publicKey && !!ok1.fingerprint);

// 2. No declaration_url -> refused with a specific code.
try { await resolve(ALICE, {}); t('missing declaration_url refused', false); }
catch (e) { t('missing declaration_url refused', e.code === 'NO_DECLARATION_URL', e.code); }

// 3. Impostor re-hosts Alice's genuine declaration on their own server.
const EVIL_URL = 'https://evil.example/copied/PROVENANCE.json';
net.set(EVIL_URL, JSON.stringify(aliceDecl));
try { await resolve(ALICE, { declaration_url: EVIL_URL }); t('re-hosted declaration refused', false); }
catch (e) { t('re-hosted declaration refused', e.code === 'DECLARATION_LOCATION_MISMATCH', e.code); }

// 4. Impostor forges their own key under Alice's id.
const evil = generateProvenanceKeyPair();
const forged = { ...aliceDecl, identity: {
  public_key: evil.publicKey,
  signature: signForProvenance(evil.privateKey, ALICE, evil.publicKey),
  algorithm: 'ed25519' } };
const FORGED_URL = 'https://raw.githubusercontent.com/evil/fork/main/PROVENANCE.json';
net.set(FORGED_URL, JSON.stringify(forged));
try { await resolve(ALICE, { declaration_url: FORGED_URL }); t('forged key at wrong location refused', false); }
catch (e) { t('forged key at wrong location refused', e.code === 'DECLARATION_LOCATION_MISMATCH', e.code); }

// 5. Tampered declaration (constraints added after signing) fails verification.
const tampered = { ...aliceDecl, provenance_id: 'provenance:github:alice/research-agent' , identity: { ...aliceDecl.identity, public_key: evil.publicKey } };
net.set('https://raw.githubusercontent.com/alice/research-agent/main/TAMPERED.json', JSON.stringify(tampered));
try {
  await resolve(ALICE, { declaration_url: 'https://raw.githubusercontent.com/alice/research-agent/main/TAMPERED.json' });
  t('tampered declaration refused', false);
} catch (e) { t('tampered declaration refused', e.code === 'DECLARATION_INVALID', e.code); }

// 6. Key rotation is flagged, not silently accepted.
const known = new Map();
const pinning = declarationKeyResolver({ fetchText, knownKeys: known });
await pinning(ALICE, { declaration_url: ALICE_URL });
const rotated = generateProvenanceKeyPair();
net.set(ALICE_URL, JSON.stringify({ ...aliceDecl, identity: {
  public_key: rotated.publicKey,
  signature: signForProvenance(rotated.privateKey, ALICE, rotated.publicKey),
  algorithm: 'ed25519' } }));
try { await pinning(ALICE, { declaration_url: ALICE_URL }); t('key rotation refused by default', false); }
catch (e) { t('key rotation refused by default', e.code === 'KEY_ROTATED', e.code); }

// 7. Rotation accepted when explicitly allowed.
const allowing = declarationKeyResolver({ fetchText, knownKeys: new Map([[ALICE, 'old']]), allowKeyRotation: true });
const ok7 = await allowing(ALICE, { declaration_url: ALICE_URL });
t('rotation accepted when allowed', ok7.publicKey === rotated.publicKey);

// 8. Unreachable declaration is its own error, distinct from invalid.
try { await resolve(ALICE, { declaration_url: 'https://nowhere.example/x.json' }); t('unreachable is distinct from invalid', false); }
catch (e) { t('unreachable is distinct from invalid', e.code === 'DECLARATION_UNREACHABLE', e.code); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
