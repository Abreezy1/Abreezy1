/* SOW Builder - single page front end. Renders whatever the data files define;
   it contains no question text, no SKUs and no clause wording of its own. */

const state = {
  meta: null,
  projectId: null,
  project: null,
  progress: null,
  view: 'projects',
  activeLine: null,
  catalogue: null,
};

/* ------------------------------------------------------------------ utils */

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

let toastTimer;
function toast(message, isError = false) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), isError ? 8000 : 3500);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

/* ------------------------------------------------------- question rendering */

/**
 * Renders one question. The whole tree is never shown at once - this is the
 * single card the AE is looking at.
 */
function questionCard(question, { counter, onSubmit, submitLabel = 'Save & continue' }) {
  let getValue;
  const body = el('div');

  if (question.type === 'select') {
    const name = `q_${question.id}`;
    const options = el('div', { class: 'options' },
      question.options.map((option) =>
        el('label', {},
          el('input', { type: 'radio', name, value: option.value }),
          el('span', {}, option.label))));
    body.append(options);
    if (question.allow_other) {
      const other = el('input', { type: 'text', placeholder: 'Other - type a value', style: 'margin-top:8px' });
      body.append(other);
      getValue = () => other.value.trim() || options.querySelector('input:checked')?.value || null;
    } else {
      getValue = () => options.querySelector('input:checked')?.value || null;
    }
  } else if (question.type === 'multiselect') {
    const options = el('div', { class: 'options' },
      question.options.map((option) =>
        el('label', {}, el('input', { type: 'checkbox', value: option.value }), el('span', {}, option.label))));
    body.append(options);
    getValue = () => [...options.querySelectorAll('input:checked')].map((i) => i.value);
  } else if (question.type === 'longtext') {
    const input = el('textarea', { placeholder: 'Write it out - this goes into the document' });
    body.append(input);
    getValue = () => input.value.trim();
  } else {
    const input = el('input', {
      type: question.type === 'number' ? 'number' : question.type === 'date' ? 'date' : 'text',
      min: question.min, max: question.max,
    });
    body.append(input);
    getValue = () => (question.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value.trim());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  async function submit() {
    const value = getValue();
    const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty && question.required !== false) {
      toast('This question has to be answered. If the answer is unknown, choose or write "unknown" - it will be carried as an assumption.', true);
      return;
    }
    await guard(() => onSubmit(value));
  }

  return el('div', { class: 'q-card' },
    counter ? el('div', { class: 'counter' }, counter) : null,
    el('div', { class: 'prompt' }, question.prompt),
    question.help ? el('div', { class: 'help' }, question.help) : null,
    body,
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: submit }, submitLabel)));
}

function answeredList(entries, { onEdit, title = 'Answered' }) {
  if (!entries.length) return null;
  return el('div', { class: 'answered' },
    el('h3', {}, `${title} (${entries.length})`),
    entries.map(({ question, record }) =>
      el('div', { class: 'answered-row' },
        question.group ? el('span', { class: 'group' }, question.group) : null,
        el('span', { class: 'p' }, question.prompt),
        el('span', { class: 'v' },
          formatValue(question, record.value),
          record.overridden ? el('span', { class: 'badge accent', style: 'margin-left:6px' }, 'overridden') : null,
          record.confirmed_by_ae === false ? el('span', { class: 'badge warn', style: 'margin-left:6px' }, 'proposed') : null),
        el('button', { class: 'small', onclick: () => onEdit(question) }, 'Change'))));
}

function formatValue(question, value) {
  if (Array.isArray(value)) return value.map((v) => optionLabel(question, v)).join(', ');
  return optionLabel(question, value);
}

function optionLabel(question, value) {
  const option = question.options?.find((o) => o.value === value);
  return option ? option.label : String(value ?? '');
}

/* ------------------------------------------------------------------- rail */

const STAGE_LABELS = {
  qualification: 'Qualification gate',
  anchor: 'Anchor project',
  floorplan: 'Floor plan',
  equipment: 'Equipment',
  verification: 'Assumptions / observed',
  review: 'Review & document',
};

