/**
 * Floor plan intake. Everything the model returns here is a proposal the AE
 * corrects - it is never treated as truth, and anything not explicitly accepted
 * stays flagged as unverified and flows into the assumptions block.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { getClient, MODEL } from './anthropic.js';
import { loadData } from './data.js';

const ProposalSchema = z.object({
  kind: z.enum(['camera_placement', 'door', 'coverage_gap', 'mounting_surface', 'cable_path', 'note']),
  summary: z.string(),
  detail: z.string(),
  location_hint: z.string(),
  suggested_sku: z.string(),
  quantity: z.number(),
  confidence: z.enum(['low', 'medium', 'high']),
  why: z.string(),
});

const ReadingSchema = z.object({
  plan_description: z.string(),
  legibility: z.enum(['clear', 'partial', 'poor']),
  legibility_note: z.string(),
  estimated_camera_count: z.number(),
  estimated_door_count: z.number(),
  proposals: z.array(ProposalSchema),
});

const SYSTEM = `You are reading a floor plan for a physical security integrator's account executive. You produce a FIRST GUESS that a human corrects. You are not producing a design.

Rules:
- Say what you can actually see. If the plan is low resolution, unlabelled, or partially cut off, say so in legibility_note and lower your confidence. A short honest reading beats a confident invented one.
- Never state a dimension, ceiling height, wall construction or door type that is not printed on the plan. If you are inferring it from the drawing's shape, say "inferred" in the why field and set confidence low.
- Propose placements as proposals, not decisions. Each one needs a location_hint a person can find on the plan ("northeast corner of the warehouse floor, near the dock doors").
- Flag coverage gaps you can see - unwatched entrances, blind corridors, exterior doors with no camera near them.
- Use only SKUs from the supplied catalogue list. If nothing fits, use an empty string for suggested_sku.
- quantity is per proposal; use 1 unless the plan clearly shows a repeated identical condition.
- Do not propose more than 40 items. Group repeated conditions.`;

function catalogueSummary() {
  const { catalogue } = loadData();
  const lines = [];
  for (const category of catalogue.categories) {
    for (const subtype of category.subtypes) {
      for (const sku of subtype.skus) {
        lines.push(`  ${sku.sku} - ${sku.name} (${category.label} / ${subtype.label}): ${sku.description}`);
      }
    }
  }
  return lines.join('\n');
}

const SUPPORTED_MEDIA = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export async function readFloorPlan({ base64, mediaType, project, notes }) {
  if (!SUPPORTED_MEDIA.includes(mediaType)) {
    const err = new Error(`Unsupported image type "${mediaType}". Supply PNG, JPEG, GIF or WebP - export a PDF page to an image first.`);
    err.code = 'BAD_MEDIA';
    throw err;
  }

  const client = getClient();
  const a = (id) => project.answers[id]?.value ?? 'not stated';

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_format: betaZodOutputFormat(ReadingSchema),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `Read this floor plan for a security installation.

PROJECT CONTEXT
  Client: ${a('client_name')}
  Site type: ${a('site_type')}
  Site: ${a('site_address')}
  Site walked: ${project.path === 'walked' ? 'yes' : 'NO - nothing on this plan can be verified against reality'}
  AE notes on the plan: ${notes || 'none'}

AVAILABLE CATALOGUE
${catalogueSummary()}

Return your reading. Everything you propose will be shown to the account executive as an editable proposal with a reject option.`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    const err = new Error('The floor plan request was declined by the model safety system.');
    err.code = 'REFUSAL';
    throw err;
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('The model did not return a usable reading of this plan.');

  return {
    plan_description: parsed.plan_description,
    legibility: parsed.legibility,
    legibility_note: parsed.legibility_note,
    estimated_camera_count: parsed.estimated_camera_count,
    estimated_door_count: parsed.estimated_door_count,
    model: MODEL,
    read_at: new Date().toISOString(),
    proposals: parsed.proposals.map((proposal) => ({
      id: crypto.randomUUID(),
      ...proposal,
      original_detail: proposal.detail,
      status: 'proposed', // proposed | accepted | edited | rejected - never truth until a person says so
      decided_at: null,
    })),
  };
}
