/**
 * Drafting passes. Claude writes the project-specific prose; boilerplate stays
 * boilerplate and is never sent for rewriting.
 */
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { getClient, MODEL } from './anthropic.js';
import { loadData, labelFor, getSkuQuestions, getSku } from './data.js';
import { taggedBuckets, lineNarratives, openItems } from './document.js';
import { flags } from './engine.js';

const ProseSchema = z.object({
  overview: z.string(),
  site_description: z.string(),
  work_included: z.string(),
  subcontractor: z.string(),
});

const SYSTEM = `You draft scopes of work for a physical security integrator. Account executives interrogate a project through a structured question bank; you turn the recorded answers into readable prose.

Hard rules:
- Write ONLY from the facts supplied. Never introduce a device, quantity, condition, material, timeline or responsibility that is not in the input.
- Every fact you are given carries a verification status. Never write an assumed or unverified item as though it were established. Where the status is assumed or unverified, either omit it from the narrative or state it with its status attached.
- Never write "site walk confirmed", "as observed" or similar unless the input says the project was site walked AND the specific item is tagged observed or confirmed.
- Do not write assumptions, exclusions, or general conditions sections. Those come from a clause library and a tagged-answer pass. If you find yourself listing assumptions, stop.
- Do not invent prices, dates or subcontractor commitments.
- Where the input is thin, write less. A short accurate paragraph beats a padded one. Never fill a gap with plausible-sounding detail.
- Plain professional English. No marketing language, no "state of the art", no "seamless". Short sentences. This is a document a project manager has to build from and a customer may hold us to.

You are producing a draft that a person will review and edit.`;

function describeItem(item) {
  const status = item.status === 'untagged' ? 'NOT VERIFIED' : item.status.toUpperCase();
  return `- [${status}] ${item.scope} / ${item.prompt}: ${item.display_value}${item.basis_note || item.basis ? ` (basis: ${item.basis_note || item.basis})` : ''}`;
}

export function buildProsePrompt(project) {
  const { manifest } = loadData();
  const buckets = taggedBuckets(project);
  const a = (id) => project.answers[id]?.value ?? null;

  const anchor = project.anchor
    ? manifest.projects.find((p) => p.id === project.anchor.project_id)
    : null;

  const lines = lineNarratives(project)
    .map((n) => {
      const details = n.details
        .map((d) => `    - ${d.prompt} ${d.value}${d.established ? '' : ' [PROPOSED, NOT CONFIRMED]'}`)
        .join('\n');
      return `  ${n.quantity} x ${n.sku} (${n.name}) - ${n.category}\n${details}`;
    })
    .join('\n');

  const anchorBlock = anchor
    ? `PRIOR PROJECT USED AS THE BASELINE
  ${anchor.client} - ${anchor.project_name} (${anchor.year}), ${anchor.site_type}, ${anchor.camera_count} cameras / ${anchor.door_count} doors, complexity ${anchor.complexity}.
  Summary: ${anchor.summary}
  What went wrong there: ${anchor.lessons}
  Why this project is similar: ${labelJoin(project.anchor.answers?.similarity_dimensions?.value)}
  Scale vs anchor: ${project.anchor.answers?.scale_delta?.value || 'not stated'}
  Stated differences: ${project.anchor.answers?.key_differences?.value || 'none recorded'}
  Problems to avoid repeating: ${project.anchor.answers?.anchor_problems?.value || 'none recorded'}
  Use the anchor for structure and tone. Write about THIS project. Do not describe the anchor's site or copy its device counts.`
    : 'PRIOR PROJECT USED AS THE BASELINE\n  None. This scope was built from scratch.';

  return `PROJECT
  Client: ${a('client_name')}
  Project: ${a('project_name')}
  Site: ${a('site_address')}
  Site type: ${a('site_type')}
  Working hours: ${a('working_hours')}
  Site access requirements: ${a('site_requirements') || 'none recorded'}
  Target dates: ${a('target_dates') || 'not stated'}

VERIFICATION PATH: ${project.path === 'walked' ? 'SITE WALKED' : 'NOT SITE WALKED - PROVISIONAL SCOPE'}
${
  project.path === 'walked'
    ? `  Walk date: ${a('site_walk_date')}; attendees: ${a('site_walk_attendees')}; coverage: ${a('site_walk_coverage')}${a('site_walk_gaps') ? `; areas not accessed: ${a('site_walk_gaps')}` : ''}`
    : `  Basis for this scope: ${labelJoin(a('info_basis'))}. Walk planned: ${a('site_walk_planned') || 'not stated'}${a('site_walk_planned_date') ? ` on ${a('site_walk_planned_date')}` : ''}.`
}

WHAT THE CUSTOMER HAS ALREADY BEEN TOLD
  ${a('info_given_customer') || 'nothing recorded'}
COMMITMENTS ALREADY MADE
  ${a('commitments_made') || 'none recorded'}

SUBCONTRACTOR
  Identified: ${a('subcontractor_identified')}
  Name: ${a('subcontractor_name') || 'n/a'}
  Scope they are assuming: ${a('subcontractor_scope') || 'n/a'}
  Quote provided: ${a('subcontractor_quote_provided') || 'n/a'}
  Figures tied to their work: ${a('subcontractor_quote_figures') || 'none - unpriced'}
  Quote expected: ${a('subcontractor_quote_eta') || 'n/a'}
  What they have been told: ${a('info_given_subcontractor') || 'nothing recorded'}

${anchorBlock}

EQUIPMENT AND THE CONDITIONS RECORDED AGAINST IT
${lines || '  none selected'}

VERIFICATION STATUS OF EVERY SCOPE ITEM
${[...buckets.observed, ...buckets.confirmed, ...buckets.assumed, ...buckets.unverified, ...buckets.untagged]
  .map(describeItem)
  .join('\n') || '  none tagged'}

FLAGS RAISED
${flags(project).map((f) => `  - [${f.severity}] ${f.line_label}: ${f.message}`).join('\n') || '  none'}

OPEN ITEMS (unresolved - do not write around these, and do not resolve them)
${openItems(project).map((o) => `  - ${o.text}`).join('\n') || '  none'}

Write four passages:
- overview: 2-4 sentences. What is being installed, where, for whom, and on what basis (walked vs provisional).
- site_description: 2-4 sentences describing the site and the conditions that affect the work. Only conditions with an established status may be stated flatly; anything assumed must be attributed as assumed.
- work_included: 1-3 paragraphs describing the work as a whole - the shape of the installation, the cabling and mounting approach, what commissioning covers. A per-device schedule is generated separately, so do not list every device.
- subcontractor: 1-2 paragraphs bounding the subcontracted work and stating the quote position plainly. If no subcontractor is identified, return an empty string.`;
}

function labelJoin(value) {
  if (!value) return 'not stated';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export async function draftProse(project) {
  const client = getClient();
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_format: betaZodOutputFormat(ProseSchema),
    messages: [{ role: 'user', content: buildProsePrompt(project) }],
  });

  if (response.stop_reason === 'refusal') {
    const err = new Error('The drafting request was declined by the model safety system.');
    err.code = 'REFUSAL';
    throw err;
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('The model did not return usable prose. Try again.');

  const now = new Date().toISOString();
  const out = {};
  for (const [section, text] of Object.entries(parsed)) {
    if (!text || !text.trim()) continue;
    out[section] = { text: text.trim(), generated_at: now, model: MODEL, edited_by_ae: false };
  }
  return out;
}