function renderRail() {
  const rail = document.getElementById('rail');
  rail.replaceChildren();

  if (!state.project) {
    rail.append(el('button', { class: state.view === 'projects' ? 'active' : '', onclick: () => setView('projects') }, 'Projects'));
    return;
  }

  const p = state.progress;
  const meta = {
    qualification: `${p.qualification.answered_count}/${p.qualification.visible_count} answered`,
    anchor: state.project.anchor ? (p.anchor?.complete ? 'differences captured' : 'differences outstanding') : 'not anchored',
    floorplan: state.project.floorplan ? `${(state.project.floorplan.proposals || []).length} proposals` : 'optional',
    equipment: `${p.equipment.lines.length} groups, ${p.equipment.lines.filter((l) => l.complete).length} complete`,
    verification: p.verification.total ? `${p.verification.tagged}/${p.verification.total} tagged` : 'nothing to tag yet',
    review: p.readiness.ready ? 'ready' : `${p.readiness.blocking_count} blocking`,
  };

  const gateOpen = p.qualification.complete;
  for (const [stage, label] of Object.entries(STAGE_LABELS)) {
    const locked = stage !== 'qualification' && !gateOpen;
    rail.append(el('button', {
      class: state.view === stage ? 'active' : '',
      disabled: locked,
      title: locked ? 'Finish the qualification gate first' : '',
      onclick: () => setView(stage),
    }, label, el('span', { class: 'step-meta' }, locked ? 'locked until the gate is answered' : meta[stage])));
  }

  rail.append(el('hr'));
  rail.append(el('div', { class: 'small muted', style: 'padding:4px 10px' },
    state.project.path
      ? el('span', { class: `badge ${state.project.path === 'walked' ? 'ok' : 'warn'}` },
          state.project.path === 'walked' ? 'Site walked' : 'No site walk - provisional')
      : el('span', { class: 'badge' }, 'Path not set')));
  rail.append(el('button', { onclick: () => setView('projects') }, 'All projects'));
}

/* ------------------------------------------------------------------ views */

async function setView(view) {
  state.view = view;
  await render();
}

async function refreshProject() {
  const data = await api('GET', `/api/projects/${state.projectId}`);
  state.project = data.project;
  state.progress = data.progress;
  document.getElementById('project-label').textContent =
    `${state.project.answers.client_name?.value || 'Unnamed'} - ${state.project.answers.project_name?.value || 'untitled'}`;
}

async function openProject(id) {
  state.projectId = id;
  await refreshProject();
  await setView(state.progress.qualification.complete ? 'equipment' : 'qualification');
}

async function render() {
  renderRail();
  const main = document.getElementById('main');
  main.replaceChildren(el('div', { class: 'panel muted' }, 'Loading...'));
  const view = await VIEWS[state.view]();
  main.replaceChildren(...(Array.isArray(view) ? view : [view]));
}

/* --------------------------------------------------------- projects view */

async function viewProjects() {
  const { projects } = await api('GET', '/api/projects');
  return el('div', { class: 'panel' },
    el('h2', {}, 'Projects'),
    el('p', { class: 'intro' }, 'Every scope starts at the qualification gate. The answers there decide whether the document is an observed-conditions scope or a provisional one carrying an assumptions block.'),
    projects.length === 0 ? el('p', { class: 'muted' }, 'No projects yet.') : null,
    el('div', { class: 'projects' },
      projects.map((p) =>
        el('div', { class: 'project-row', onclick: () => openProject(p.id) },
          el('span', { class: 'name' }, `${p.client} - ${p.project_name || 'untitled'}`),
          el('span', { class: 'meta' }, `${p.line_count} equipment groups`),
          el('span', { class: `badge ${p.path === 'walked' ? 'ok' : p.path ? 'warn' : ''}` },
            p.path === 'walked' ? 'walked' : p.path ? 'provisional' : 'gate open'),
          el('span', { class: 'meta' }, new Date(p.updated_at).toLocaleString())))));
}

/* ---------------------------------------------------- stage 0 - the gate */

