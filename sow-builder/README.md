# SOW Builder

An internal tool for account executives at a physical security integrator. It
interrogates the AE about a project, then produces a Word document containing a
bill of materials and a written scope of work.

The value is in the questioning. The question bank, equipment catalogue and
clause library are data files — adding a camera model or a new question never
means touching application logic.

## Running it

```bash
npm install
cp .env.example .env      # optional - see "Without an API key" below
npm start                 # http://localhost:3000
npm test
```

No auth, no database. Projects are JSON files under `storage/projects/`,
generated documents under `storage/output/`.

### Without an API key

Stages 0, 1, 3 and 4, the bill of materials and Word generation all work with no
credentials at all. Two things need the Anthropic API:

- the prose drafting pass (the document falls back to plainer generated prose)
- floor plan reading (the whole stage is optional)

## The flow

| Stage | What it does |
|---|---|
| 0. Qualification gate | Site walk, subcontractor, quote status, what the customer has already been told. **Hard branch:** the site-walk answer decides whether the output is an observed-conditions SOW or a provisional one carrying an assumptions block. |
| 1. Anchor | Name a similar past project. The app asks what makes it similar and uses it as the baseline; the interrogation from there is about differences. |
| 2. Floor plan (optional) | Claude returns a first-pass reading — placements, door count, coverage gaps. Every item is an editable proposal with a reject path. Anything not explicitly accepted stays unverified. |
| 3. Equipment | Branching catalogue tree. Selecting a SKU unlocks its per-unit questions — mount type, surface, adapter, sourcing, cable run, pathway, power, height, lift. One question at a time. |
| 4. Assumptions vs confirmed | Walks every item gathered and tags it. Not walked → confirmed / assumed / open. Walked → observed / assumed / open, with what was actually seen. Same engine, two output paths. |
| Review | Readiness, flags, BOM, prose drafting and editing, document generation. |

## The four rules the code enforces

These are the ones worth checking a change against — each has tests.

**An unanswered question never becomes a confirmed fact.** Unanswered required
questions block generation. A BOM line whose sourcing question is unanswered
prints `UNRESOLVED`, never a default. An item that was never tagged prints under
Open Items as *not verified*, never in the confirmed list. Generation refuses
with a 409 until gaps are resolved or explicitly acknowledged — and an
acknowledged draft carries a "do not issue" banner listing every gap.

**The AE can override anything, and overrides are visible.** Every answer records
its source, whether a person confirmed it, and its previous value. A model
proposal the AE never touched is not an established fact: it blocks generation
and prints `[PROPOSED — NOT CONFIRMED BY A PERSON]`. Corrections and rejections
appear in Appendix A of the document.

**Assumptions are generated, never freestyled.** The assumptions and
observed-conditions sections are built from tagged answers, so nothing can be
omitted by accident.

**Every document is a draft.** Each one is banner-marked for human review.

## Layout

```
data/
  catalogue/equipment.json    tree, SKUs, per-SKU questions, BOM rules, flags
  questions/qualification.json  stage 0 - the gate and its branch
  questions/anchor.json         stage 1 - what makes it similar
  questions/verification.json   stage 4 - both paths and the standing questions
  clauses/sow-clauses.json      boilerplate clause library
  sows/manifest.json            index of past SOWs available as anchors
server/
  conditions.js   show_if / include_if / when evaluator (no domain knowledge)
  data.js         loads and indexes the data files
  engine.js       progressive disclosure, tagging, flags, readiness
  bom.js          BOM derivation from catalogue rules
  document.js     document model - clauses + tagged answers + prose
  word.js         docx rendering
  prose.js        Claude drafting pass
  floorplan.js    Claude floor plan reading
  anchor.js       keyword + attribute retrieval over the manifest
public/           single page front end, no build step
```

## Extending it

**A new camera model:** add a SKU object under the right subtype in
`data/catalogue/equipment.json`. List the shared `question_sets` it needs and add
any SKU-specific questions. Add `bom_rules` for the mounts it pulls, and add
those accessories to `accessory_catalogue`. No code changes.

**A new question:** add it to the relevant question set. Use `show_if` to gate it
on an earlier answer — it will slot into the progressive flow automatically. Set
`taggable: false` to keep it out of the confirmed/assumed pass.

**A new clause:** add it to `data/clauses/sow-clauses.json` with a section, an
order, and either `always: true` or an `include_if` condition.

The data tests enforce the invariants that matter: every question has a usable
type, every `show_if` references a question asked in the same scope, every BOM
rule reads a question its SKU actually asks, every global rule can fire in every
category it claims, and every accessory a rule references exists.

## Retrieval

Anchor matching is keyword and attribute scoring against the manifest, and it
explains its matches. Deliberately simple — don't reach for embeddings until this
visibly fails.

## Status

Stages 0–4 and Word generation are built and covered end to end, including a
browser pass over the real UI. The Anthropic drafting and floor-plan paths are
covered against a stub endpoint (request shape, prompt assembly, structured-output
parsing, proposal handling); they have not been exercised against the live API.
