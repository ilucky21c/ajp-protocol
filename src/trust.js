/**
 * AJP — sender trust resolution
 *
 * Establishing who sent a job splits into two questions, and only one of them
 * needs a network service:
 *
 *   1. IDENTITY — is this signature really from the party named in `from`?
 *      Answerable offline. The sender's declaration carries its public key and
 *      is itself signed; verifying it against the location it claims binds the
 *      key to the identity with no third party involved.
 *
 *   2. STANDING — is that party currently in good order? Revoked, open
 *      incidents, stale evidence. NOT answerable offline: absence of news
 *      cannot be carried in a document. This requires asking someone, and who
 *      to ask is the receiver's choice.
 *
 * Earlier versions collapsed both into one call to a single index, which made
 * even the cryptography depend on one company's uptime. These resolvers keep
 * them apart: identity never calls out to an index, and standing is opt-in.
 */

import { verifyDeclaration, keyFingerprint, locateDeclaration } from 'provenance-protocol/verify';

/** Thrown when a sender's identity cannot be established. */
export class SenderIdentityError extends Error {
  constructor(message, code = 'SENDER_IDENTITY_FAILED') {
    super(message);
    this.name = 'SenderIdentityError';
    this.code = code;
  }
}

const MAX_DECLARATION_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8000;

/**
 * Resolve a sender's public key from its own declaration, with no index.
 *
 * The sender points at where its declaration lives (`from.declaration_url`),
 * or — for domain and GitHub ids — the id itself names the standard location.
 * Hosting a copy elsewhere does not help an impostor: the declaration names
 * its own provenance id, and a declaration served from a location that does
 * not match that id is rejected. Forging one is not possible without the
 * genuine private key.
 *
 * @param {object} [options]
 * @param {(url: string) => Promise<string>} [options.fetchText]  Override for tests.
 * @param {Map<string,string>} [options.knownKeys]  provenanceId -> key fingerprint
 *   seen before. A different key later is a rotation, and by default a
 *   rotation is refused rather than silently accepted.
 * @param {boolean} [options.allowKeyRotation]  Accept a changed key (default false).
 * @param {(declaration: string) => unknown} [options.parseDeclaration]  YAML parser.
 *   Declarations are YAML; AJP has no YAML dependency, so supply one to accept
 *   YAML declarations. Without it, only JSON declarations are read.
 * @returns {(provenanceId: string, from: object) => Promise<{publicKey: string, fingerprint: string, source: string, declaration: object}>}
 */
export function declarationKeyResolver(options = {}) {
  const {
    fetchText = defaultFetchText,
    knownKeys,
    allowKeyRotation = false,
    parseDeclaration,
  } = options;

  return async function resolve(provenanceId, from = {}) {
    // The sender may say where its declaration is; otherwise its provenance id
    // names the standard location.
    const url = from.declaration_url || locateDeclaration(provenanceId);
    if (!url) {
      throw new SenderIdentityError(
        'Sender gave no from.declaration_url and its provenance id has no standard location, so its key cannot be established offline',
        'NO_DECLARATION_URL'
      );
    }

    const result = await fetchVerifiedDeclaration(url, provenanceId, { fetchText, parseDeclaration }, SenderIdentityError, 'Sender');

    if (knownKeys) {
      const seen = knownKeys.get(provenanceId);
      if (seen && seen !== result.fingerprint && !allowKeyRotation) {
        throw new SenderIdentityError(
          'Sender is signing with a different key than previously seen — treat as key rotation, not as a routine update',
          'KEY_ROTATED'
        );
      }
      if (!seen) knownKeys.set(provenanceId, result.fingerprint);
    }

    return { publicKey: result.publicKey, fingerprint: result.fingerprint, source: url, declaration: result.declaration };
  };
}

/**
 * Resolve a sender's key from a Provenance index instead of its declaration.
 *
 * Kept for receivers that already trust an index and prefer one lookup to a
 * fetch — but note this makes identity verification depend on that service
 * being reachable, which `declarationKeyResolver` does not.
 *
 * @param {object} provenanceClient  new Provenance({ apiUrl }) from provenance-protocol/index-client
 */
export function indexKeyResolver(provenanceClient) {
  return async function resolve(provenanceId) {
    const profile = await provenanceClient.check(provenanceId).catch(() => null);
    if (!profile?.found) {
      throw new SenderIdentityError('Sender not found in the index', 'SENDER_NOT_INDEXED');
    }
    if (!profile.public_key) {
      throw new SenderIdentityError('Sender has no public key in the index', 'NO_PUBLIC_KEY');
    }
    const fingerprint = await keyFingerprint(profile.public_key).catch(() => null);
    return { publicKey: profile.public_key, fingerprint, source: 'index' };
  };
}

/**
 * Try resolvers in order and use the first that succeeds.
 *
 * The useful arrangement is offline first, index second: identity is
 * established without a network service whenever the sender supports it, and
 * the index is a fallback rather than a requirement.
 */
export function firstResolver(...resolvers) {
  const usable = resolvers.filter(Boolean);
  return async function resolve(provenanceId, from) {
    let last;
    for (const resolver of usable) {
      try {
        return await resolver(provenanceId, from);
      } catch (e) {
        last = e;
      }
    }
    throw last ?? new SenderIdentityError('No key resolver was configured', 'NO_RESOLVER');
  };
}

/**
 * Check a sender's current standing against a Provenance index.
 *
 * Opt-in on purpose. A receiver may use this, another attester, several, or
 * none — standing is a policy question, not a protocol requirement.
 *
 * @param {object} provenanceClient   new Provenance({ apiUrl }) from provenance-protocol/index-client
 * @param {object} [requirements]     Passed through to gate()
 */