async function viewQualification() {
  const flow = await api('GET', `/api/projects/${state.projectId}/qualification`);
  const submit = async (question, value) => {
    await api('POST', `/api/projects/${state.projectId}/answers`, { question_id: question.id, value });
    await refreshProject();
    await render();
  };

  const panel = el('div', { class: 'panel' },
    el('h2', {}, 'Stage 0 - Qualification gate'),
    el('p', { class: 'intro' }, state.meta.qualification_intro),
    flow.current
      ? questionCard(flow.current, {
          counter: `Question ${flow.answered_count + 1} of ${flow.visible_count}`,
          onSubmit: (value) => submit(flow.current, value),
        })
      : el('div', { class: 'callout ok' }, 'Gate complete. The path is set and the rest of the flow is unlocked.'),
    answeredList(flow.answered, {
      onEdit: (question) => editAnswer(question, `/api/projects/${state.projectId}/answers`),
    }));

  return panel;
}

/** Re-asks a single answered question in place. */
function editAnswer(question, url, extra = {}) {
  const main = document.getElementById('main');
  const card = questionCard(question, {
    counter: 'Changing a recorded answer',
    submitLabel: 'Update',
    onSubmit: async (value) => {
      await api('POST', url, { question_id: question.id, value, ...extra });
      await refreshProject();
      await render();
      toast('Answer updated.');
    },
  });
  main.replaceChildren(el('div', { class: 'panel' },
    el('h2', {}, 'Change an answer'),
    el('p', { class: 'intro' }, 'The previous value stays on the record. If the model proposed it and you are changing it, the change is printed in the document appendix.'),
    card,
    el('div', { class: 'actions' }, el('button', { onclick: render }, 'Cancel'))));
}

/* ------------------------------------------------- stage 1 - anchor */

async function viewAnchor() {
  const current = await api('GET', `/api/projects/${state.projectId}/anchor`);
  const panel = el('div', { class: 'panel' },
    el('h2', {}, 'Stage 1 - Anchor to a past project'),
    el('p', { class: 'intro' }, state.meta.anchor_intro));

  const results = el('div', { class: 'item-list' });
  const search = el('input', { type: 'text', placeholder: 'e.g. similar to the Canada Goose project' });

  async function runSearch() {
    const siteType = state.project.answers.site_type?.value || '';
    const data = await api('GET', `/api/anchors?q=${encodeURIComponent(search.value)}&site_type=${encodeURIComponent(siteType)}`);
    results.replaceChildren(...data.results.slice(0, 6).map((r) =>
      el('div', { class: 'item' },
        el('div', {},
          el('span', { class: 'value' }, `${r.client} - ${r.project_name}`),
          ' ',
          el('span', { class: 'badge' }, `${r.year}`),
          ' ',
          el('span', { class: 'badge' }, `${r.camera_count} cameras / ${r.door_count} doors`),
          ' ',
          el('span', { class: `badge ${r.site_walked ? 'ok' : 'warn'}` }, r.site_walked ? 'was walked' : 'was provisional')),
        el('div', { class: 'prompt' }, r.summary),
        r.reasons.length ? el('div', { class: 'small muted' }, `Matched on: ${r.reasons.join('; ')}`) : null,
        r.lessons ? el('div', { class: 'small' }, el('strong', {}, 'What went wrong there: '), r.lessons) : null,
        el('div', { class: 'tagrow' },
          el('button', { class: 'small primary', onclick: () => guard(async () => {
            await api('POST', `/api/projects/${state.projectId}/anchor`, { project_id: r.id, query: search.value });
            await refreshProject();
            await render();
          }) }, 'Use as the baseline')))));
  }

  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(runSearch); });
  panel.append(el('div', { class: 'actions' }, search, el('button', { onclick: () => guard(runSearch) }, 'Search')), results);
  runSearch();

  if (current.anchor) {
    const flow = current.flow;
    panel.append(
      el('h3', {}, `Baseline: ${current.anchor.client} - ${current.anchor.project_name}`),
      el('div', { class: 'callout info' }, 'Everything from here is about the differences from this project, not a scope rebuilt from nothing.'),
      flow.current
        ? questionCard(flow.current, {
            counter: `Difference ${flow.answered_count + 1} of ${flow.visible_count}`,
            onSubmit: async (value) => {
              await api('POST', `/api/projects/${state.projectId}/anchor/answers`, { question_id: flow.current.id, value });
              await refreshProject();
              await render();
            },
          })
        : el('div', { class: 'callout ok' }, 'Differences captured.'),
      answeredList(flow.answered, {
        title: 'Recorded differences',
        onEdit: (question) => editAnswer(question, `/api/projects/${state.projectId}/anchor/answers`),
      }),
      el('div', { class: 'actions' },
        el('button', { class: 'danger small', onclick: () => guard(async () => {
          await api('POST', `/api/projects/${state.projectId}/anchor`, { project_id: null });
          await refreshProject();
          await render();
        }) }, 'Remove anchor')));
  }

  return panel;
}

