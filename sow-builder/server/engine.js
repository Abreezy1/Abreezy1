/**
 * The interrogation engine.
 *
 * Everything it asks comes from the data files; this module only decides what
 * is visible, what is still missing, and what is safe to state as fact.
 */
import { evaluate, hasValue } from './conditions.js';
import { loadData, getSku, getSkuQuestions, labelFor } from './data.js';
import { isEstablished } from './answers.js';

export const STAGES = ['qualification', 'anchor', 'floorplan', 'equipment', 'verification', 'review'];

/* ------------------------------------------------------------------ context */

/** Values visible to show_if conditions - includes AI proposals so the flow moves. */
export function context(project, line = null) {
  const ctx = {};
  for (const [id, record] of Object.entries(project.answers)) ctx[id] = record.value;
  if (project.anchor?.answers) {
    for (const [id, record] of Object.entries(project.anchor.answers)) ctx[id] = record.value;
  }
  if (line) {
    for (const [id, record] of Object.entries(line.answers)) ctx[id] = record.value;
    ctx._sku = line.sku;
    ctx._quantity = line.quantity;
  }
  return ctx;
}

/** Values a document is allowed to state as fact - AE-established only. */
export function establishedContext(project, line = null) {
  const ctx = {};
  const take = (answers) => {
    for (const [id, record] of Object.entries(answers || {})) {
      if (isEstablished(record)) ctx[id] = record.value;
    }
  };
  take(project.answers);
  take(project.anchor?.answers);
  if (line) take(line.answers);
  return ctx;
}

/* ---------------------------------------------------------------- questions */

export function visibleQuestions(questions, ctx) {
  return questions.filter((q) => evaluate(q.show_if, ctx));
}

function answerOf(scope, id) {
  return scope.answers?.[id];
}

function isAnswered(scope, question) {
  const record = answerOf(scope, question.id);
  if (!record) return false;
  if (question.required === false) return true;
  return hasValue(record.value);
}

/**
 * Progressive disclosure: the next thing to ask, plus everything already
 * answered so the AE can go back and change it. Never the whole tree at once.
 */
export function questionFlow(questions, scope, ctx) {
  const visible = visibleQuestions(questions, ctx);
  const answered = [];
  let current = null;

  for (const question of visible) {
    if (isAnswered(scope, question)) {
      answered.push({ question, record: answerOf(scope, question.id) });
    } else if (!current) {
      current = question;
    }
  }

  return {
    answered,
    current,
    visible_count: visible.length,
    answered_count: answered.length,
    complete: current === null,
  };
}

/* -------------------------------------------------------------- stage flows */

export function qualificationFlow(project) {
  const { qualification } = loadData();
  return questionFlow(qualification.questions, project, context(project));
}

export function anchorFlow(project) {
  const { anchor } = loadData();
  if (!project.anchor?.project_id) {
    return { answered: [], current: null, visible_count: 0, answered_count: 0, complete: false, needs_anchor: true };
  }
  const scope = { answers: project.anchor.answers || {} };
  const ctx = context(project);
  return { ...questionFlow(anchor.similarity_questions, scope, ctx), needs_anchor: false };
}

export function lineFlow(project, line) {
  const questions = getSkuQuestions(line.sku);
  return questionFlow(questions, line, context(project, line));
}

export function equipmentFlow(project) {
  const lines = project.lines.map((line) => {
    const flow = lineFlow(project, line);
    return {
      line_id: line.id,
      sku: line.sku,
      label: line.label,
      quantity: line.quantity,
      answered_count: flow.answered_count,
      visible_count: flow.visible_count,
      complete: flow.complete,
      next_question_id: flow.current?.id || null,
    };
  });

  return {
    lines,
    complete: lines.length > 0 && lines.every((l) => l.complete),
    incomplete_lines: lines.filter((l) => !l.complete).map((l) => l.line_id),
  };
}

export function standingFlow(project) {
  const { verification } = loadData();
  const path = project.path || 'not_walked';
  const questions = verification.standing_questions[path] || [];
  return questionFlow(questions, project, context(project));
}

/* --------------------------------------------------- taggable scope items */

/**
 * Everything gathered so far that has to be individually tagged confirmed /
 * assumed (or observed, on the walked path). This is the input to Stage 4 and
 * the only source of the assumptions and observed-conditions sections.
 */
export function scopeItems(project) {
  const { qualification } = loadData();
  const items = [];

  const ctxProject = context(project);
  for (const question of visibleQuestions(qualification.questions, ctxProject)) {
    if (question.taggable !== true) continue;
    const record = project.answers[question.id];
    if (!record || !hasValue(record.value)) continue;
    items.push({
      key: `project:${question.id}`,
      scope: 'Project',
      group: 'Qualification',
      question_id: question.id,
      prompt: question.prompt,
      value: record.value,
      display_value: labelFor(question, record.value),
      source: record.source,
      established: isEstablished(record),
    });
  }

  for (const line of project.lines) {
    const questions = getSkuQuestions(line.sku);
    const ctx = context(project, line);
    for (const question of visibleQuestions(questions, ctx)) {
      if (question.taggable === false) continue;
      const record = line.answers[question.id];
      if (!record || !hasValue(record.value)) continue;
      items.push({
        key: `line:${line.id}:${question.id}`,
        scope: line.label || `${line.sku} x${line.quantity}`,
        group: question.group,
        line_id: line.id,
        sku: line.sku,
        question_id: question.id,
        prompt: question.prompt,
        value: record.value,
        display_value: labelFor(question, record.value),
        source: record.source,
        established: isEstablished(record),
      });
    }
  }

  if (project.floorplan?.proposals?.length) {
    for (const proposal of project.floorplan.proposals) {
      if (proposal.status === 'rejected') continue;
      items.push({
        key: `floorplan:${proposal.id}`,
        scope: 'Floor plan',
        group: 'Floor plan reading',
        prompt: proposal.summary,
        value: proposal.detail,
        display_value: proposal.detail,
        source: proposal.status === 'accepted' ? 'ae' : 'ai_proposal',
        established: proposal.status === 'accepted',
      });
    }
  }

  return items;
}

