# IC(E)looP — build brief

An interrogation and refinement loop that keeps a founder's ICP honest, and decides who is worth reaching now.

The ICP is a hypothesis, not a filter. IC(E)looP extracts the real one, falsifies it against the world before any contact, judges signals against it, refuses most of them with a stated reason, and uses those refusals to keep the definition current.

## What this is not

- Not a signal tool. Sillage does that.
- Not an enrichment tool. FullEnrich does that.
- Not a sequencer. HubSpot/Apollo do that.
- Not a lead-magnet generator. **Deferred to v2** — leave a slot in the interrogation output, build nothing.

IC(E)looP is the judgment layer above all of them. Everything left-to-right is orchestration anyone can assemble. The return path is the product.

## Pipeline

```
Interrogate  →  ICP hypothesis  →  Falsify  →  Listen  →  Judge  →  Enrich  →  Deliver
                      ↑                                      ↓
                    Learn  ←────────  skip log + outcomes  ──┘
```

| Stage | Owner | What it does |
|---|---|---|
| Interrogate | IC(E)looP | Extracts the real ICP from documents + hard questions |
| Falsify | Sillage | Do these people actually discuss this problem? Gate before any contact |
| Listen | Sillage | Signals fire |
| Judge | IC(E)looP | Score against current ICP. Default is skip, with a reason |
| Enrich | FullEnrich | Survivors only |
| Deliver | HubSpot / Apollo | Human approves first |
| Learn | IC(E)looP | Skip log + outcomes → refine ICP |

## The ICP artifact

Model on the "subscribable brain" pattern (brianmadden.ai). A git repo of markdown with YAML frontmatter. Agent-legible without flattening the founder's judgment out of it.

```
icp/
  validated.md      # what evidence supports
  hypothesis.md     # what the founder believes, unproven
  negative.md       # who is explicitly not a fit, and why
  gift.md           # v2 placeholder — do not build
  _index.json       # machine-readable manifest
```

Frontmatter per claim:

```yaml
claim: "Buyer is a Head of Sales, 0-6 months in role"
authority: 3          # 1-5. 5 = proven by closed deals. 1 = founder assertion.
evidence: ["3 of last 5 closed-won", "cited in 2 interviews"]
staleness: fast       # fast = timing/signals. slow = firmographics.
last_checked: 2026-07-09
```

Rules, adapted from the source pattern:

- `validated.md` outranks `hypothesis.md` on conflict. The gap between them is where the work is.
- Never invent facts about the buyer. Thin evidence → authority 1, and say so.
- Staleness thresholds decide what the agent re-checks. Firmographics rot slowly; timing rots in days.
- **`git log` on this repo is the ICP volatility metric.** No feature to build. Commit every refinement with the reason in the message.

A founder with no sales history ships `hypothesis.md` only. That is the honest output. Do not fabricate a validated ICP.

## Interrogate

Two inputs, two modes.

**Ingestion (non-invasive):** business plan, existing docs, website, past decks, CRM export if it exists. Read what they already have. Never make them fill in a form.

**Interrogation (deliberately invasive):** the questions below. Ingestion is what makes them sharp — you are not asserting an opinion, you are holding their own numbers up.

Governing rule: **their numbers, not your opinion.** Every question must force a count, a name, or a specific past event. If it can be answered with a feeling, it is not ready. Convert every "why" into "what happened" or "did you". "Why did they go quiet" invites a story. "Did you ask them" exposes the gap.

Puncture "it sells itself":

- How much of your revenue comes from people you didn't already know? Cold, no prior relationship.
- Of the last ten who saw the pitch, how many bought without you chasing them?
- How many sales have happened when you weren't personally in the room?
- Name a competitor or alternative a real prospect seriously weighed against you.
- The last prospect who stayed with what they had — what did they tell you, in their words?
- The last three who went quiet — what's your guess for each, and did you ever ask them?
- What is the customer using to solve this today, and why haven't they already switched?

Expose the relationship work:

- Last time you spent serious money on software, what got you to sign — the demo, or the person?
- Who inside the customer's org has to trust you before a deal closes? Have you met all of them?
- What's the personal risk to your champion if this flops internally?
- How many touchpoints did your last closed deal take?
- If a prospect went dark tomorrow, would you know why?

Behavioural constraints on the agent:

- **Let silence sit.** Do not fill a stall with the next question. The stall is the lesson. This is a design constraint, not a nicety — the model's instinct is to rescue.
- One question at a time.
- **End on "so what do we do about it."** The puncture is a door, not a verdict. A founder who feels dunked on rebuilds the illusion by morning. Move the energy onto who is actually worth pursuing.

Output: `hypothesis.md`, `validated.md`, `negative.md`, each claim with authority + evidence.

## Falsify

Before any contact. Use Sillage to check whether the segment demonstrably talks about the problem.

- Segment discusses it → promote claims from hypothesis to validated, raise authority, proceed.
- Segment never discusses it → the ICP is wrong, or the problem isn't felt. Refine. **Nothing goes out.**

This falsifies an ICP without contacting a single person. It works for a founder with zero sales history. It is the gate.

## Judge

Runs on every signal. Sits **before** enrichment so survivors only cost credits.

Output is one of:

```json
{ "decision": "skip", "reason": "Company under 20 staff — outside validated size band", "icp_claim_ref": "size-band-v3" }
{ "decision": "surface", "reason": "New CRO, 3 weeks in; competitor churn signal same week", "angle": "..." }
```

Default is skip. Surfacing must be earned. Every decision cites which ICP claim drove it — that reference is what makes the learn loop work.

Bar for surfacing: can you state something true about this person that would be **false for anyone else in their role**? If not, skip.

## Learn

Two return paths. Build the first today.

**Skip log (fast).** Every skip carries a stated reason, generated instantly, at volume. Cluster them. Two hundred skips citing the same claim means that claim is wrong or the signal source is. This detects ICP drift *before* anything is sent. Every other tool in the stack logs sends. This logs refusals. That is the differentiated dataset.

**Outcomes (slow, v2).** Failure is mostly silent — nobody replies and tells you why. Do not infer reasons from silence; that is a horoscope. Capture reasons only where they genuinely exist: HubSpot closed-lost, explicit rejections, and the founder actually asking.

Refinement rule: claim an ICP shift **only when the mechanism can be named** — this change alters this group's need for this product, through this chain. No mechanism, no claim. Otherwise stay quiet. A tool that announces a market shift every week is a horoscope.

Every refinement is a commit. Message states what changed and what evidence forced it.

## Build order

1. ICP repo schema + writer. The artifact everything else reads.
2. Interrogation agent. The questions, the silence, the turn. **This is where the day goes — its quality is the product.**
3. Falsify gate against Sillage.
4. Judge + skip log. Reasoned no, before enrichment.
5. Enrich survivors via FullEnrich. Hold delivery for human approval.
6. Skip-reason clustering → refinement proposal → commit.

## Failure modes

- The interrogation gets polite and turns into a form. It must force evidence and tolerate silence.
- The judge surfaces too much. If it isn't refusing most signals, the bar is wrong.
- The learn loop infers reasons from silence. It must not.
- The ICP gets "validated" without falsification. The gate is not optional.
- Scope creep into the gift. It is v2. A slot in the schema, nothing more.