/* ---------------------------------------------- stage 2 - floor plan */

async function viewFloorplan() {
  const fp = state.project.floorplan;
  const panel = el('div', { class: 'panel' },
    el('h2', {}, 'Stage 2 - Floor plan intake (optional)'),
    el('p', { class: 'intro' }, 'Upload a plan and the model returns a first-pass reading. Everything it returns is a proposal you correct. Anything you do not explicitly accept stays flagged as unverified and flows into the assumptions block.'));

  if (!state.meta.api_available) {
    panel.append(el('div', { class: 'callout' }, 'No Anthropic API key is configured, so floor plan reading is unavailable. Every other stage still works.'));
    return panel;
  }

  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  const notes = el('input', { type: 'text', placeholder: 'Notes for the model - e.g. "ground floor only, ignore the mezzanine"' });
  const upload = el('button', { class: 'primary', onclick: () => guard(async () => {
    const chosen = file.files[0];
    if (!chosen) return toast('Choose an image first.', true);
    upload.disabled = true;
    upload.textContent = 'Reading the plan...';
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(chosen);
      });
      await api('POST', `/api/projects/${state.projectId}/floorplan`, {
        data, media_type: chosen.type, filename: chosen.name, notes: notes.value,
      });
      await refreshProject();
      await render();
    } finally {
      upload.disabled = false;
      upload.textContent = 'Read this plan';
    }
  }) }, 'Read this plan');

  panel.append(el('div', { class: 'actions' }, file, notes, upload));

  if (fp?.error) panel.append(el('div', { class: 'callout' }, fp.error));

  if (fp?.proposals?.length) {
    panel.append(
      el('h3', {}, `Model reading of ${fp.filename}`),
      el('div', { class: 'callout info' },
        `Legibility: ${fp.legibility}. ${fp.legibility_note || ''} Estimated ${fp.estimated_camera_count} cameras and ${fp.estimated_door_count} doors - a guess, not a count.`),
      el('p', { class: 'muted small' }, fp.plan_description));

    for (const proposal of fp.proposals) {
      const detail = el('textarea', {}, proposal.detail);
      panel.append(el('div', { class: `proposal ${proposal.status}` },
        el('div', {},
          el('strong', {}, proposal.summary), ' ',
          el('span', { class: 'badge' }, proposal.kind.replace(/_/g, ' ')), ' ',
          el('span', { class: `badge ${proposal.confidence === 'high' ? 'ok' : 'warn'}` }, `${proposal.confidence} confidence`), ' ',
          el('span', { class: `badge ${proposal.status === 'proposed' ? 'warn' : 'accent'}` }, proposal.status)),
        el('div', { class: 'meta' }, `${proposal.location_hint}${proposal.suggested_sku ? ` - suggests ${proposal.quantity} x ${proposal.suggested_sku}` : ''}`),
        el('div', { class: 'meta' }, `Why: ${proposal.why}`),
        detail,
        el('div', { class: 'tagrow' },
          el('button', { class: 'small primary', onclick: () => decide(proposal, 'accepted', detail.value) }, 'Accept'),
          el('button', { class: 'small', onclick: () => decide(proposal, 'edited', detail.value) }, 'Save my correction'),
          el('button', { class: 'small danger', onclick: () => decide(proposal, 'rejected', detail.value) }, 'This is wrong - reject'))));
    }
  }

  async function decide(proposal, status, detail) {
    await guard(async () => {
      await api('POST', `/api/projects/${state.projectId}/floorplan/proposals/${proposal.id}`, { status, detail });
      await refreshProject();
      await render();
    });
  }

  return panel;
}

