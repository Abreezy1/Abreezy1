import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import { loadData, catalogueTree, getSku, getSkuQuestions } from '../data.js';
import { applyAnswer, SOURCE } from '../answers.js';
import {
  qualificationFlow, anchorFlow, lineFlow, equipmentFlow, standingFlow,
  verificationFlow, progress, readiness, context, flags,
} from '../engine.js';
import { buildBom } from '../bom.js';
import { buildDocument } from '../document.js';
import { writeDocument } from '../word.js';
import { searchAnchors, getAnchor } from '../anchor.js';
import { draftProse } from '../prose.js';
import { readFloorPlan } from '../floorplan.js';
import { describeError } from '../anthropic.js';
import { hasApiKey, OUTPUT_DIR, UPLOADS_DIR, MODEL } from '../config.js';

export const router = express.Router();

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function requireProject(req) {
  const project = store.load(req.params.id);
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  return project;
}

function findLine(project, lineId) {
  const line = project.lines.find((l) => l.id === lineId);
  if (!line) {
    const err = new Error('Line not found');
    err.status = 404;
    throw err;
  }
  return line;
}

/** Applies gate side effects declared in the data file (e.g. the site-walk branch). */
function applyGates(project, question, value) {
  if (question.gate === 'path') {
    project.path = value === 'yes' ? 'walked' : 'not_walked';
  }
}

/* ----------------------------------------------------------------- meta */

router.get('/meta', (req, res) => {
  const { qualification, verification, anchor, clauses, catalogue } = loadData();
  res.json({
    api_available: hasApiKey(),
    model: MODEL,
    stages: ['qualification', 'anchor', 'floorplan', 'equipment', 'verification', 'review'],
    verification_paths: verification.paths,
    qualification_intro: qualification.intro,
    anchor_intro: anchor.intro,
    catalogue_version: catalogue.version,
    clause_count: clauses.clauses.length,
  });
});

router.get('/catalogue', (req, res) => res.json({ tree: catalogueTree() }));

/* -------------------------------------------------------------- projects */

router.get('/projects', (req, res) => res.json({ projects: store.list() }));

router.post('/projects', (req, res) => {
  const project = store.newProject();
  res.status(201).json({ project, progress: progress(project) });
});

router.get('/projects/:id', wrap((req, res) => {
  const project = requireProject(req);
  res.json({ project, progress: progress(project) });
}));

router.post('/projects/:id/stage', wrap((req, res) => {
  const project = requireProject(req);
  project.stage = req.body.stage;
  store.save(project);
  res.json({ project, progress: progress(project) });
}));

/* --------------------------------------------------------- stage 0 flow */

router.get('/projects/:id/qualification', wrap((req, res) => {
  const project = requireProject(req);
  res.json(qualificationFlow(project));
}));

router.post('/projects/:id/answers', wrap((req, res) => {
  const project = requireProject(req);
  const { qualification, verification } = loadData();
  const { question_id: questionId, value, note } = req.body;

  const standing = [
    ...(verification.standing_questions.walked || []),
    ...(verification.standing_questions.not_walked || []),
  ];
  const question = [...qualification.questions, ...standing].find((q) => q.id === questionId);
  if (!question) {
    return res.status(400).json({ error: `Unknown project question "${questionId}"` });
  }

  project.answers[questionId] = applyAnswer(project.answers[questionId], value, { note });
  applyGates(project, question, value);
  store.save(project);

  res.json({
    ok: true,
    qualification: qualificationFlow(project),
    standing: standingFlow(project),
    progress: progress(project),
  });
}));

/* --------------------------------------------------------- stage 1 anchor */

router.get('/anchors', wrap((req, res) => {
  const { q = '', site_type: siteType, subcontracted } = req.query;
  res.json({
    results: searchAnchors(q, {
      siteType,
      subcontracted: subcontracted === undefined ? undefined : subcontracted === 'true',
    }),
  });
}));

router.post('/projects/:id/anchor', wrap((req, res) => {
  const project = requireProject(req);
  const { project_id: anchorId, query } = req.body;

  if (anchorId === null) {
    project.anchor = null;
    store.save(project);
    return res.json({ ok: true, anchor: null, flow: anchorFlow(project) });
  }

  const anchor = getAnchor(anchorId);
  if (!anchor) return res.status(400).json({ error: `Unknown past project "${anchorId}"` });

  project.anchor = {
    project_id: anchor.id,
    matched_on: query || null,
    selected_at: new Date().toISOString(),
    answers: project.anchor?.project_id === anchor.id ? project.anchor.answers : {},
  };
  store.save(project);
  res.json({ ok: true, anchor, flow: anchorFlow(project), progress: progress(project) });
}));

