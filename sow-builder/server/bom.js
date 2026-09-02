/**
 * Bill of materials derivation.
 *
 * Every line comes from either an AE-selected SKU or a bom_rule in the
 * catalogue data file. There are no accessories hardcoded here - if a mount is
 * missing from the BOM, the rule is missing from the catalogue.
 */
import { evaluate } from './conditions.js';
import { loadData, getSku } from './data.js';
import { context } from './engine.js';
import { isEstablished } from './answers.js';

const UNRESOLVED = 'UNRESOLVED - not answered';

function sourcingFor(line, rule) {
  const field = rule.add?.sourcing_from;
  if (!field) return null;
  const record = line.answers[field];
  if (!record || record.value === undefined || record.value === '') return UNRESOLVED;
  return isEstablished(record) ? record.value : `${record.value} (proposed, unconfirmed)`;
}

function resolveSku(rule, ctx) {
  const add = rule.add;
  if (add.sku) return add.sku;
  if (add.sku_from) {
    const field = add.sku_from._field;
    const value = ctx[field];
    return add.sku_from[value] || null;
  }
  return null;
}

function interpolate(template, ctx, extra = {}) {
  const { catalogue } = loadData();
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    if (key in extra) return extra[key];
    if (key === 'cable_type_label') return catalogue.cable_type_labels?.[ctx.cable_type] || ctx.cable_type || '';
    if (key in ctx) return ctx[key];
    return match;
  });
}

function quantityFor(rule, line, ctx) {
  const add = rule.add;
  if (add.qty_from_field) {
    const raw = Number(ctx[add.qty_from_field]);
    if (!Number.isFinite(raw)) return { qty: null, unresolved: true };
    const per = add.per_unit === false ? 1 : line.quantity;
    const waste = add.waste_factor || 1;
    return { qty: Math.ceil(raw * per * waste), unresolved: false };
  }
  const perUnit = add.qty_per_unit ?? 1;
  return { qty: perUnit * line.quantity, unresolved: false };
}

/**
 * @returns {{lines: Array, categories: Array, unresolved: Array}}
 */
export function buildBom(project) {
  const { catalogue, accessoryIndex } = loadData();
  const rows = [];
  const unresolved = [];

  for (const line of project.lines) {
    const sku = getSku(line.sku);
    const ctx = context(project, line);

    rows.push({
      category: `${sku.category_label} - ${sku.subtype_label}`,
      sku: sku.sku,
      description: sku.description,
      quantity: line.quantity,
      unit: sku.unit || 'each',
      sourcing: line.answers.equipment_sourcing?.value || 'to be ordered',
      origin: 'selected',
      line_id: line.id,
      line_label: line.label || `${sku.sku} x${line.quantity}`,
      notes: line.note || '',
    });

    const rules = [
      ...(sku.bom_rules || []),
      ...(catalogue.global_bom_rules || []).filter(
        (r) => !r.applies_to_categories || r.applies_to_categories.includes(sku.category_id),
      ),
    ];

    for (const rule of rules) {
      let matches;
      try {
        matches = evaluate(rule.when, ctx);
      } catch {
        matches = false;
      }
      if (!matches) continue;

      const skuId = resolveSku(rule, ctx);
      if (!skuId) continue;

      const accessory = accessoryIndex.get(skuId);
      const { qty, unresolved: qtyUnresolved } = quantityFor(rule, line, ctx);
      const sourcing = sourcingFor(line, rule);

      if (qtyUnresolved) {
        unresolved.push({
          line_id: line.id,
          line_label: line.label || sku.sku,
          sku: skuId,
          reason: `Quantity depends on "${rule.add.qty_from_field}", which is unanswered.`,
        });
      }
      if (sourcing === UNRESOLVED) {
        unresolved.push({
          line_id: line.id,
          line_label: line.label || sku.sku,
          sku: skuId,
          reason: `Sourcing depends on "${rule.add.sourcing_from}", which is unanswered.`,
        });
      }

      rows.push({
        category: rule.add.category || 'Mounts & accessories',
        sku: skuId,
        description: interpolate(rule.add.description || accessory?.description || skuId, ctx, { parent_sku: sku.sku }),
        quantity: qty,
        unit: rule.add.unit || accessory?.unit || 'each',
        sourcing: sourcing || 'to be ordered',
        origin: `rule:${rule.id}`,
        line_id: line.id,
        line_label: line.label || `${sku.sku} x${line.quantity}`,
        notes: '',
      });
    }
  }

  const merged = mergeRows(rows);
  const categories = groupByCategory(merged);
  return { lines: merged, categories, unresolved };
}

/** Identical SKU + sourcing + unit rolls up; anything that differs stays split. */
function mergeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = [row.category, row.sku, row.unit, row.sourcing].join('|');
    const existing = map.get(key);
    if (existing) {
      if (existing.quantity === null || row.quantity === null) {
        existing.quantity = null;
      } else {
        existing.quantity += row.quantity;
      }
      if (!existing.line_labels.includes(row.line_label)) existing.line_labels.push(row.line_label);
    } else {
      map.set(key, { ...row, line_labels: [row.line_label] });
    }
  }
  return [...map.values()];
}

const CATEGORY_ORDER = [
  'Cameras',
  'Access control',
  'Alarms & sensors',
  'Door hardware',
  'Mounts & accessories',
  'Cabling & consumables',
];

function categoryRank(category) {
  const index = CATEGORY_ORDER.findIndex((c) => category.startsWith(c));
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function groupByCategory(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.category)) map.set(row.category, []);
    map.get(row.category).push(row);
  }
  return [...map.entries()]
    .map(([category, lines]) => ({ category, lines: lines.sort((a, b) => a.sku.localeCompare(b.sku)) }))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.category.localeCompare(b.category));
}

/** Sourcing rollup for the document's summary line. */
export function sourcingSummary(bom) {
  const counts = {};
  for (const line of bom.lines) {
    counts[line.sourcing] = (counts[line.sourcing] || 0) + 1;
  }
  return counts;
}