/* ---------------------------------------------- stage 3 - equipment tree */

async function viewEquipment() {
  if (!state.catalogue) state.catalogue = (await api('GET', '/api/catalogue')).tree;
  const equipment = await api('GET', `/api/projects/${state.projectId}/equipment`);

  const panels = [];

  const tree = el('div', { class: 'tree' },
    state.catalogue.map((category) =>
      el('details', {},
        el('summary', {}, category.label),
        category.subtypes.map((subtype) =>
          el('details', {},
            el('summary', {}, subtype.label),
            subtype.skus.map((sku) => {
              const qty = el('input', { type: 'number', value: '1', min: '1' });
              return el('div', { class: 'sku-row' },
                el('span', { class: 'name' },
                  el('strong', {}, sku.sku), ` ${sku.name}`,
                  el('span', { class: 'desc' }, `${sku.description} - ${sku.question_count} questions unlock on selection`)),
                qty,
                el('button', { class: 'small primary', onclick: () => guard(async () => {
                  const res = await api('POST', `/api/projects/${state.projectId}/lines`, { sku: sku.sku, quantity: Number(qty.value) });
                  state.activeLine = res.line.id;
                  await refreshProject();
                  await render();
                }) }, 'Add'));
            }))))));

  panels.push(el('div', { class: 'panel' },
    el('h2', {}, 'Stage 3 - Equipment'),
    el('p', { class: 'intro' }, 'Pick a SKU and its per-unit questions unlock. Add a second group of the same SKU when conditions differ between units - mounting, cable path or sourcing that varies should never be averaged into one line.'),
    tree));

  if (equipment.flags.length) {
    panels.push(el('div', { class: 'panel' },
      el('h3', { style: 'margin-top:0' }, 'Flags raised by the catalogue'),
      equipment.flags.map((f) =>
        el('div', { class: `callout ${f.severity === 'blocking' ? '' : 'info'}` },
          el('strong', {}, `${f.line_label} - ${f.severity}: `), f.message))));
  }

  const linesPanel = el('div', { class: 'panel' }, el('h3', { style: 'margin-top:0' }, 'Equipment groups'));
  if (!equipment.lines.length) {
    linesPanel.append(el('p', { class: 'muted' }, 'Nothing selected yet.'));
  }

  for (const line of equipment.lines) {
    const isActive = state.activeLine === line.line_id;
    const card = el('div', { class: `line-card${isActive ? ' active' : ''}` },
      el('header', {},
        el('span', { class: 'title' }, `${line.quantity} x ${line.sku} - ${line.label}`),
        el('span', { class: `badge ${line.complete ? 'ok' : 'warn'}` },
          line.complete ? 'all questions answered' : `${line.visible_count - line.answered_count} unanswered`),
        el('button', { class: 'small', onclick: () => { state.activeLine = isActive ? null : line.line_id; render(); } },
          isActive ? 'Collapse' : 'Continue questions'),
        el('button', { class: 'small danger', onclick: () => guard(async () => {
          await api('DELETE', `/api/projects/${state.projectId}/lines/${line.line_id}`);
          await refreshProject();
          await render();
        }) }, 'Remove')),
      el('div', { class: 'progressbar' },
        el('div', { style: `width:${Math.round((line.answered_count / Math.max(line.visible_count, 1)) * 100)}%` })));

    if (isActive) {
      const detail = await api('GET', `/api/projects/${state.projectId}/lines/${line.line_id}`);
      const url = `/api/projects/${state.projectId}/lines/${line.line_id}/answers`;
      card.append(
        detail.flow.current
          ? questionCard(detail.flow.current, {
              counter: `${detail.flow.current.group} - question ${detail.flow.answered_count + 1} of ${detail.flow.visible_count}`,
              onSubmit: async (value) => {
                await api('POST', url, { question_id: detail.flow.current.id, value });
                await refreshProject();
                await render();
              },
            })
          : el('div', { class: 'callout ok' }, 'Every question for this group is answered.'),
        answeredList(detail.flow.answered, { onEdit: (question) => editAnswer(question, url) }));
    }

    linesPanel.append(card);
  }

  panels.push(linesPanel);
  return panels;
}

