/**
 * Builds the document model: an ordered set of sections and blocks, ready to
 * render. Boilerplate comes from the clause library; project-specific prose
 * comes from the drafting pass; the assumptions and observed-conditions
 * sections are generated from tagged answers so nothing can be left out by
 * accident.
 */
import { evaluate } from './conditions.js';
import { loadData, getSku, labelFor, getSkuQuestions } from './data.js';
import { context, scopeItems, verificationStatus, flags, readiness, standingFlow } from './engine.js';
import { buildBom, sourcingSummary } from './bom.js';
import { COMPANY_NAME } from './config.js';

function interpolateClause(text, project) {
  const values = { company: COMPANY_NAME };
  for (const [id, record] of Object.entries(project.answers)) {
    values[id] = Array.isArray(record.value) ? record.value.join(', ') : record.value;
  }
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined || values[key] === null || values[key] === '' ? match : values[key],
  );
}

function clausesFor(project, sectionId) {
  const { clauses } = loadData();
  const ctx = {};
  for (const [id, record] of Object.entries(project.answers)) ctx[id] = record.value;
  for (const line of project.lines) {
    for (const [id, record] of Object.entries(line.answers)) {
      if (!(id in ctx)) ctx[id] = record.value;
    }
  }

  return clauses.clauses
    .filter((c) => c.section === sectionId)
    .filter((c) => c.always === true || evaluate(c.include_if, ctx))
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((c) => ({ ...c, text: interpolateClause(c.text, project) }));
}

const val = (project, id) => project.answers[id]?.value ?? null;

/* --------------------------------------------------------- scope narrative */

/**
 * Deterministic per-line scope description built from the answers themselves.
 * The drafting pass rewrites this into prose; without an API key this is what
 * the document carries, and it is complete either way.
 */
export function lineNarratives(project) {
  return project.lines.map((line) => {
    const sku = getSku(line.sku);
    const questions = getSkuQuestions(line.sku);
    const details = [];

    for (const question of questions) {
      const record = line.answers[question.id];
      if (!record || record.value === '' || record.value === null || record.value === undefined) continue;
      if (Array.isArray(record.value) && record.value.length === 0) continue;
      details.push({
        prompt: question.prompt,
        question_id: question.id,
        value: labelFor(question, record.value),
        established: record.confirmed_by_ae === true,
        overridden: record.overridden === true,
        previous_value: record.previous_value ?? null,
        source: record.source,
      });
    }

    return {
      line_id: line.id,
      label: line.label || `${sku.sku} x${line.quantity}`,
      sku: sku.sku,
      name: sku.name,
      quantity: line.quantity,
      category: `${sku.category_label} - ${sku.subtype_label}`,
      details,
    };
  });
}

/* ---------------------------------------------- assumptions / observations */

const STATUS_LABEL = {
  confirmed: 'Confirmed',
  observed: 'Observed on site walk',
  assumed: 'Assumed',
  unverified: 'Open - not verified',
  untagged: 'NOT VERIFIED - never tagged',
};

export function taggedBuckets(project) {
  const items = scopeItems(project);
  const buckets = { confirmed: [], observed: [], assumed: [], unverified: [], untagged: [] };

  for (const item of items) {
    const tag = verificationStatus(project, item);
    const entry = {
      ...item,
      status: tag.status,
      status_label: STATUS_LABEL[tag.status] || tag.status,
      basis: tag.basis || null,
      basis_note: tag.basis_note || null,
    };
    (buckets[tag.status] || buckets.untagged).push(entry);
  }
  return buckets;
}

function standingAnswers(project) {
  const { verification } = loadData();
  const path = project.path || 'not_walked';
  const questions = verification.standing_questions[path] || [];
  return questions
    .map((question) => ({ question, record: project.answers[question.id] }))
    .filter(({ record }) => record && record.value !== '' && record.value !== null && record.value !== undefined)
    .map(({ question, record }) => ({
      prompt: question.prompt,
      value: labelFor(question, record.value),
    }));
}

/* ------------------------------------------------------------ open items */

