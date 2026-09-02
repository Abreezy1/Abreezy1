/**
 * Exercises the Anthropic request path end to end against a stub endpoint:
 * real SDK, real prompt assembly, real structured-output parsing. Proves the
 * wiring without spending a live call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, stopServer, api, answerAll, autoAnswer } from './helpers.js';

let stub;
let received = [];

test.before(async () => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      received.push({ url: req.url, headers: req.headers, body: parsed });

      const isFloorPlan = JSON.stringify(parsed.messages).includes('Read this floor plan');
      const payload = isFloorPlan
        ? {
            plan_description: 'Single storey warehouse with an attached office block.',
            legibility: 'partial',
            legibility_note: 'Door tags are legible; ceiling heights are not printed.',
            estimated_camera_count: 9,
            estimated_door_count: 4,
            proposals: [
              {
                kind: 'camera_placement', summary: 'Fisheye over the pick floor',
                detail: 'One fisheye centred on the pick aisles.', location_hint: 'Centre of the warehouse floor',
                suggested_sku: 'CF82', quantity: 1, confidence: 'medium', why: 'Open floor with no columns shown.',
              },
              {
                kind: 'coverage_gap', summary: 'Rear exit unwatched',
                detail: 'The southeast personnel door has no camera near it.', location_hint: 'Southeast corner',
                suggested_sku: 'CM42', quantity: 1, confidence: 'high', why: 'Exit shown on plan with no device nearby.',
              },
            ],
          }
        : {
            overview: 'Stub overview paragraph.',
            site_description: 'Stub site description.',
            work_included: 'Stub work included narrative.',
            subcontractor: '',
          };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 100 },
      }));
    });
  });
  await new Promise((resolve) => stub.listen(0, resolve));

  process.env.ANTHROPIC_API_KEY = 'sk-ant-stub';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
  const { resetClient } = await import('../server/anthropic.js');
  resetClient();

  await startServer();
});

test.after(async () => {
  await stopServer();
  await new Promise((resolve) => stub.close(resolve));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

async function readyProject() {
  const { body } = await api('POST', '/api/projects');
  const id = body.project.id;
  await answerAll(`/api/projects/${id}/qualification`, `/api/projects/${id}/answers`, (q) =>
    autoAnswer(q, { site_walked: 'no', subcontractor_identified: 'not_required', client_name: 'Stub Co', project_name: 'Stub project' }));
  const line = await api('POST', `/api/projects/${id}/lines`, { sku: 'CF82', quantity: 4 });
  await answerAll(
    `/api/projects/${id}/lines/${line.body.line.id}`,
    `/api/projects/${id}/lines/${line.body.line.id}/answers`,
    (q) => autoAnswer(q),
  );
  await answerAll(`/api/projects/${id}/verification`, `/api/projects/${id}/answers`, (q) => autoAnswer(q));
  return id;
}

test('the drafting pass sends the tagged facts and stores prose the AE can edit', async () => {
  received = [];
  const id = await readyProject();

  const res = await api('POST', `/api/projects/${id}/prose`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.prose.overview.text, 'Stub overview paragraph.');
  assert.equal(res.body.prose.overview.edited_by_ae, false);
  assert.ok(!('subcontractor' in res.body.prose), 'empty passages are dropped, not stored blank');

  const request = received.at(-1);
  assert.match(request.url, /\/v1\/messages/);
  assert.equal(request.body.model, 'claude-opus-5');
  assert.deepEqual(request.body.thinking, { type: 'adaptive' });
  assert.equal(request.body.output_format.type, 'json_schema');
  assert.match(request.headers['anthropic-beta'] || '', /structured-outputs/);

  const prompt = request.body.messages[0].content;
  assert.match(prompt, /VERIFICATION PATH: NOT SITE WALKED/);
  assert.match(prompt, /VERIFICATION STATUS OF EVERY SCOPE ITEM/);
  assert.match(request.body.system, /Never write an assumed or unverified item as though it were established/);
  assert.match(request.body.system, /Do not write assumptions, exclusions/);

  const edited = await api('PATCH', `/api/projects/${id}/prose/overview`, { text: 'Rewritten by the AE.' });
  assert.equal(edited.body.prose.edited_by_ae, true);
  assert.equal(edited.body.prose.original_text, 'Stub overview paragraph.');

  const preview = await api('GET', `/api/projects/${id}/preview?acknowledge_gaps=true`);
  const overview = preview.body.sections.find((s) => s.id === 'overview');
  assert.equal(overview.blocks[0].text, 'Rewritten by the AE.', 'the AE edit wins over the generated draft');
});

test('the drafting pass never sees an untagged item as confirmed', async () => {
  received = [];
  const id = await readyProject();
  await api('POST', `/api/projects/${id}/prose`, {});
  const prompt = received.at(-1).body.messages[0].content;
  assert.match(prompt, /\[NOT VERIFIED\]/, 'untagged items are labelled NOT VERIFIED in the prompt');
  assert.ok(!/\[CONFIRMED\]/.test(prompt), 'nothing is described as confirmed until a person tags it');
});

test('floor plan proposals arrive as proposals and stay unverified until accepted', async () => {
  received = [];
  const { body: created } = await api('POST', '/api/projects');
  const id = created.project.id;
  await answerAll(`/api/projects/${id}/qualification`, `/api/projects/${id}/answers`, (q) =>
    autoAnswer(q, { site_walked: 'no', subcontractor_identified: 'not_required' }));

  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  ).toString('base64');

  const upload = await api('POST', `/api/projects/${id}/floorplan`, {
    data: png, media_type: 'image/png', filename: 'plan.png', notes: 'ground floor only',
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  assert.equal(upload.body.floorplan.proposals.length, 2);
  assert.ok(upload.body.floorplan.proposals.every((p) => p.status === 'proposed'), 'nothing arrives accepted');
  assert.equal(upload.body.floorplan.legibility, 'partial');

  const sent = received.at(-1).body.messages[0].content;
  assert.equal(sent[0].type, 'image');
  assert.equal(sent[0].source.media_type, 'image/png');
  assert.match(sent[1].text, /ground floor only/);
  assert.match(sent[1].text, /NO - nothing on this plan can be verified/);

  // Untouched proposals must not become facts.
  const preview = await api('GET', `/api/projects/${id}/preview?acknowledge_gaps=true`);
  const open = preview.body.sections.find((s) => s.id === 'open_items');
  assert.ok(
    open.blocks.some((b) => b.type === 'open_item' && /Floor plan/.test(b.text)),
    'unaccepted floor plan proposals surface as open items',
  );

  // Accepting one moves it out of open items; rejecting one is recorded as an override.
  const [first, second] = upload.body.floorplan.proposals;
  await api('POST', `/api/projects/${id}/floorplan/proposals/${first.id}`, { status: 'accepted' });
  await api('POST', `/api/projects/${id}/floorplan/proposals/${second.id}`, { status: 'rejected' });

  const after = await api('GET', `/api/projects/${id}/preview?acknowledge_gaps=true`);
  const overrides = after.body.sections.find((s) => s.id === 'overrides');
  assert.ok(overrides, 'a rejected proposal is recorded in the overrides appendix');
  assert.ok(overrides.blocks.some((b) => b.type === 'override_table' && b.rows.some((r) => /REJECTED/.test(r.to))));
});

test('an unsupported floor plan format is refused before any API call', async () => {
  received = [];
  const { body: created } = await api('POST', '/api/projects');
  const res = await api('POST', `/api/projects/${created.project.id}/floorplan`, {
    data: 'AAAA', media_type: 'application/pdf', filename: 'plan.pdf',
  });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /Unsupported image type/);
  assert.equal(received.length, 0, 'no API call is made for an unusable file');
});