/* --------------------------------------- stage 4 - assumptions vs confirmed */

async function viewVerification() {
  const data = await api('GET', `/api/projects/${state.projectId}/verification`);
  const panels = [];

  panels.push(el('div', { class: 'panel' },
    el('h2', {}, `Stage 4 - ${data.definition.label}`),
    el('p', { class: 'intro' }, data.definition.intro),
    data.standing.current
      ? questionCard(data.standing.current, {
          counter: `Standing question ${data.standing.answered_count + 1} of ${data.standing.visible_count}`,
          onSubmit: async (value) => {
            await api('POST', `/api/projects/${state.projectId}/answers`, { question_id: data.standing.current.id, value });
            await refreshProject();
            await render();
          },
        })
      : el('div', { class: 'callout ok' }, 'Standing questions answered.'),
    answeredList(data.standing.answered, {
      title: 'Recorded conditions',
      onEdit: (question) => editAnswer(question, `/api/projects/${state.projectId}/answers`),
    })));

  const tagPanel = el('div', { class: 'panel' },
    el('h3', { style: 'margin-top:0' }, `Item-by-item tagging - ${data.tagged} of ${data.total} done`),
    el('p', { class: 'intro' }, 'Every item gathered so far, one at a time. Nothing is tagged for you: an untagged item is printed as an open item, never as a fact.'));

  if (!data.standing.complete) {
    tagPanel.append(el('div', { class: 'callout' },
      'Answer the standing questions above first. They describe the conditions the whole scope rests on, and tagging individual items before they are recorded invites skipping them.'));
    panels.push(tagPanel);
    return panels;
  }

  if (data.next) {
    const item = data.next;
    const basisNote = el('textarea', { placeholder: data.definition.basis_help });
    const basisSelect = data.definition.basis_options?.length
      ? el('select', {}, el('option', { value: '' }, 'Select the basis...'),
          data.definition.basis_options.map((o) => el('option', { value: o.value }, o.label)))
      : null;

    tagPanel.append(el('div', { class: 'q-card' },
      el('div', { class: 'counter' }, `${item.scope} - ${item.group}`),
      el('div', { class: 'prompt' }, item.prompt),
      el('div', { class: 'help' }, `Recorded answer: ${item.display_value}`),
      el('div', { class: 'prompt', style: 'font-size:14px;margin-top:10px' }, data.definition.item_prompt),
      el('div', { class: 'options' },
        data.definition.options.map((option) =>
          el('button', { class: 'small', onclick: () => guard(async () => {
            await api('POST', `/api/projects/${state.projectId}/verification`, {
              key: item.key, status: option.value,
              basis: basisSelect?.value || null,
              basis_note: basisNote.value.trim() || null,
            });
            await refreshProject();
            await render();
          }) }, option.label + (option.requires_basis ? ' (needs a basis)' : '')))),
      el('h3', {}, data.definition.basis_prompt),
      basisSelect,
      basisNote));
  } else if (data.total === 0) {
    tagPanel.append(el('p', { class: 'muted' }, 'Nothing to tag yet - answer some equipment questions first.'));
  } else {
    tagPanel.append(el('div', { class: 'callout ok' }, 'Every item is tagged.'));
  }

  const tagged = data.items.filter((i) => i.tag.status !== 'untagged');
  if (tagged.length) {
    tagPanel.append(el('h3', {}, 'Tagged'),
      el('table', {},
        el('tr', {}, el('th', {}, 'Scope'), el('th', {}, 'Item'), el('th', {}, 'Value'), el('th', {}, 'Status'), el('th', {}, 'Basis'), el('th', {}, '')),
        tagged.map((i) =>
          el('tr', {},
            el('td', {}, i.scope),
            el('td', {}, i.prompt),
            el('td', {}, i.display_value),
            el('td', {}, el('span', { class: `badge ${['confirmed', 'observed'].includes(i.tag.status) ? 'ok' : 'warn'}` }, i.tag.status)),
            el('td', { class: 'small muted' }, i.tag.basis_note || i.tag.basis || ''),
            el('td', {}, el('button', { class: 'small', onclick: () => guard(async () => {
              await api('POST', `/api/projects/${state.projectId}/verification`, { key: i.key, status: 'unverified' });
              await refreshProject();
              await render();
            }) }, 'Re-open'))))));
  }

  panels.push(tagPanel);
  return panels;
}