export function openItems(project) {
  const out = [];
  const buckets = taggedBuckets(project);

  for (const item of [...buckets.untagged, ...buckets.unverified]) {
    out.push({
      source: 'scope item',
      text: `${item.scope} - ${item.prompt} (recorded as "${item.display_value}") is ${item.status === 'untagged' ? 'not verified and was never tagged' : 'unverified'}.`,
    });
  }

  for (const flag of flags(project)) {
    if (flag.severity === 'blocking' || flag.severity === 'review') {
      out.push({ source: `flag: ${flag.flag_id}`, text: `${flag.line_label}: ${flag.message}` });
    }
  }

  const bom = buildBom(project);
  for (const item of bom.unresolved) {
    out.push({ source: 'bill of materials', text: `${item.line_label} / ${item.sku}: ${item.reason}` });
  }

  if (val(project, 'subcontractor_identified') === 'yes' && val(project, 'subcontractor_quote_provided') === 'no') {
    out.push({
      source: 'subcontractor',
      text: `Subcontractor quote outstanding. Expected: ${val(project, 'subcontractor_quote_eta') || 'not stated'}. The subcontracted portion of this scope is unpriced.`,
    });
  }
  if (val(project, 'subcontractor_identified') === 'no') {
    out.push({ source: 'subcontractor', text: 'No subcontractor identified for work expected to be subcontracted.' });
  }

  const standing = standingFlow(project);
  if (!standing.complete && standing.current) {
    out.push({ source: 'verification pass', text: `Unanswered: ${standing.current.prompt}` });
  }

  return out;
}

/* ---------------------------------------------------------- overrides log */

export function overrideLog(project) {
  const entries = [];
  for (const narrative of lineNarratives(project)) {
    for (const detail of narrative.details) {
      if (detail.overridden) {
        entries.push({
          where: narrative.label,
          prompt: detail.prompt,
          from: Array.isArray(detail.previous_value) ? detail.previous_value.join(', ') : detail.previous_value,
          to: detail.value,
        });
      }
    }
  }
  for (const proposal of project.floorplan?.proposals || []) {
    if (proposal.status === 'rejected' || proposal.status === 'edited') {
      entries.push({
        where: 'Floor plan reading',
        prompt: proposal.summary,
        from: proposal.original_detail ?? proposal.detail,
        to: proposal.status === 'rejected' ? 'REJECTED by account executive' : proposal.detail,
      });
    }
  }
  return entries;
}

/* --------------------------------------------------------- document model */

