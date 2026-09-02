/**
 * Past-SOW retrieval. Keyword and attribute matching against the manifest -
 * deliberately simple. Do not reach for embeddings until this visibly fails.
 */
import { loadData } from './data.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'is', 'was', 'to', 'of', 'and', 'or', 'for',
  'with', 'like', 'similar', 'project', 'projects', 'job', 'site', 'one', 'it',
  'we', 'our', 'at', 'in', 'on', 'as', 'be', 'are',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function scoreProject(entry, { tokens, siteType, skus, cameraCount, doorCount, subcontracted }) {
  const reasons = [];
  let score = 0;

  const haystack = [
    entry.client,
    entry.project_name,
    entry.site_type,
    entry.summary,
    ...(entry.keywords || []),
    ...(entry.equipment || []),
  ]
    .join(' ')
    .toLowerCase();

  const clientTokens = tokenize(entry.client);
  for (const token of tokens) {
    if (clientTokens.includes(token)) {
      score += 12;
      reasons.push(`client name matches "${token}"`);
    } else if (haystack.includes(token)) {
      score += 3;
      reasons.push(`mentions "${token}"`);
    }
  }

  if (siteType) {
    const siteTokens = tokenize(siteType);
    const entrySite = tokenize(entry.site_type);
    const overlap = siteTokens.filter((t) => entrySite.includes(t));
    if (overlap.length) {
      score += 6 * overlap.length;
      reasons.push(`same site type (${entry.site_type})`);
    }
  }

  if (skus?.length) {
    const shared = skus.filter((s) => (entry.equipment || []).includes(s));
    if (shared.length) {
      score += 4 * shared.length;
      reasons.push(`shares equipment: ${shared.join(', ')}`);
    }
  }

  if (Number.isFinite(cameraCount) && cameraCount > 0 && entry.camera_count) {
    const ratio = Math.min(cameraCount, entry.camera_count) / Math.max(cameraCount, entry.camera_count);
    if (ratio > 0.6) {
      score += 5;
      reasons.push(`similar camera count (${entry.camera_count} vs ${cameraCount})`);
    }
  }
  if (Number.isFinite(doorCount) && doorCount > 0 && entry.door_count) {
    const ratio = Math.min(doorCount, entry.door_count) / Math.max(doorCount, entry.door_count);
    if (ratio > 0.6) {
      score += 4;
      reasons.push(`similar door count (${entry.door_count} vs ${doorCount})`);
    }
  }

  if (typeof subcontracted === 'boolean' && entry.subcontracted === subcontracted) {
    score += 2;
    reasons.push(subcontracted ? 'also subcontracted' : 'also self-performed');
  }

  return { score, reasons: [...new Set(reasons)] };
}

/**
 * @param {string} query    free text - "similar to the Canada Goose project"
 * @param {object} filters  optional attribute hints from the qualification gate
 */
export function searchAnchors(query, filters = {}) {
  const { manifest } = loadData();
  const tokens = tokenize(query);

  return manifest.projects
    .map((entry) => {
      const { score, reasons } = scoreProject(entry, { tokens, ...filters });
      return {
        id: entry.id,
        client: entry.client,
        project_name: entry.project_name,
        site_type: entry.site_type,
        year: entry.year,
        camera_count: entry.camera_count,
        door_count: entry.door_count,
        door_count_label: `${entry.door_count} doors`,
        equipment: entry.equipment,
        complexity: entry.complexity,
        subcontracted: entry.subcontracted,
        site_walked: entry.site_walked,
        summary: entry.summary,
        lessons: entry.lessons,
        file: entry.file,
        score,
        reasons,
      };
    })
    .filter((entry) => entry.score > 0 || !query)
    .sort((a, b) => b.score - a.score);
}

export function getAnchor(id) {
  const { manifest } = loadData();
  return manifest.projects.find((p) => p.id === id) || null;
}
