/**
 * File-based project storage. No database in v1 - one JSON file per project.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_DIR, OUTPUT_DIR, UPLOADS_DIR } from './config.js';

for (const dir of [PROJECTS_DIR, OUTPUT_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const projectFile = (id) => path.join(PROJECTS_DIR, `${id}.json`);

export function newProject() {
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    stage: 'qualification',
    path: null,
    answers: {},
    anchor: null,
    floorplan: null,
    lines: [],
    verification: {},
    prose: {},
    overrides: [],
    documents: [],
  };
  save(project);
  return project;
}

export function save(project) {
  project.updated_at = new Date().toISOString();
  fs.writeFileSync(projectFile(project.id), JSON.stringify(project, null, 2));
  return project;
}

export function load(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid project id');
  const file = projectFile(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function list() {
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8')))
    .map((p) => ({
      id: p.id,
      client: p.answers.client_name?.value || '(unnamed)',
      project_name: p.answers.project_name?.value || '',
      stage: p.stage,
      path: p.path,
      updated_at: p.updated_at,
      line_count: p.lines.length,
      document_count: p.documents.length,
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