export function buildDocument(project, { acknowledgedGaps = false } = {}) {
  const walked = project.path === 'walked';
  const bom = buildBom(project);
  const buckets = taggedBuckets(project);
  const prose = project.prose || {};
  const state = readiness(project);

  const sections = [];

  sections.push({
    id: 'overview',
    title: '1. Project Overview',
    blocks: [
      ...(prose.overview ? [{ type: 'paragraph', text: prose.overview.text, generated: true }] : []),
      ...(prose.overview ? [] : [{ type: 'paragraph', text: fallbackOverview(project, bom) }]),
      ...clausesFor(project, 'overview').map((c) => ({ type: 'clause', title: c.title, text: c.text })),
    ],
  });

  sections.push({
    id: 'site_description',
    title: '2. Site Description',
    blocks: [
      prose.site_description
        ? { type: 'paragraph', text: prose.site_description.text, generated: true }
        : { type: 'paragraph', text: fallbackSiteDescription(project) },
      ...(project.anchor
        ? [{
            type: 'note',
            text: `Scoped against a prior engagement: ${anchorLabel(project)}. Differences from that project are reflected throughout this document.`,
          }]
        : []),
    ],
  });

  sections.push({
    id: 'work_included',
    title: '3. Work Included',
    blocks: [
      prose.work_included
        ? { type: 'paragraph', text: prose.work_included.text, generated: true }
        : { type: 'paragraph', text: fallbackWorkIncluded(project) },
      ...lineNarratives(project).map((n) => ({
        type: 'work_item',
        heading: `${n.quantity} x ${n.sku} - ${n.name}`,
        subheading: n.category,
        details: n.details,
      })),
      ...clausesFor(project, 'work_included').map((c) => ({ type: 'clause', title: c.title, text: c.text })),
    ],
  });

  sections.push({
    id: 'subcontractor',
    title: '4. Subcontracted Work',
    blocks: [
      ...(val(project, 'subcontractor_identified') === 'yes'
        ? [
            { type: 'paragraph', text: prose.subcontractor?.text || fallbackSubcontractor(project), generated: Boolean(prose.subcontractor) },
            {
              type: 'definition_list',
              items: [
                { term: 'Subcontractor', value: val(project, 'subcontractor_name') || 'Not stated' },
                { term: 'Scope assumed by subcontractor', value: val(project, 'subcontractor_scope') || 'Not stated' },
                { term: 'Quote status', value: val(project, 'subcontractor_quote_provided') === 'yes' ? 'Quote received' : 'QUOTE OUTSTANDING' },
                ...(val(project, 'subcontractor_quote_provided') === 'yes'
                  ? [
                      { term: 'Figures tied to their work', value: val(project, 'subcontractor_quote_figures') || 'Not stated' },
                      { term: 'Quote date / validity', value: val(project, 'subcontractor_quote_date') || 'Not stated' },
                      { term: 'Basis of their quote', value: labelForQualification('subcontractor_quote_basis', val(project, 'subcontractor_quote_basis')) },
                    ]
                  : [
                      { term: 'Quote expected', value: val(project, 'subcontractor_quote_eta') || 'Not stated' },
                      { term: 'Placeholder carried', value: val(project, 'subcontractor_pricing_placeholder') || 'None' },
                    ]),
                { term: 'Information already given to the subcontractor', value: val(project, 'info_given_subcontractor') || 'None recorded' },
              ],
            },
          ]
        : []),
      ...clausesFor(project, 'subcontractor').map((c) => ({ type: 'clause', title: c.title, text: c.text })),
    ],
  });

  if (walked) {
    sections.push({
      id: 'conditions',
      title: '5. Observed Site Conditions',
      blocks: [
        {
          type: 'paragraph',
          text: `The following conditions were observed during the site walk on ${val(project, 'site_walk_date') || 'the recorded date'}, attended by ${val(project, 'site_walk_attendees') || 'the recorded attendees'}. Items not observed during the walk are listed in Section 6 as assumptions.`,
        },
        ...standingAnswers(project).map((a) => ({ type: 'observation', prompt: a.prompt, text: a.value })),
        ...(buckets.observed.length
          ? [{
              type: 'tagged_list',
              heading: 'Observed during the walk',
              items: buckets.observed.map((i) => ({
                scope: i.scope,
                text: `${i.prompt} - ${i.display_value}`,
                basis: i.basis_note || i.basis,
              })),
            }]
          : []),
        ...(buckets.confirmed.length
          ? [{
              type: 'tagged_list',
              heading: 'Confirmed by other means',
              items: buckets.confirmed.map((i) => ({
                scope: i.scope,
                text: `${i.prompt} - ${i.display_value}`,
                basis: i.basis_note || i.basis,
              })),
            }]
          : []),
      ],
    });
  } else {
    sections.push({
      id: 'conditions',
      title: '5. Basis of Scope',
      blocks: [
        {
          type: 'callout',
          text: 'NO SITE WALK HAS BEEN PERFORMED. The conditions described in this document have not been physically verified. This scope is provisional.',
        },
        {
          type: 'definition_list',
          items: [
            { term: 'Scope prepared from', value: labelForQualification('info_basis', val(project, 'info_basis')) },
            { term: 'Site walk planned', value: labelForQualification('site_walk_planned', val(project, 'site_walk_planned')) },
            ...(val(project, 'site_walk_planned') === 'scheduled'
              ? [{ term: 'Scheduled for', value: val(project, 'site_walk_planned_date') || 'Not stated' }]
              : []),
          ],
        },
        ...standingAnswers(project).map((a) => ({ type: 'observation', prompt: a.prompt, text: a.value })),
        ...(buckets.confirmed.length
          ? [{
              type: 'tagged_list',
              heading: 'Items confirmed without a site walk',
              items: buckets.confirmed.map((i) => ({
                scope: i.scope,
                text: `${i.prompt} - ${i.display_value}`,
                basis: i.basis_note || i.basis,
              })),
            }]
          : []),
      ],
    });
  }

  sections.push({
    id: 'assumptions',
    title: '6. Assumptions',
    blocks: [
      {
        type: 'paragraph',
        text: walked
          ? 'The following were not observed during the site walk and are carried as assumptions. Where actual conditions differ, the affected work will be repriced.'
          : 'This scope has not been verified on site. The following are carried as assumptions. Where actual conditions differ, the affected work will be repriced.',
      },
      ...(buckets.assumed.length
        ? [{
            type: 'tagged_list',
            heading: 'Assumed',
            items: buckets.assumed.map((i) => ({ scope: i.scope, text: `${i.prompt} - ${i.display_value}` })),
          }]
        : [{ type: 'paragraph', text: 'No individual scope item was tagged as assumed.' }]),
      ...flags(project)
        .filter((f) => f.severity === 'assumption')
        .map((f) => ({ type: 'assumption_flag', text: `${f.line_label}: ${f.message}` })),
      ...clausesFor(project, 'assumptions').map((c) => ({ type: 'clause', title: c.title, text: c.text })),
    ],
  });

  const open = openItems(project);
  sections.push({
    id: 'open_items',
    title: '7. Open Items',
    blocks: [
      {
        type: 'paragraph',
        text: open.length
          ? 'The following are unresolved at the time of writing. They are not priced, not assumed and not excluded - they are open, and each must be closed before this scope is issued as a firm price.'
          : 'No open items. Every scope item gathered has been tagged and every dependent quantity resolved.',
      },
      ...open.map((item) => ({ type: 'open_item', text: item.text, source: item.source })),
      ...(acknowledgedGaps && !state.ready
        ? [{
            type: 'callout',
            text: 'This document was generated with known gaps outstanding. It is an internal working draft and must not be issued to the customer in this state.',
          }]
        : []),
    ],
  });

  sections.push({
    id: 'exclusions',
    title: '8. Exclusions',
    blocks: clausesFor(project, 'exclusions').map((c) => ({ type: 'clause', title: c.title, text: c.text })),
  });

  sections.push({
    id: 'general',
    title: '9. General Conditions',
    blocks: clausesFor(project, 'general').map((c) => ({ type: 'clause', title: c.title, text: c.text })),
  });

  const overrides = overrideLog(project);
  if (overrides.length) {
    sections.push({
      id: 'overrides',
      title: 'Appendix A - Overrides to Model-Proposed Values',
      blocks: [
        { type: 'paragraph', text: 'The following values were proposed automatically and changed or rejected by the account executive. Recorded so the reviewer can see what the tool suggested and what a person decided.' },
        { type: 'override_table', rows: overrides },
      ],
    });
  }

  return {
    meta: {
      client: val(project, 'client_name') || 'Client',
      project_name: val(project, 'project_name') || 'Untitled project',
      site_address: val(project, 'site_address') || '',
      site_type: labelForQualification('site_type', val(project, 'site_type')),
      path: project.path,
      walked,
      company: COMPANY_NAME,
      generated_at: new Date().toISOString(),
      ready: state.ready,
      draft: true,
      anchor: project.anchor ? anchorLabel(project) : null,
    },
    bom,
    sourcing_summary: sourcingSummary(bom),
    sections,
    readiness: state,
  };
}