export function indexStandingCheck(provenanceClient, requirements = {}) {
  return async function check(provenanceId) {
    const result = await provenanceClient.gate(provenanceId, requirements);
    return { allowed: result.allowed, reason: result.reason ?? null, fallback: result.fallback ?? false };
  };
}

/**
 * Fetch a declaration, verify its signature, and confirm it was served from the
 * location its own provenance id names and is for the agent expected.
 * Throws `ErrorType` with a specific code for each way it can fail.
 */
async function fetchVerifiedDeclaration(url, provenanceId, { fetchText, parseDeclaration }, ErrorType, who) {
  let text;
  try {
    text = await fetchText(url);
  } catch (e) {
    throw new ErrorType(`Could not fetch ${who.toLowerCase()} declaration: ${e.message}`, 'DECLARATION_UNREACHABLE');
  }

  let declaration;
  try {
    declaration = parseDeclaration ? parseDeclaration(text) : JSON.parse(text);
  } catch {
    throw new ErrorType(
      parseDeclaration
        ? `${who} declaration could not be parsed`
        : `${who} declaration is not JSON; pass parseDeclaration to accept YAML`,
      'DECLARATION_UNPARSEABLE'
    );
  }

  // Verifies the signature against the key inside the file AND that the file
  // was served from the location its own provenance id names.
  const result = await verifyDeclaration(declaration, { retrievedFrom: url });

  if (!result.valid) {
    throw new ErrorType(`${who} declaration did not verify: ${result.reason ?? 'unknown reason'}`, 'DECLARATION_INVALID');
  }
  if (result.location !== 'match') {
    throw new ErrorType(`${who} declaration was not served from the location its provenance id names`, 'DECLARATION_LOCATION_MISMATCH');
  }
  if (result.provenanceId !== provenanceId) {
    throw new ErrorType(`${who} declaration is for ${result.provenanceId}, not ${provenanceId}`, 'DECLARATION_ID_MISMATCH');
  }
  return { ...result, declaration };
}

/** Thrown when the agent a job is addressed to cannot be located. */
export class RecipientResolutionError extends Error {
  constructor(message, code = 'RECIPIENT_UNRESOLVED') {
    super(message);
    this.name = 'RecipientResolutionError';
    this.code = code;
  }
}

/**
 * Find where to send a job from the recipient's own declaration, with no index.
 *
 * The declaration is found from the provenance id alone (a domain id at
 * /.well-known/provenance.json, a GitHub id at PROVENANCE.yml), verified, and
 * its `ajp.endpoint` used. Because the declaration is signed and tied to its
 * location, an endpoint read this way is the operator's, not a third party's
 * record of it.
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.declarationUrls]  provenanceId -> URL, for
 *        platforms without a standard location (npm, pypi, …)
 * @param {(url: string) => Promise<string>} [options.fetchText]
 * @param {(text: string) => unknown} [options.parseDeclaration]  YAML parser, needed
 *        for GitHub-hosted declarations
 * @returns {(provenanceId: string) => Promise<string>}  the endpoint base URL
 */
export function declarationEndpointResolver(options = {}) {
  const { declarationUrls = {}, fetchText = defaultFetchText, parseDeclaration } = options;

  return async function resolveEndpoint(provenanceId) {
    const url = declarationUrls[provenanceId] ?? locateDeclaration(provenanceId);
    if (!url) {
      throw new RecipientResolutionError(
        `${provenanceId} has no standard declaration location; supply it in declarationUrls`,
        'NO_DECLARATION_LOCATION'
      );
    }
    const { declaration } = await fetchVerifiedDeclaration(
      url, provenanceId, { fetchText, parseDeclaration }, RecipientResolutionError, 'Recipient'
    );

    const endpoint = declaration.ajp?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) {
      throw new RecipientResolutionError(`${provenanceId} does not declare ajp.endpoint`, 'NO_AJP_ENDPOINT');
    }
    let parsed;
    try { parsed = new URL(endpoint); } catch {
      throw new RecipientResolutionError(`${provenanceId} declares an ajp.endpoint that is not a URL`, 'BAD_AJP_ENDPOINT');
    }
    if (parsed.protocol !== 'https:') {
      throw new RecipientResolutionError(`${provenanceId} declares a non-HTTPS ajp.endpoint`, 'BAD_AJP_ENDPOINT');
    }
    return endpoint.replace(/\/$/, '');
  };
}

/**
 * Find where to send a job by asking an index you choose.
 *
 * Makes sending depend on that index being up and correct. Prefer
 * `declarationEndpointResolver`; use this as a fallback with `firstResolver`.
 *
 * @param {object} indexClient  new Provenance({ apiUrl }) from provenance-protocol/index-client
 */
export function indexEndpointResolver(indexClient) {
  return async function resolveEndpoint(provenanceId) {
    let profile;
    try {
      profile = await indexClient.check(provenanceId);
    } catch (e) {
      throw new RecipientResolutionError(`Index lookup failed: ${e.message}`, 'INDEX_UNAVAILABLE');
    }
    if (!profile?.found) throw new RecipientResolutionError(`${provenanceId} is not in the index`, 'NOT_INDEXED');
    const endpoint = profile.provenance_yml?.ajp?.endpoint ?? profile.ajp_endpoint;
    if (!endpoint) throw new RecipientResolutionError(`The index has no ajp.endpoint for ${provenanceId}`, 'NO_AJP_ENDPOINT');
    return endpoint.replace(/\/$/, '');
  };
}

async function defaultFetchText(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DECLARATION_BYTES) throw new Error('declaration too large');
  return text;
}
