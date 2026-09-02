/**
 * Word generation. Two clearly separated halves: bill of materials, then the
 * scope of work. Renders the document model - it makes no decisions about
 * content.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  PageBreak,
  ShadingType,
} from 'docx';
import { OUTPUT_DIR } from './config.js';

const ACCENT = '1F3864';
const WARN = 'B22222';
const MUTED = '595959';
const SHADE = 'F2F2F2';

const p = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: opts.after ?? 120 },
    alignment: opts.alignment,
    indent: opts.indent,
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        color: opts.color,
        size: opts.size,
        allCaps: opts.allCaps,
      }),
    ],
  });

const bullet = (text, level = 0, opts = {}) =>
  new Paragraph({
    bullet: { level },
    spacing: { after: 60 },
    children: [new TextRun({ text, italics: opts.italics, color: opts.color, bold: opts.bold })],
  });

const heading = (text, level = HeadingLevel.HEADING_1) =>
  new Paragraph({ text, heading: level, spacing: { before: 280, after: 140 } });

function cell(text, { bold = false, width, color, shade = false, align } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: shade ? { type: ShadingType.CLEAR, fill: SHADE } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text: String(text ?? ''), bold, color, size: 20 })],
      }),
    ],
  });
}

function calloutParagraph(text, color = WARN) {
  return new Paragraph({
    spacing: { before: 160, after: 160 },
    border: {
      top: { style: BorderStyle.SINGLE, size: 6, color },
      bottom: { style: BorderStyle.SINGLE, size: 6, color },
      left: { style: BorderStyle.SINGLE, size: 18, color },
      right: { style: BorderStyle.SINGLE, size: 6, color },
    },
    indent: { left: 120, right: 120 },
    children: [new TextRun({ text, bold: true, color, size: 21 })],
  });
}

/* ------------------------------------------------------------ BOM section */

function bomTable(group) {
  const header = new TableRow({
    tableHeader: true,
    children: [
      cell('SKU', { bold: true, width: 16, shade: true }),
      cell('Description', { bold: true, width: 44, shade: true }),
      cell('Qty', { bold: true, width: 10, shade: true, align: AlignmentType.RIGHT }),
      cell('Unit', { bold: true, width: 10, shade: true }),
      cell('Sourcing', { bold: true, width: 20, shade: true }),
    ],
  });

  const rows = group.lines.map((line) => {
    const unresolvedQty = line.quantity === null;
    const unresolvedSrc = String(line.sourcing).startsWith('UNRESOLVED');
    return new TableRow({
      children: [
        cell(line.sku),
        cell(line.description),
        cell(unresolvedQty ? 'UNRESOLVED' : line.quantity, {
          align: AlignmentType.RIGHT,
          color: unresolvedQty ? WARN : undefined,
          bold: unresolvedQty,
        }),
        cell(line.unit),
        cell(line.sourcing, { color: unresolvedSrc ? WARN : undefined, bold: unresolvedSrc }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [header, ...rows],
  });
}

function bomSection(doc) {
  const children = [
    heading('Bill of Materials', HeadingLevel.HEADING_1),
    p(
      'Quantities are derived from the answers recorded for each device group. Sourcing status is stated per line. Any line marked UNRESOLVED depends on a question that was not answered and must be closed before ordering.',
      { italics: true, color: MUTED },
    ),
  ];

  if (doc.bom.categories.length === 0) {
    children.push(p('No equipment has been selected for this project.', { color: WARN, bold: true }));
    return children;
  }

  for (const group of doc.bom.categories) {
    children.push(heading(group.category, HeadingLevel.HEADING_2));
    children.push(bomTable(group));
    children.push(p('', { after: 100 }));
  }

  const summary = Object.entries(doc.sourcing_summary)
    .map(([status, count]) => `${status}: ${count} line${count === 1 ? '' : 's'}`)
    .join('   |   ');
  children.push(p(`Sourcing summary - ${summary}`, { italics: true, color: MUTED }));

  if (doc.bom.unresolved.length) {
    children.push(calloutParagraph(`${doc.bom.unresolved.length} bill of materials line(s) could not be fully resolved. See Open Items.`));
  }

  return children;
}

/* ------------------------------------------------------------ SOW blocks */

function renderBlock(block) {
  switch (block.type) {
    case 'paragraph':
      return [p(block.text)];

    case 'clause':
      return [p(block.title, { bold: true, after: 60 }), p(block.text)];

    case 'note':
      return [p(block.text, { italics: true, color: MUTED })];

    case 'callout':
      return [calloutParagraph(block.text)];

    case 'observation':
      return [p(block.prompt, { bold: true, after: 40 }), p(block.text)];

    case 'definition_list':
      return block.items.flatMap((item) => [
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: `${item.term}: `, bold: true }),
            new TextRun({
              text: String(item.value ?? 'Not stated'),
              color: String(item.value).includes('OUTSTANDING') ? WARN : undefined,
              bold: String(item.value).includes('OUTSTANDING'),
            }),
          ],
        }),
      ]);

    case 'work_item':
      return [
        p(block.heading, { bold: true, after: 40 }),
        p(block.subheading, { italics: true, color: MUTED, after: 60 }),
        ...block.details.map((detail) =>
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: [
              new TextRun({ text: `${detail.prompt} ` , color: MUTED, size: 19 }),
              new TextRun({ text: String(detail.value), size: 20 }),
              ...(detail.established
                ? []
                : [new TextRun({ text: '  [PROPOSED - NOT CONFIRMED BY A PERSON]', color: WARN, bold: true, size: 18 })]),
              ...(detail.overridden
                ? [new TextRun({ text: '  [overridden by account executive]', color: MUTED, italics: true, size: 18 })]
                : []),
            ],
          }),
        ),
      ];

    case 'tagged_list':
      return [
        p(block.heading, { bold: true, after: 60 }),
        ...block.items.flatMap((item) => [
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: item.basis ? 20 : 60 },
            children: [
              new TextRun({ text: `${item.scope}: `, bold: true, size: 20 }),
              new TextRun({ text: item.text, size: 20 }),
            ],
          }),
          ...(item.basis
            ? [new Paragraph({ indent: { left: 720 }, spacing: { after: 60 }, children: [new TextRun({ text: `Basis: ${item.basis}`, italics: true, color: MUTED, size: 19 })] })]
            : []),
        ]),
      ];

    case 'assumption_flag':
      return [bullet(block.text, 0, { italics: true })];

    case 'open_item':
      return [
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [
            new TextRun({ text: block.text, size: 20 }),
            new TextRun({ text: `  (${block.source})`, italics: true, color: MUTED, size: 18 }),
          ],
        }),
      ];

    case 'override_table':
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              children: [
                cell('Where', { bold: true, width: 22, shade: true }),
                cell('Item', { bold: true, width: 38, shade: true }),
                cell('Proposed', { bold: true, width: 20, shade: true }),
                cell('Changed to', { bold: true, width: 20, shade: true }),
              ],
            }),
            ...block.rows.map((row) =>
              new TableRow({
                children: [cell(row.where), cell(row.prompt), cell(row.from ?? '-'), cell(row.to)],
              }),
            ),
          ],
        }),
      ];

    default:
      return [p(block.text || '')];
  }
}

