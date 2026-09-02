/**
 * Anthropic API client. The model writes prose and reads floor plans; it never
 * decides what is true. Every fact it is given is already tagged, and anything
 * it proposes comes back as a proposal the AE has to accept.
 */
import Anthropic from '@anthropic-ai/sdk';
import { MODEL, hasApiKey } from './config.js';

let client = null;

/** Test seam: drops the cached client so credentials/base URL can be re-read. */
export function resetClient() {
  client = null;
}

export function getClient() {
  if (!hasApiKey()) {
    const err = new Error(
      'No Anthropic credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`). Stages 0-3 and Word generation work without it.',
    );
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (!client) client = new Anthropic();
  return client;
}

/** Maps SDK errors to something an AE can act on, most specific first. */
export function describeError(err) {
  if (err?.code === 'NO_API_KEY') return { status: 503, message: err.message };
  if (err instanceof Anthropic.NotFoundError) {
    return { status: 502, message: `Model or endpoint not found (${MODEL}). Check SOW_MODEL.` };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, message: 'Anthropic rate limit hit. Wait a moment and try again.' };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 504, message: 'Could not reach the Anthropic API. Check network access.' };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, message: `Anthropic API error: ${err.message}` };
  }
  return { status: 500, message: err?.message || 'Unknown error' };
}

export { MODEL };
