/**
 * ajp-protocol
 *
 * The Agent Job Protocol — standard interaction layer for the agent internet.
 * Part of the Provenance Protocol family.
 *
 * npm install ajp-protocol
 *
 * Usage (receiving agent):
 *   import { AJPServer } from 'ajp-protocol';
 *   const server = new AJPServer({ provenanceId, secret, onJob });
 *   app.post('/jobs',         server.receive());
 *   app.get('/jobs/:id',      server.status());
 *   app.post('/jobs/:id/ack', server.ack());
 *
 * Usage (sending agent or platform):
 *   import { AJPClient } from 'ajp-protocol';
 *   const client = new AJPClient({ from, secret });
 *   const result = await client.send(toProvenanceId, task, budget);
 */

export { AJPClient } from './client.js';
export { AJPServer } from './server.js';
export { sign, verify, generateJobId, validateOffer, JOB_STATUS, FROM_TYPE } from './utils.js';