export function verificationStatus(project, item) {
  const tag = project.verification[item.key];
  if (tag) return tag;
  // Untagged is never "confirmed". It is an open item.
  return { status: 'untagged', basis: null, basis_note: null };
}

export function verificationFlow(project) {
  const items = scopeItems(project);
  const tagged = items.filter((i) => project.verification[i.key]);
  const untagged = items.filter((i) => !project.verification[i.key]);
  return {
    path: project.path,
    total: items.length,
    tagged: tagged.length,
    untagged: untagged.length,
    next: untagged[0] || null,
    items: items.map((i) => ({ ...i, tag: verificationStatus(project, i) })),
    complete: items.length > 0 && untagged.length === 0,
  };
}

/* ------------------------------------------------------------------- flags */

/** Catalogue-defined flags, evaluated per line. */
export function flags(project) {
  const { catalogue } = loadData();
  const out = [];
  for (const line of project.lines) {
    const ctx = context(project, line);
    for (const flag of catalogue.flags || []) {
      let hit;
      try {
        hit = evaluate(flag.when, ctx);
      } catch {
        hit = false;
      }
      if (hit) {
        out.push({
          id: `${line.id}:${flag.id}`,
          flag_id: flag.id,
          severity: flag.severity,
          message: flag.message,
          line_id: line.id,
          line_label: line.label || `${line.sku} x${line.quantity}`,
        });
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- readiness */

/**
 * What still stands between this project and a document that can be defended.
 * Nothing here is silently resolved - the caller either fixes it or explicitly
 * acknowledges it, and acknowledged gaps are printed in the document.
 */
export function readiness(project) {
  const problems = [];

  const qual = qualificationFlow(project);
  if (!qual.complete) {
    problems.push({
      kind: 'unanswered',
      severity: 'blocking',
      stage: 'qualification',
      message: `Qualification gate incomplete - next unanswered: "${qual.current?.prompt}"`,
    });
  }

  if (project.lines.length === 0) {
    problems.push({
      kind: 'empty',
      severity: 'blocking',
      stage: 'equipment',
      message: 'No equipment selected. A scope with no devices cannot produce a bill of materials.',
    });
  }

  for (const line of project.lines) {
    const flow = lineFlow(project, line);
    if (!flow.complete) {
      problems.push({
        kind: 'unanswered',
        severity: 'blocking',
        stage: 'equipment',
        line_id: line.id,
        message: `${line.label || line.sku}: unanswered - "${flow.current.prompt}"`,
      });
    }
  }

  const standing = standingFlow(project);
  if (!standing.complete && standing.current) {
    problems.push({
      kind: 'unanswered',
      severity: 'blocking',
      stage: 'verification',
      message: `${project.path === 'walked' ? 'Observed conditions' : 'Assumptions'} pass incomplete - next unanswered: "${standing.current.prompt}"`,
    });
  }

  const verification = verificationFlow(project);
  if (verification.untagged > 0) {
    problems.push({
      kind: 'untagged',
      severity: 'blocking',
      stage: 'verification',
      message: `${verification.untagged} of ${verification.total} scope items are not tagged ${project.path === 'walked' ? 'observed or assumed' : 'confirmed or assumed'}. Untagged items cannot be stated as fact.`,
    });
  }

  for (const flag of flags(project)) {
    if (flag.severity === 'blocking') {
      problems.push({
        kind: 'flag',
        severity: 'blocking',
        stage: 'equipment',
        line_id: flag.line_id,
        message: `${flag.line_label}: ${flag.message}`,
      });
    }
  }

  const unconfirmedProposals = [];
  for (const line of project.lines) {
    for (const [id, record] of Object.entries(line.answers)) {
      if (!isEstablished(record)) unconfirmedProposals.push(`${line.label || line.sku} / ${id}`);
    }
  }
  if (unconfirmedProposals.length) {
    problems.push({
      kind: 'unconfirmed_proposal',
      severity: 'blocking',
      stage: 'equipment',
      message: `${unconfirmedProposals.length} value(s) proposed by the model have not been accepted or corrected by a person: ${unconfirmedProposals.slice(0, 5).join('; ')}${unconfirmedProposals.length > 5 ? ' ...' : ''}`,
    });
  }

  return {
    ready: problems.filter((p) => p.severity === 'blocking').length === 0,
    problems,
    blocking_count: problems.filter((p) => p.severity === 'blocking').length,
  };
}

/** Overall progress for the UI rail. */
export function progress(project) {
  const equipment = equipmentFlow(project);
  const verification = verificationFlow(project);
  return {
    stage: project.stage,
    path: project.path,
    qualification: qualificationFlow(project),
    anchor: project.anchor ? anchorFlow(project) : null,
    equipment,
    standing: standingFlow(project),
    verification: { total: verification.total, tagged: verification.tagged, untagged: verification.untagged, complete: verification.complete },
    flags: flags(project),
    readiness: readiness(project),
  };
}
