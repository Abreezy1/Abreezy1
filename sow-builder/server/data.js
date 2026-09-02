/**
 * Loads and indexes the data files. Adding a camera model, a question or a
 * clause means editing data/ - never this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

function readJson(...segments) {
  const file = path.join(DATA_DIR, ...segments);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot load data file ${file}: ${err.message}`);
  }
}

function buildCatalogueIndex(catalogue) {
  const skus = new Map();
  for (const category of catalogue.categories) {
    for (const subtype of category.subtypes) {
      for (const sku of subtype.skus) {
        if (skus.has(sku.sku)) {
          throw new Error(`Duplicate SKU "${sku.sku}" in the catalogue`);
        }
        skus.set(sku.sku, { ...sku, category_id: category.id, category_label: category.label, subtype_id: subtype.id, subtype_label: subtype.label });
      }
    }
  }
  return skus;
}

/**
 * Resolves the full ordered question list for a SKU: its shared question sets
 * first (in the order the SKU lists them), then its own SKU-specific questions.
 */
function resolveSkuQuestions(catalogue, sku) {
  const questions = [];
  const setIds = [...(sku.question_sets || []), ...(catalogue.universal_question_sets || [])];
  for (const setId of setIds) {
    const set = catalogue.question_sets[setId];
    if (!set) throw new Error(`SKU ${sku.sku} references unknown question set "${setId}"`);
    for (const q of set.questions) questions.push({ ...q, group: set.label, group_id: setId });
  }
  for (const q of sku.questions || []) {
    questions.push({ ...q, group: `${sku.sku} specifics`, group_id: `sku_${sku.sku}` });
  }

  const seen = new Set();
  for (const q of questions) {
    if (seen.has(q.id)) throw new Error(`SKU ${sku.sku} has duplicate question id "${q.id}"`);
    seen.add(q.id);
  }
  return questions;
}

let cache = null;

export function loadData({ reload = false } = {}) {
  if (cache && !reload) return cache;

  const catalogue = readJson('catalogue', 'equipment.json');
  const qualification = readJson('questions', 'qualification.json');
  const anchor = readJson('questions', 'anchor.json');
  const verification = readJson('questions', 'verification.json');
  const clauses = readJson('clauses', 'sow-clauses.json');
  const manifest = readJson('sows', 'manifest.json');

  const skuIndex = buildCatalogueIndex(catalogue);
  const questionsBySku = new Map();
  for (const [id, sku] of skuIndex) {
    questionsBySku.set(id, resolveSkuQuestions(catalogue, sku));
  }

  const accessoryIndex = new Map(
    (catalogue.accessory_catalogue || []).map((a) => [a.sku, a]),
  );

  cache = {
    catalogue,
    qualification,
    anchor,
    verification,
    clauses,
    manifest,
    skuIndex,
    questionsBySku,
    accessoryIndex,
  };
  return cache;
}

export function getSku(skuId) {
  const { skuIndex } = loadData();
  const sku = skuIndex.get(skuId);
  if (!sku) throw new Error(`Unknown SKU "${skuId}"`);
  return sku;
}

export function getSkuQuestions(skuId) {
  const { questionsBySku } = loadData();
  const questions = questionsBySku.get(skuId);
  if (!questions) throw new Error(`Unknown SKU "${skuId}"`);
  return questions;
}

/** The tree the UI renders. Structure comes entirely from the data file. */
export function catalogueTree() {
  const { catalogue } = loadData();
  return catalogue.categories.map((category) => ({
    id: category.id,
    label: category.label,
    subtypes: category.subtypes.map((subtype) => ({
      id: subtype.id,
      label: subtype.label,
      skus: subtype.skus.map((sku) => ({
        sku: sku.sku,
        name: sku.name,
        description: sku.description,
        unit: sku.unit,
        question_count: resolveSkuQuestions(catalogue, sku).length,
      })),
    })),
  }));
}

/** Human label for an option value, for document prose. */
export function labelFor(question, value) {
  if (!question || !Array.isArray(question.options)) return value;
  if (Array.isArray(value)) {
    return value.map((v) => labelFor(question, v)).join(', ');
  }
  const option = question.options.find((o) => o.value === value);
  return option ? option.label : value;
}
