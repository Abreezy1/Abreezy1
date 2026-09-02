import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const STORAGE_DIR = process.env.SOW_STORAGE_DIR || path.join(ROOT, 'storage');
export const PROJECTS_DIR = path.join(STORAGE_DIR, 'projects');
export const OUTPUT_DIR = path.join(STORAGE_DIR, 'output');
export const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');

export const PORT = Number(process.env.PORT || 3000);

/** Anthropic model used for every drafting and analysis pass. */
export const MODEL = process.env.SOW_MODEL || 'claude-opus-5';

export const COMPANY_NAME = process.env.SOW_COMPANY_NAME || 'the Contractor';

/** The API is optional: stages 0-3 and Word generation work without a key. */
export const hasApiKey = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
