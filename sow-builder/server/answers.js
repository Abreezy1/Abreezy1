/**
 * Answer records. Every value carries how it got there, so an AI proposal that
 * the AE never touched can never be presented as something the AE said.
 */

export const SOURCE = {
  AE: 'ae',
  AI_PROPOSAL: 'ai_proposal',
  ANCHOR: 'anchor',
};

export function makeAnswer(value, { source = SOURCE.AE, note = null, proposedBy = null } = {}) {
  return {
    value,
    source,
    note,
    proposed_by: proposedBy,
    proposed_value: source === SOURCE.AE ? null : value,
    confirmed_by_ae: source === SOURCE.AE,
    overridden: false,
    answered_at: new Date().toISOString(),
  };
}

/**
 * Records an AE answer over an existing record, keeping the original proposal
 * visible. Overrides are part of the document, not a silent mutation.
 */
export function applyAnswer(existing, value, { source = SOURCE.AE, note = null } = {}) {
  if (!existing) return makeAnswer(value, { source, note });

  const changed = JSON.stringify(existing.value) !== JSON.stringify(value);
  const wasProposal = existing.source !== SOURCE.AE;

  return {
    ...existing,
    value,
    note: note ?? existing.note,
    source,
    confirmed_by_ae: source === SOURCE.AE,
    overridden: wasProposal && changed && source === SOURCE.AE,
    previous_value: changed ? existing.value : existing.previous_value ?? null,
    answered_at: new Date().toISOString(),
  };
}

/**
 * A value only counts as established when a human put it there or explicitly
 * accepted it. An untouched AI proposal is never a fact.
 */
export function isEstablished(record) {
  return Boolean(record) && record.confirmed_by_ae === true;
}