/* -------------------------------------------------- review and generation */

async function viewReview() {
  const preview = await api('GET', `/api/projects/${state.projectId}/preview?acknowledge_gaps=true`);
  const state_ = preview.readiness;
  const panels = [];

  panels.push(el('div', { class: 'panel' },
    el('h2', {}, 'Review & generate'),
    el('p', { class: 'intro' }, 'Every document this tool produces is a starting draft for a person to review. What is unresolved is printed as an open item rather than quietly assumed.'),
    state_.ready
      ? el('div', { class: 'callout ok' }, 'No blocking gaps. The document can be generated.')
      : el('div', { class: 'callout' },
          el('strong', {}, `${state_.blocking_count} blocking issue(s) - resolve them, or generate an internal draft that prints them as open items.`),
          el('ul', {}, state_.problems.map((p) => el('li', {}, p.message)))),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: () => generate(false) }, 'Generate Word document'),
      state_.ready ? null : el('button', { onclick: () => generate(true) }, 'Generate internal draft with open items'),
      state.meta.api_available
        ? el('button', { onclick: () => guard(async () => {
            toast('Drafting prose...');
            await api('POST', `/api/projects/${state.projectId}/prose`, {});
            await refreshProject();
            await render();
            toast('Prose drafted. Review and edit before generating.');
          }) }, 'Draft prose with Claude')
        : el('span', { class: 'muted small' }, 'No API key configured - the document uses plain generated prose.'))));

  const prose = state.project.prose || {};
  if (Object.keys(prose).length) {
    const prosePanel = el('div', { class: 'panel' },
      el('h3', { style: 'margin-top:0' }, 'Project-specific prose'),
      el('p', { class: 'intro' }, 'Claude writes these passages from the recorded answers. Boilerplate is never sent for rewriting. Edit anything - your edit wins and is marked as yours.'));
    for (const [section, record] of Object.entries(prose)) {
      const box = el('textarea', { style: 'min-height:120px' }, record.text);
      prosePanel.append(el('div', { class: 'prose-block' },
        el('h4', {}, section.replace(/_/g, ' '),
          record.edited_by_ae ? el('span', { class: 'badge accent', style: 'margin-left:8px' }, 'edited by you') : el('span', { class: 'badge', style: 'margin-left:8px' }, `drafted by ${record.model}`)),
        box,
        el('div', { class: 'actions' },
          el('button', { class: 'small', onclick: () => guard(async () => {
            await api('PATCH', `/api/projects/${state.projectId}/prose/${section}`, { text: box.value });
            await refreshProject();
            await render();
            toast('Prose updated.');
          }) }, 'Save my wording'))));
    }
    panels.push(prosePanel);
  }

  const bomPanel = el('div', { class: 'panel' }, el('h3', { style: 'margin-top:0' }, 'Bill of materials'));
  for (const group of preview.bom.categories) {
    bomPanel.append(el('h4', {}, group.category),
      el('table', {},
        el('tr', {}, el('th', {}, 'SKU'), el('th', {}, 'Description'), el('th', {}, 'Qty'), el('th', {}, 'Unit'), el('th', {}, 'Sourcing')),
        group.lines.map((line) =>
          el('tr', {},
            el('td', {}, line.sku),
            el('td', {}, line.description),
            el('td', { class: `num${line.quantity === null ? ' unresolved' : ''}` }, line.quantity ?? 'UNRESOLVED'),
            el('td', {}, line.unit),
            el('td', { class: String(line.sourcing).startsWith('UNRESOLVED') ? 'unresolved' : '' }, line.sourcing)))));
  }
  if (!preview.bom.categories.length) bomPanel.append(el('p', { class: 'muted' }, 'No equipment selected.'));
  panels.push(bomPanel);

  const sowPanel = el('div', { class: 'panel' }, el('h3', { style: 'margin-top:0' }, 'Scope of work preview'));
  for (const section of preview.sections) {
    sowPanel.append(el('h4', {}, section.title));
    for (const block of section.blocks) {
      sowPanel.append(renderPreviewBlock(block));
    }
  }
  panels.push(sowPanel);

  if (state.project.documents.length) {
    panels.push(el('div', { class: 'panel' },
      el('h3', { style: 'margin-top:0' }, 'Generated documents'),
      state.project.documents.slice().reverse().map((d) =>
        el('div', { class: 'answered-row' },
          el('span', { class: 'p' }, new Date(d.generated_at).toLocaleString()),
          el('span', { class: 'v' }, d.filename),
          el('span', { class: `badge ${d.ready ? 'ok' : 'warn'}` }, d.ready ? 'complete' : `${d.open_item_count} open items`),
          el('a', { href: `/api/projects/${state.projectId}/documents/${d.filename}` }, 'Download')))));
  }

  async function generate(acknowledge) {
    await guard(async () => {
      const res = await api('POST', `/api/projects/${state.projectId}/document`, { acknowledge_gaps: acknowledge });
      await refreshProject();
      await render();
      toast(`Document generated: ${res.document.filename}`);
      window.location.href = res.download_url;
    });
  }

  return panels;
}