router.get('/projects/:id/anchor', wrap((req, res) => {
  const project = requireProject(req);
  res.json({
    anchor: project.anchor ? getAnchor(project.anchor.project_id) : null,
    selection: project.anchor,
    flow: anchorFlow(project),
  });
}));

router.post('/projects/:id/anchor/answers', wrap((req, res) => {
  const project = requireProject(req);
  if (!project.anchor) return res.status(400).json({ error: 'No anchor project selected' });

  const { anchor } = loadData();
  const { question_id: questionId, value, note } = req.body;
  const question = anchor.similarity_questions.find((q) => q.id === questionId);
  if (!question) return res.status(400).json({ error: `Unknown anchor question "${questionId}"` });

  project.anchor.answers[questionId] = applyAnswer(project.anchor.answers[questionId], value, { note });
  store.save(project);
  res.json({ ok: true, flow: anchorFlow(project), progress: progress(project) });
}));

/* ------------------------------------------------------ stage 2 floorplan */

router.post('/projects/:id/floorplan', wrap(async (req, res) => {
  const project = requireProject(req);
  const { data, media_type: mediaType, filename, notes } = req.body;
  if (!data) return res.status(400).json({ error: 'No image data supplied' });

  const base64 = String(data).replace(/^data:[^;]+;base64,/, '');
  const stored = `${project.id}-${Date.now()}-${String(filename || 'floorplan').replace(/[^\w.-]/g, '_')}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, stored), Buffer.from(base64, 'base64'));

  try {
    const reading = await readFloorPlan({ base64, mediaType, project, notes });
    project.floorplan = { filename: filename || stored, stored_as: stored, notes: notes || null, ...reading };
    store.save(project);
    res.json({ ok: true, floorplan: project.floorplan, progress: progress(project) });
  } catch (err) {
    const described = describeError(err);
    project.floorplan = {
      filename: filename || stored,
      stored_as: stored,
      notes: notes || null,
      error: described.message,
      proposals: [],
    };
    store.save(project);
    res.status(described.status).json({ error: described.message });
  }
}));

router.post('/projects/:id/floorplan/proposals/:proposalId', wrap((req, res) => {
  const project = requireProject(req);
  const proposal = project.floorplan?.proposals?.find((p) => p.id === req.params.proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const { status, detail } = req.body;
  if (!['accepted', 'rejected', 'edited', 'proposed'].includes(status)) {
    return res.status(400).json({ error: 'status must be accepted, rejected, edited or proposed' });
  }

  proposal.status = status;
  proposal.decided_at = new Date().toISOString();
  if (detail !== undefined && detail !== proposal.detail) {
    proposal.detail = detail;
    proposal.status = status === 'rejected' ? 'rejected' : 'edited';
  }
  store.save(project);
  res.json({ ok: true, proposal, progress: progress(project) });
}));

/* ------------------------------------------------------ stage 3 equipment */

router.post('/projects/:id/lines', wrap((req, res) => {
  const project = requireProject(req);
  const { sku: skuId, quantity, label } = req.body;

  let sku;
  try {
    sku = getSku(skuId);
  } catch {
    return res.status(400).json({ error: `Unknown SKU "${skuId}"` });
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ error: 'quantity must be a positive whole number' });
  }

  const existing = project.lines.filter((l) => l.sku === skuId).length;
  const line = {
    id: crypto.randomUUID(),
    sku: skuId,
    category_id: sku.category_id,
    subtype_id: sku.subtype_id,
    quantity: qty,
    label: label || `${skuId} group ${existing + 1}`,
    note: '',
    answers: {},
    created_at: new Date().toISOString(),
  };
  project.lines.push(line);
  store.save(project);

  res.status(201).json({ line, flow: lineFlow(project, line), progress: progress(project) });
}));

router.patch('/projects/:id/lines/:lineId', wrap((req, res) => {
  const project = requireProject(req);
  const line = findLine(project, req.params.lineId);
  if (req.body.quantity !== undefined) {
    const qty = Number(req.body.quantity);
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'quantity must be a positive whole number' });
    line.quantity = qty;
  }
  if (req.body.label !== undefined) line.label = req.body.label;
  if (req.body.note !== undefined) line.note = req.body.note;
  store.save(project);
  res.json({ line, flow: lineFlow(project, line), progress: progress(project) });
}));

router.delete('/projects/:id/lines/:lineId', wrap((req, res) => {
  const project = requireProject(req);
  findLine(project, req.params.lineId);
  project.lines = project.lines.filter((l) => l.id !== req.params.lineId);
  for (const key of Object.keys(project.verification)) {
    if (key.startsWith(`line:${req.params.lineId}:`)) delete project.verification[key];
  }
  store.save(project);
  res.json({ ok: true, progress: progress(project) });
}));

router.get('/projects/:id/lines/:lineId', wrap((req, res) => {
  const project = requireProject(req);
  const line = findLine(project, req.params.lineId);
  res.json({ line, flow: lineFlow(project, line), sku: getSku(line.sku) });
}));

router.post('/projects/:id/lines/:lineId/answers', wrap((req, res) => {
  const project = requireProject(req);
  const line = findLine(project, req.params.lineId);
  const { question_id: questionId, value, note } = req.body;

  const question = getSkuQuestions(line.sku).find((q) => q.id === questionId);
  if (!question) return res.status(400).json({ error: `Question "${questionId}" is not defined for ${line.sku}` });

  line.answers[questionId] = applyAnswer(line.answers[questionId], value, { note });
  store.save(project);
  res.json({ ok: true, flow: lineFlow(project, line), progress: progress(project) });
}));

router.get('/projects/:id/equipment', wrap((req, res) => {
  const project = requireProject(req);
  res.json({ ...equipmentFlow(project), flags: flags(project) });
}));

/* --------------------------------------------------- stage 4 verification */

router.get('/projects/:id/verification', wrap((req, res) => {
  const project = requireProject(req);
  const { verification } = loadData();
  const path = project.path || 'not_walked';
  res.json({
    path,
    definition: verification.paths[path],
    standing: standingFlow(project),
    ...verificationFlow(project),
  });
}));

router.post('/projects/:id/verification', wrap((req, res) => {
  const project = requireProject(req);
  const { verification } = loadData();
  const path = project.path || 'not_walked';
  const { key, status, basis, basis_note: basisNote } = req.body;

  const allowed = verification.paths[path].options.map((o) => o.value);
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  const option = verification.paths[path].options.find((o) => o.value === status);
  if (option.requires_basis && !basisNote && !basis) {
    return res.status(400).json({ error: `"${option.label}" requires a basis - what confirms it, or what was seen.` });
  }

  project.verification[key] = {
    status,
    basis: basis || null,
    basis_note: basisNote || null,
    tagged_at: new Date().toISOString(),
  };
  store.save(project);
  res.json({ ok: true, ...verificationFlow(project), progress: progress(project) });
}));

/* ------------------------------------------------------------- output */

router.get('/projects/:id/bom', wrap((req, res) => {
  const project = requireProject(req);
  res.json(buildBom(project));
}));

router.get('/projects/:id/preview', wrap((req, res) => {
  const project = requireProject(req);
  res.json(buildDocument(project, { acknowledgedGaps: req.query.acknowledge_gaps === 'true' }));
}));

router.post('/projects/:id/prose', wrap(async (req, res) => {
  const project = requireProject(req);
  try {
    const prose = await draftProse(project);
    project.prose = { ...project.prose, ...prose };
    store.save(project);
    res.json({ ok: true, prose: project.prose });
  } catch (err) {
    const described = describeError(err);
    res.status(described.status).json({ error: described.message });
  }
}));

router.patch('/projects/:id/prose/:section', wrap((req, res) => {
  const project = requireProject(req);
  const section = req.params.section;
  const existing = project.prose[section];
  project.prose[section] = {
    text: req.body.text,
    generated_at: existing?.generated_at || null,
    model: existing?.model || null,
    edited_by_ae: true,
    original_text: existing?.original_text ?? existing?.text ?? null,
    edited_at: new Date().toISOString(),
  };
  store.save(project);
  res.json({ ok: true, prose: project.prose[section] });
}));

router.post('/projects/:id/document', wrap(async (req, res) => {
  const project = requireProject(req);
  const state = readiness(project);
  const acknowledge = req.body.acknowledge_gaps === true;

  if (!state.ready && !acknowledge) {
    return res.status(409).json({
      error: 'This project has unresolved gaps. Nothing unanswered will be written as fact - resolve them, or generate with acknowledge_gaps to produce an internal draft that prints them as open items.',
      readiness: state,
    });
  }

  const doc = buildDocument(project, { acknowledgedGaps: acknowledge });
  const written = await writeDocument(doc, `${doc.meta.client}-${doc.meta.project_name}`);

  project.documents.push({
    filename: written.filename,
    generated_at: new Date().toISOString(),
    bytes: written.bytes,
    ready: state.ready,
    acknowledged_gaps: acknowledge && !state.ready,
    open_item_count: doc.sections.find((s) => s.id === 'open_items')?.blocks.filter((b) => b.type === 'open_item').length || 0,
  });
  store.save(project);

  res.json({
    ok: true,
    document: project.documents[project.documents.length - 1],
    download_url: `/api/projects/${project.id}/documents/${written.filename}`,
    readiness: state,
  });
}));

router.get('/projects/:id/documents/:filename', wrap((req, res) => {
  const project = requireProject(req);
  const record = project.documents.find((d) => d.filename === req.params.filename);
  if (!record) return res.status(404).json({ error: 'Document not found' });
  res.download(path.join(OUTPUT_DIR, record.filename));
}));