function labelForQualification(questionId, value) {
  const { qualification } = loadData();
  const question = qualification.questions.find((q) => q.id === questionId);
  if (!value) return 'Not stated';
  return labelFor(question, value);
}

function anchorLabel(project) {
  const { manifest } = loadData();
  const match = manifest.projects.find((p) => p.id === project.anchor?.project_id);
  return match ? `${match.client} - ${match.project_name} (${match.year})` : project.anchor?.project_id;
}

/* --------------------------------------------------- deterministic fallbacks
 * Used when no drafting pass has run. The document is complete without the
 * API - the prose is just plainer.
 */

function deviceSummary(project) {
  const counts = new Map();
  for (const line of project.lines) {
    counts.set(line.sku, (counts.get(line.sku) || 0) + line.quantity);
  }
  return [...counts.entries()].map(([sku, qty]) => `${qty} x ${sku}`).join(', ');
}

function sentenceCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fallbackOverview(project, bom) {
  const walked = project.path === 'walked';
  return [
    `${sentenceCase(COMPANY_NAME)} will furnish and install physical security equipment at ${val(project, 'site_address') || 'the site'} for ${val(project, 'client_name') || 'the client'}.`,
    `The installation comprises ${deviceSummary(project) || 'no devices selected'} across ${bom.categories.length} material categories.`,
    walked
      ? 'This scope is based on conditions observed during a site walk.'
      : 'This scope has been prepared without a site walk and is provisional.',
  ].join(' ');
}

function fallbackSiteDescription(project) {
  return [
    `The site is a ${labelForQualification('site_type', val(project, 'site_type')).toLowerCase()} facility located at ${val(project, 'site_address') || 'the address on record'}.`,
    val(project, 'site_requirements') ? `Site access requirements: ${val(project, 'site_requirements')}.` : '',
    `Work is to be performed during ${labelForQualification('working_hours', val(project, 'working_hours')).toLowerCase()}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

function fallbackWorkIncluded(project) {
  return `The work described below covers the supply, installation, termination, testing and commissioning of the devices listed in the bill of materials, together with the mounting hardware, cabling and pathway work identified for each. Each item below carries the conditions recorded for it during scoping.`;
}

function fallbackSubcontractor(project) {
  return `Portions of this work are subcontracted to ${val(project, 'subcontractor_name') || 'a subcontractor'}. Their scope is bounded as set out below; all work not listed as theirs remains ours.`;
}