/* ------------------------------------------------------------- assembly */

export function renderDocument(doc) {
  const title = [
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: 'SCOPE OF WORK', bold: true, size: 40, color: ACCENT })],
    }),
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: `${doc.meta.client} - ${doc.meta.project_name}`, size: 28 })],
    }),
    p(doc.meta.site_address, { color: MUTED }),
    p(
      `${doc.meta.site_type}   |   Prepared ${new Date(doc.meta.generated_at).toLocaleDateString('en-CA')}   |   ${doc.meta.walked ? 'Based on site walk' : 'PROVISIONAL - no site walk'}`,
      { color: doc.meta.walked ? MUTED : WARN, bold: !doc.meta.walked },
    ),
    ...(doc.meta.anchor ? [p(`Scoped against: ${doc.meta.anchor}`, { italics: true, color: MUTED })] : []),
    calloutParagraph(
      doc.meta.ready
        ? 'DRAFT FOR REVIEW - This document was generated from recorded answers and must be reviewed by a person before it is issued.'
        : 'DRAFT - INCOMPLETE. Known gaps remain open (see Open Items). Do not issue to the customer.',
      doc.meta.ready ? ACCENT : WARN,
    ),
  ];

  const sow = [
    new Paragraph({ children: [new PageBreak()] }),
    heading('Scope of Work', HeadingLevel.HEADING_1),
  ];

  for (const section of doc.sections) {
    sow.push(heading(section.title, HeadingLevel.HEADING_2));
    for (const block of section.blocks) {
      sow.push(...renderBlock(block));
    }
  }

  return new Document({
    creator: doc.meta.company,
    title: `${doc.meta.client} - ${doc.meta.project_name} - Scope of Work`,
    description: 'Generated draft scope of work',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 21 } },
      },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', run: { size: 30, bold: true, color: ACCENT }, paragraph: { spacing: { before: 300, after: 140 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', run: { size: 25, bold: true, color: ACCENT }, paragraph: { spacing: { before: 240, after: 120 } } },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        children: [...title, ...bomSection(doc), ...sow],
      },
    ],
  });
}

export async function writeDocument(doc, filenameHint) {
  const safe = String(filenameHint || 'scope-of-work')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const filename = `${safe}-${Date.now()}.docx`;
  const target = path.join(OUTPUT_DIR, filename);
  const buffer = await Packer.toBuffer(renderDocument(doc));
  fs.writeFileSync(target, buffer);
  return { filename, path: target, bytes: buffer.length };
}
