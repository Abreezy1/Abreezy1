import { app } from '../server/index.js';

let server;
let base;

export async function startServer() {
  if (server) return base;
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

export async function stopServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  base = null;
}

export async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/** Answers the current question of a flow endpoint until it is complete. */
export async function answerAll(flowUrl, answerUrl, pick, { max = 200 } = {}) {
  for (let i = 0; i < max; i += 1) {
    const { body: flow } = await api('GET', flowUrl);
    const current = flow.current || flow.flow?.current || flow.standing?.current;
    if (!current) return flow;
    const value = pick(current);
    const res = await api('POST', answerUrl, { question_id: current.id, value });
    if (res.status !== 200) {
      throw new Error(`Answering "${current.id}" failed: ${JSON.stringify(res.body)}`);
    }
  }
  throw new Error(`Flow ${flowUrl} did not complete within ${max} answers`);
}

/** A plausible answer for any question type, driven by the question definition. */
export function autoAnswer(question, overrides = {}) {
  if (question.id in overrides) return overrides[question.id];
  switch (question.type) {
    case 'select':
      return question.options[0].value;
    case 'multiselect':
      return [question.options[0].value];
    case 'number':
      return question.min !== undefined ? question.min + 1 : 10;
    case 'date':
      return '2026-08-01';
    case 'longtext':
    case 'text':
    default:
      return `Recorded answer for ${question.id}`;
  }
}