function renderPreviewBlock(block) {
  switch (block.type) {
    case 'clause':
      return el('div', { style: 'margin-bottom:10px' }, el('strong', {}, block.title), el('div', { class: 'small' }, block.text));
    case 'callout':
      return el('div', { class: 'callout' }, block.text);
    case 'note':
      return el('div', { class: 'muted small' }, block.text);
    case 'observation':
      return el('div', { style: 'margin-bottom:8px' }, el('strong', {}, block.prompt), el('div', { class: 'small' }, block.text));
    case 'definition_list':
      return el('table', {}, block.items.map((i) => el('tr', {}, el('td', {}, el('strong', {}, i.term)), el('td', {}, String(i.value ?? '')))));
    case 'work_item':
      return el('details', { style: 'margin-bottom:8px' },
        el('summary', {}, block.heading),
        el('div', { class: 'muted small' }, block.subheading),
        el('ul', {}, block.details.map((d) =>
          el('li', { class: 'small' }, `${d.prompt} `, el('strong', {}, d.value),
            d.established ? null : el('span', { class: 'badge warn', style: 'margin-left:6px' }, 'proposed, unconfirmed')))));
    case 'tagged_list':
      return el('div', {}, el('strong', {}, block.heading),
        el('ul', {}, block.items.map((i) => el('li', { class: 'small' }, `${i.scope}: ${i.text}`,
          i.basis ? el('div', { class: 'muted small' }, `Basis: ${i.basis}`) : null))));
    case 'open_item':
      return el('div', { class: 'small', style: 'color:var(--warn)' }, `• ${block.text} (${block.source})`);
    case 'assumption_flag':
      return el('div', { class: 'small' }, `• ${block.text}`);
    case 'override_table':
      return el('table', {},
        el('tr', {}, el('th', {}, 'Where'), el('th', {}, 'Item'), el('th', {}, 'Proposed'), el('th', {}, 'Changed to')),
        block.rows.map((r) => el('tr', {}, el('td', {}, r.where), el('td', {}, r.prompt), el('td', {}, r.from ?? '-'), el('td', {}, r.to))));
    default:
      return el('p', { class: 'small' }, block.text || '');
  }
}

const VIEWS = {
  projects: viewProjects,
  qualification: viewQualification,
  anchor: viewAnchor,
  floorplan: viewFloorplan,
  equipment: viewEquipment,
  verification: viewVerification,
  review: viewReview,
};

/* ------------------------------------------------------------------- boot */

document.getElementById('btn-new').addEventListener('click', () => guard(async () => {
  const { project } = await api('POST', '/api/projects');
  await openProject(project.id);
}));
document.getElementById('btn-projects').addEventListener('click', () => {
  state.project = null;
  state.projectId = null;
  document.getElementById('project-label').textContent = 'No project open';
  setView('projects');
});

(async function boot() {
  state.meta = await api('GET', '/api/meta');
  document.getElementById('api-status').textContent = state.meta.api_available
    ? `Claude drafting available (${state.meta.model})`
    : 'No API key - drafting and floor plan reading disabled';
  await render();
})();
