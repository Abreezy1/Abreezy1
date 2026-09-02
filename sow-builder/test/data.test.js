import test from 'node:test';
import assert from 'node:assert/strict';
import { loadData, getSkuQuestions, catalogueTree, labelFor } from '../server/data.js';
import { evaluate } from '../server/conditions.js';

/** Field ids referenced anywhere in a condition tree. */
function fieldsIn(condition) {
  return (JSON.stringify(condition ?? {}).match(/"field":"(\w+)"/g) || []).map((f) => f.split('"')[3]);
}

test('every data file loads and indexes', () => {
  const data = loadData({ reload: true });
  assert.ok(data.skuIndex.size > 0);
  assert.ok(data.manifest.projects.length > 0);
  assert.ok(data.clauses.clauses.length > 0);
});

test('every SKU resolves its question sets without duplicate ids', () => {
  const { skuIndex } = loadData();
  for (const skuId of skuIndex.keys()) {
    const questions = getSkuQuestions(skuId);
    assert.ok(questions.length > 0, `${skuId} has no questions`);
    const ids = questions.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, `${skuId} has duplicate question ids`);
  }
});

test('every question defines a usable type and options where required', () => {
  const { skuIndex, qualification, anchor, verification } = loadData();
  const groups = [
    qualification.questions,
    anchor.similarity_questions,
    ...Object.values(verification.standing_questions),
    ...[...skuIndex.keys()].map((s) => getSkuQuestions(s)),
  ];
  for (const questions of groups) {
    for (const q of questions) {
      assert.ok(['select', 'multiselect', 'text', 'longtext', 'number', 'date', 'boolean'].includes(q.type), `${q.id} has type ${q.type}`);
      if (q.type === 'select' || q.type === 'multiselect') {
        assert.ok(Array.isArray(q.options) && q.options.length > 0, `${q.id} needs options`);
      }
    }
  }
});

test('every show_if condition is evaluable and references a real question in its own scope', () => {
  const { skuIndex, qualification } = loadData();
  const check = (questions, scopeName) => {
    const ids = new Set(questions.map((q) => q.id));
    for (const q of questions) {
      if (!q.show_if) continue;
      assert.doesNotThrow(() => evaluate(q.show_if, {}), `${scopeName}/${q.id} condition is malformed`);
      const fields = JSON.stringify(q.show_if).match(/"field":"(\w+)"/g) || [];
      for (const field of fields.map((f) => f.split('"')[3])) {
        assert.ok(ids.has(field), `${scopeName}/${q.id} depends on "${field}" which is not asked in that scope`);
      }
    }
  };
  check(qualification.questions, 'qualification');
  for (const skuId of skuIndex.keys()) check(getSkuQuestions(skuId), skuId);
});

test('every SKU bom_rule points at a question that SKU actually asks', () => {
  const { skuIndex } = loadData();
  for (const [skuId, sku] of skuIndex) {
    const ids = new Set(getSkuQuestions(skuId).map((q) => q.id));
    for (const rule of sku.bom_rules || []) {
      for (const field of fieldsIn(rule.when)) {
        assert.ok(ids.has(field), `${skuId} rule ${rule.id} depends on unasked question "${field}"`);
      }
      for (const field of [rule.add.sourcing_from, rule.add.qty_from_field].filter(Boolean)) {
        assert.ok(ids.has(field), `${skuId} rule ${rule.id} reads unasked question "${field}"`);
      }
    }
  }
});

test('every global bom_rule can actually fire in each category it claims', () => {
  const { skuIndex, catalogue } = loadData();
  for (const rule of catalogue.global_bom_rules) {
    for (const categoryId of rule.applies_to_categories || []) {
      const skusInCategory = [...skuIndex.values()].filter((s) => s.category_id === categoryId);
      assert.ok(skusInCategory.length > 0, `rule ${rule.id} names unknown category "${categoryId}"`);
      for (const field of fieldsIn(rule.when)) {
        const asked = skusInCategory.some((s) => getSkuQuestions(s.sku).some((q) => q.id === field));
        assert.ok(asked, `global rule ${rule.id} can never fire for "${categoryId}" - no SKU there asks "${field}"`);
      }
    }
  }
});

test('every catalogue flag reads a question asked somewhere', () => {
  const { skuIndex, catalogue } = loadData();
  const allAsked = new Set([...skuIndex.keys()].flatMap((s) => getSkuQuestions(s).map((q) => q.id)));
  for (const flag of catalogue.flags) {
    for (const field of fieldsIn(flag.when)) {
      assert.ok(allAsked.has(field), `flag ${flag.id} reads "${field}" which no SKU asks`);
    }
    assert.ok(['blocking', 'assumption', 'review'].includes(flag.severity), `flag ${flag.id} has severity ${flag.severity}`);
  }
});

test('every accessory referenced by a rule exists in the accessory catalogue', () => {
  const { skuIndex, catalogue, accessoryIndex } = loadData();
  const referenced = new Set();
  for (const [, sku] of skuIndex) {
    for (const rule of sku.bom_rules || []) if (rule.add.sku) referenced.add(rule.add.sku);
  }
  for (const rule of catalogue.global_bom_rules) {
    if (rule.add.sku) referenced.add(rule.add.sku);
    if (rule.add.sku_from) {
      for (const [key, value] of Object.entries(rule.add.sku_from)) if (key !== '_field') referenced.add(value);
    }
  }
  for (const sku of referenced) {
    assert.ok(accessoryIndex.has(sku) || skuIndex.has(sku), `Rule references unknown SKU "${sku}"`);
  }
});

test('catalogue tree exposes categories, subtypes and SKUs', () => {
  const tree = catalogueTree();
  assert.ok(tree.length >= 3);
  const skus = tree.flatMap((c) => c.subtypes).flatMap((s) => s.skus);
  assert.ok(skus.some((s) => s.sku === 'CF82'));
  assert.ok(skus.every((s) => s.question_count > 0));
});

test('labelFor renders option labels for prose', () => {
  const question = { options: [{ value: 'wall', label: 'Wall' }, { value: 'pole', label: 'Pole' }] };
  assert.equal(labelFor(question, 'wall'), 'Wall');
  assert.equal(labelFor(question, ['wall', 'pole']), 'Wall, Pole');
  assert.equal(labelFor(question, 'unknown-value'), 'unknown-value');
});
