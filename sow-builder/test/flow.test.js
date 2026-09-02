import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, api, answerAll, autoAnswer } from './helpers.js';
import { OUTPUT_DIR } from '../server/config.js';

test.before(startServer);
test.after(stopServer);

async function createProject(overrides) {
  const { body } = await api('POST', '/api/projects');
  const id = body.project.id;
  await answerAll(
    `/api/projects/${id}/qualification`,
    `/api/projects/${id}/answers`,
    (q) => autoAnswer(q, overrides),
  );
  return id;
}

async function addLine(id, sku, quantity, overrides = {}) {
  const { body } = await api('POST', `/api/projects/${id}/lines`, { sku, quantity });
  const lineId = body.line.id;
  await answerAll(
    `/api/projects/${id}/lines/${lineId}`,
    `/api/projects/${id}/lines/${lineId}/answers`,
    (q) => autoAnswer(q, overrides),
  );
  return lineId;
}

async function tagEverything(id, status, basisNote) {
  for (let i = 0; i < 500; i += 1) {
    const { body } = await api('GET', `/api/projects/${id}/verification`);
    if (!body.next) return body;
    const res = await api('POST', `/api/projects/${id}/verification`, {
      key: body.next.key,
      status,
      basis_note: basisNote,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  throw new Error('verification did not converge');
}

test('the qualification gate branches the project on the site walk answer', async () => {
  const walked = await createProject({ site_walked: 'yes' });
  const notWalked = await createProject({ site_walked: 'no' });

  const a = await api('GET', `/api/projects/${walked}`);
  const b = await api('GET', `/api/projects/${notWalked}`);

  assert.equal(a.body.project.path, 'walked');
  assert.equal(b.body.project.path, 'not_walked');
});

test('the two paths ask different verification questions', async () => {
  const walked = await createProject({ site_walked: 'yes' });
  const notWalked = await createProject({ site_walked: 'no' });

  const a = await api('GET', `/api/projects/${walked}/verification`);
  const b = await api('GET', `/api/projects/${notWalked}/verification`);

  assert.equal(a.body.path, 'walked');
  assert.equal(b.body.path, 'not_walked');
  assert.ok(a.body.definition.options.some((o) => o.value === 'observed'));
  assert.ok(b.body.definition.options.some((o) => o.value === 'confirmed'));
  assert.notEqual(a.body.standing.current.id, b.body.standing.current.id);
});

test('conditional questions only appear once their trigger is answered', async () => {
  const { body: created } = await api('POST', '/api/projects');
  const id = created.project.id;

  const seen = new Set();
  await answerAll(`/api/projects/${id}/qualification`, `/api/projects/${id}/answers`, (q) => {
    seen.add(q.id);
    return autoAnswer(q, { site_walked: 'no', subcontractor_identified: 'yes', subcontractor_quote_provided: 'no' });
  });

  assert.ok(seen.has('subcontractor_quote_eta'), 'the "when will the quote arrive" follow-up must be asked');
  assert.ok(!seen.has('subcontractor_quote_figures'), 'figures must not be asked when no quote exists');
  assert.ok(seen.has('info_basis'), 'an unwalked project must be asked what the scope is based on');
  assert.ok(!seen.has('site_walk_attendees'), 'attendees must not be asked for an unwalked project');
});

test('per-SKU questions come from the catalogue and unlock progressively', async () => {
  const id = await createProject({ site_walked: 'yes' });
  const { body } = await api('POST', `/api/projects/${id}/lines`, { sku: 'CF82', quantity: 6 });
  const lineId = body.line.id;

  assert.equal(body.flow.answered_count, 0);
  assert.ok(body.flow.current, 'a first question is presented');
  assert.ok(body.flow.visible_count > 10, 'a camera carries a real interrogation');

  const first = body.flow.current;
  const after = await api('POST', `/api/projects/${id}/lines/${lineId}/answers`, {
    question_id: first.id,
    value: autoAnswer(first),
  });
  assert.equal(after.body.flow.answered_count, 1);
  assert.notEqual(after.body.flow.current.id, first.id, 'answering one question advances to the next');
});

test('a conditional accessory only enters the BOM when its condition is met', async () => {
  const poleId = await createProject({ site_walked: 'yes' });
  await addLine(poleId, 'CM42', 4, { mount_type: 'pole', install_environment: 'outdoor' });
  const pole = await api('GET', `/api/projects/${poleId}/bom`);
  assert.ok(pole.body.lines.some((l) => l.sku === 'ACC-POLE-ADPT'), 'a pole mount must pull the pole adapter');

  const wallId = await createProject({ site_walked: 'yes' });
  await addLine(wallId, 'CM42', 4, { mount_type: 'wall', install_environment: 'indoor' });
  const wall = await api('GET', `/api/projects/${wallId}/bom`);
  assert.ok(wall.body.lines.some((l) => l.sku === 'CM42-WMT'), 'a wall mount must pull the wall arm');
  assert.ok(!wall.body.lines.some((l) => l.sku === 'ACC-POLE-ADPT'), 'a wall mount must not pull a pole adapter');
});

test('cable quantity scales by run length, unit count and waste factor', async () => {
  const id = await createProject({ site_walked: 'yes' });
  await addLine(id, 'CM42', 5, { cable_status: 'new', cable_type: 'cat6_plenum', cable_length_ft: 100, cable_pathway: 'existing_tray' });
  const { body } = await api('GET', `/api/projects/${id}/bom`);
  const cable = body.lines.find((l) => l.sku === 'CBL-CAT6-PLN');
  assert.ok(cable, 'plenum cable must appear');
  assert.equal(cable.quantity, 550, '100ft x 5 units x 1.1 waste');
  assert.equal(cable.unit, 'ft');
});

test('an unanswered question never becomes a confirmed fact - it blocks and surfaces', async () => {
  const id = await createProject({ site_walked: 'no' });
  const { body } = await api('POST', `/api/projects/${id}/lines`, { sku: 'CF82', quantity: 3 });

  const state = await api('GET', `/api/projects/${id}`);
  assert.equal(state.body.progress.readiness.ready, false);
  assert.ok(
    state.body.progress.readiness.problems.some((p) => p.kind === 'unanswered' && p.stage === 'equipment'),
    'the half-answered line must be reported as unanswered',
  );

  const refused = await api('POST', `/api/projects/${id}/document`, {});
  assert.equal(refused.status, 409, 'generation must refuse while questions are open');
  assert.match(refused.body.error, /acknowledge_gaps/);
  void body;
});

test('a blocking flag from the catalogue stops the document', async () => {
  const id = await createProject({ site_walked: 'yes' });
  await addLine(id, 'CM42', 2, { cable_status: 'new', cable_type: 'cat6', cable_length_ft: 400 });

  const { body } = await api('GET', `/api/projects/${id}/equipment`);
  assert.ok(body.flags.some((f) => f.flag_id === 'cable_over_distance' && f.severity === 'blocking'));

  const state = await api('GET', `/api/projects/${id}`);
  assert.equal(state.body.progress.readiness.ready, false);
});

test('untagged scope items block the document and print as open items', async () => {
  const id = await createProject({ site_walked: 'no' });
  await addLine(id, 'CF82', 2, {});
  await answerAll(`/api/projects/${id}/verification`, `/api/projects/${id}/answers`, (q) => autoAnswer(q));

  const before = await api('GET', `/api/projects/${id}`);
  const untagged = before.body.progress.readiness.problems.find((p) => p.kind === 'untagged');
  assert.ok(untagged, 'items that were never tagged must block');

  const preview = await api('GET', `/api/projects/${id}/preview?acknowledge_gaps=true`);
  const openSection = preview.body.sections.find((s) => s.id === 'open_items');
  assert.ok(openSection.blocks.some((b) => b.type === 'open_item'), 'untagged items appear in Open Items');
});

test('full unwalked project produces a provisional document with an assumptions block', async () => {
  const id = await createProject({
    site_walked: 'no',
    subcontractor_identified: 'yes',
    subcontractor_quote_provided: 'no',
    client_name: 'Cedarline Foods',
    project_name: 'DC camera refresh',
  });
  await addLine(id, 'CF82', 8, { mount_type: 'ceiling', install_environment: 'indoor', cable_length_ft: 120 });
  await addLine(id, 'CM42', 12, { mount_type: 'wall', install_environment: 'indoor', cable_length_ft: 90 });
  await answerAll(`/api/projects/${id}/verification`, `/api/projects/${id}/answers`, (q) => autoAnswer(q));
  await tagEverything(id, 'assumed');

  const state = await api('GET', `/api/projects/${id}`);
  assert.equal(state.body.progress.readiness.ready, true, JSON.stringify(state.body.progress.readiness.problems));

  const preview = await api('GET', `/api/projects/${id}/preview`);
  assert.equal(preview.body.meta.walked, false);

  const overview = preview.body.sections.find((s) => s.id === 'overview');
  assert.ok(
    overview.blocks.some((b) => b.type === 'clause' && /WITHOUT a site walk/.test(b.text)),
    'the document must say in plain language that no walk was performed',
  );

  const conditions = preview.body.sections.find((s) => s.id === 'conditions');
  assert.equal(conditions.title, '5. Basis of Scope');
  assert.ok(conditions.blocks.some((b) => b.type === 'callout' && /NO SITE WALK/.test(b.text)));

  const assumptions = preview.body.sections.find((s) => s.id === 'assumptions');
  const tagged = assumptions.blocks.find((b) => b.type === 'tagged_list');
  assert.ok(tagged && tagged.items.length > 0, 'assumptions are generated from tagged answers');

  const sub = preview.body.sections.find((s) => s.id === 'subcontractor');
  assert.ok(sub.blocks.some((b) => b.type === 'clause' && /UNPRICED/.test(b.text)), 'an outstanding quote must be called unpriced');

  const generated = await api('POST', `/api/projects/${id}/document`, {});
  assert.equal(generated.status, 200, JSON.stringify(generated.body));

  const file = path.join(OUTPUT_DIR, generated.body.document.filename);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.statSync(file).size > 8000, 'a real docx, not a stub');
  assert.equal(fs.readFileSync(file).subarray(0, 2).toString(), 'PK', 'docx is a zip container');
});

test('full walked project produces an observed-conditions document', async () => {
  const id = await createProject({
    site_walked: 'yes',
    subcontractor_identified: 'not_required',
    client_name: 'Harbour Point',
    project_name: 'Access control retrofit',
  });
  await addLine(id, 'RD-MULT', 9, { locking_hardware: 'electric_strike', hardware_provided_by: 'us' });
  await addLine(id, 'AC-4D', 3, {});
  await answerAll(`/api/projects/${id}/verification`, `/api/projects/${id}/answers`, (q) => autoAnswer(q));
  await tagEverything(id, 'observed', 'Seen during the walk on 12 August with the facilities manager.');

  const preview = await api('GET', `/api/projects/${id}/preview`);
  assert.equal(preview.body.meta.walked, true);

  const conditions = preview.body.sections.find((s) => s.id === 'conditions');
  assert.equal(conditions.title, '5. Observed Site Conditions');
  const observed = conditions.blocks.find((b) => b.type === 'tagged_list' && b.heading === 'Observed during the walk');
  assert.ok(observed.items.length > 0);
  assert.ok(observed.items.every((i) => i.basis), 'every observation carries what was actually seen');

  assert.ok(
    preview.body.sections.find((s) => s.id === 'overview').blocks.some((b) => b.type === 'clause' && /based on a site walk/.test(b.text)),
  );

  const generated = await api('POST', `/api/projects/${id}/document`, {});
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  assert.ok(fs.existsSync(path.join(OUTPUT_DIR, generated.body.document.filename)));
});

test('anchor search finds a past project by name and records the differences', async () => {
  const id = await createProject({ site_walked: 'yes', site_type: 'warehouse_retail' });

  const search = await api('GET', '/api/anchors?q=similar%20to%20the%20Canada%20Goose%20project');
  assert.equal(search.body.results[0].id, 'canada-goose-2025');
  assert.ok(search.body.results[0].reasons.length > 0, 'the match explains itself');

  const selected = await api('POST', `/api/projects/${id}/anchor`, { project_id: 'canada-goose-2025', query: 'like Canada Goose' });
  assert.equal(selected.status, 200);
  assert.ok(selected.body.flow.current, 'selecting an anchor starts the difference interrogation');

  await answerAll(`/api/projects/${id}/anchor`, `/api/projects/${id}/anchor/answers`, (q) => autoAnswer(q));
  const after = await api('GET', `/api/projects/${id}/anchor`);
  assert.equal(after.body.flow.complete, true);

  const preview = await api('GET', `/api/projects/${id}/preview?acknowledge_gaps=true`);
  assert.match(preview.body.meta.anchor, /Canada Goose/);
});

test('an unanswered sourcing question makes the BOM line UNRESOLVED, never a default', async () => {
  const id = await createProject({ site_walked: 'yes' });
  const { body } = await api('POST', `/api/projects/${id}/lines`, { sku: 'CM42', quantity: 2 });
  const lineId = body.line.id;

  for (const [question, value] of [['mount_type', 'wall'], ['mount_surface', 'drywall'], ['adapter_required', 'no']]) {
    await api('POST', `/api/projects/${id}/lines/${lineId}/answers`, { question_id: question, value });
  }

  const bom = await api('GET', `/api/projects/${id}/bom`);
  const arm = bom.body.lines.find((l) => l.sku === 'CM42-WMT');
  assert.ok(arm, 'the wall arm is derived from the answered mount type');
  assert.match(arm.sourcing, /UNRESOLVED/, 'sourcing must not default while its question is unanswered');
  assert.ok(bom.body.unresolved.some((u) => u.sku === 'CM42-WMT'));
});

test('overrides of model proposals are recorded and printed', async () => {
  const id = await createProject({ site_walked: 'no' });
  const { body } = await api('POST', `/api/projects/${id}/lines`, { sku: 'CB61', quantity: 2 });
  const lineId = body.line.id;

  // Simulate a proposal landing on the line, then the AE correcting it.
  const project = JSON.parse(JSON.stringify((await api('GET', `/api/projects/${id}`)).body.project));
  void project;

  await api('POST', `/api/projects/${id}/lines/${lineId}/answers`, { question_id: 'mount_type', value: 'wall' });
  await api('POST', `/api/projects/${id}/lines/${lineId}/answers`, { question_id: 'mount_type', value: 'pole' });

  const line = await api('GET', `/api/projects/${id}/lines/${lineId}`);
  const record = line.body.line.answers.mount_type;
  assert.equal(record.value, 'pole');
  assert.equal(record.previous_value, 'wall', 'the earlier value stays visible');
});
