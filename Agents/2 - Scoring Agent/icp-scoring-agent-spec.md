# ICP Scoring Agent - Spec (ICP-02)

## Role and position in the pipeline

Input: the segments produced by the ICP Questioning Agent, once its status is `ready_for_review` and the human checkpoint has passed.
Output: a ranked list of segments with explicit, non-opaque scores, plus which knowledge gaps must be resolved in Phase 2 before a segment can be fully trusted.
Downstream: this output feeds Kill Gate 1 and the meta-agent.

This version matches the actual Questioning Agent schema (8 dimensions, hypotheses already generated upstream), not the reduced 4-5 dimension version from the first draft.

## Input schema (from Questioning Agent, status ready_for_review)

```json
{
  "status": "ready_for_review",
  "segments": [
    {
      "segment_id": "string",
      "segment_name": "string",
      "dimensions": {
        "firmographics": "string",
        "tech_stack_signals": "string",
        "buyer_persona": "string",
        "jtbd": "string",
        "existing_alternatives": "string",
        "trigger_events": "string",
        "budget_authority": "string",
        "reachability": "string"
      },
      "hypotheses_to_test": ["string"]
    }
  ],
  "human_checkpoint": "string"
}
```

Some dimension values may be thin, vague, or effectively empty. This happens legitimately when `prior_clarification_rounds` hit its cap of 2 without a real answer from the founder. The Scoring Agent must detect this rather than paper over it with a guessed score.

## Dimension to criterion mapping

The Questioning Agent produces 8 raw dimensions. The Scoring Agent scores 4 judging-relevant criteria. Here's the explicit mapping, so the score is traceable back to specific input fields rather than a vague overall impression.

**market_size** derived from `firmographics` (size and count proxy) and `existing_alternatives` (a crowded space with established alternatives is weak evidence the market is real and worth targeting).

**urgency** derived from `trigger_events` (primary) and `jtbd` (how painful is the job to be done).

**reachability** derived from `reachability` (primary), `buyer_persona` (is there even an identifiable decision-maker), and the top-level `reachable_channels` from the original input if present.

**ltv_proxy** derived from `firmographics` (company size proxy) and `budget_authority` (who controls spend, and at what scale).

`tech_stack_signals` doesn't map to a scoring criterion. It's not wasted, it's held as context for Phase 2's Content Listener agent (existing tools in use are a competitive/positioning signal, not a prioritization signal at this stage).

## Handling unscoreable dimensions

This is the key addition based on your point. Three rules:

1. **Unscoreable is not zero.** If a criterion can't be grounded in the input (the source dimension is empty, contradictory, or purely speculative), it gets `confidence: "unscoreable"` and no numeric score, instead of a guessed or default value. This applies with extra weight to `reachability`, since a `0` there triggers an automatic kill; confusing "unknown" with "confirmed unreachable" would kill segments that were simply never tested.
2. **Unscoreable becomes a discovery item, not a dead end.** Each unscoreable criterion produces an entry in a new `knowledge_gaps` array, tagged with which Phase 2 sub-agent should resolve it (see mapping below). This is what routes the gap back into your existing Phase 2 machinery instead of inventing a new step.
3. **The weighted total is computed only over scored criteria, and rescaled.** A segment scored on 3 out of 4 criteria isn't penalized by treating the missing one as 0; the weights of the scored criteria are rescaled to sum to 1. The output carries an explicit `overall_confidence` (high/medium/low) based on how many criteria were actually scored, so the ranking doesn't look falsely precise next to a fully-scored segment.

Knowledge gap to Phase 2 agent mapping:
`reachability` gap resolved by Persona Builder and Stakeholder Mapper.
`trigger_events` gap resolved by Content Listener and Signal Aggregator.
`buyer_persona` or `budget_authority` gap resolved by Stakeholder Mapper.
`existing_alternatives` or `tech_stack_signals` gap resolved by Content Listener.

## Scoring criteria rubric

**market_size**: 0 no way to estimate, 1-2 niche or unverifiable, 3 credible mid-size market from a named proxy, 4-5 large and well-documented market.

**urgency**: 0 no trigger event identified, 1-2 trigger exists but low frequency or weak signal, 3 trigger recurring and plausible, 4-5 trigger is frequent, measurable, and directly tied to the JTBD.

**reachability**: 0 confirmed no identifiable channel or decision-maker path exists, 1-2 decision-makers exist but no clear channel, 3 channel exists but unproven, 4-5 channel exists and has precedent. If the input doesn't support any of these confidently, don't score it, mark it unscoreable instead.

**ltv_proxy**: 0 no way to estimate deal value, 1-2 small or unclear value per account, 3 moderate and plausible, 4-5 large value per account with a credible proxy.

## Weighting

Default: equal weight, 25% each, rescaled over whichever criteria were actually scored for that segment.

## Output schema

```json
{
  "ranking": [
    {
      "segment_id": "seg_01",
      "segment_name": "string",
      "scores": {
        "market_size": {"value": 0, "confidence": "high"},
        "urgency": {"value": 0, "confidence": "medium"},
        "reachability": {"value": null, "confidence": "unscoreable"},
        "ltv_proxy": {"value": 0, "confidence": "high"}
      },
      "weighted_total": 0.0,
      "overall_confidence": "medium",
      "kill_gate_1": {
        "triggered": false,
        "reason": "string or null, only set when reachability is confirmed 0, never when unscoreable"
      },
      "knowledge_gaps": [
        {"dimension": "reachability", "why_it_matters": "string", "resolve_via": "Persona Builder / Stakeholder Mapper"}
      ],
      "rationale": "2-3 sentences justifying each scored criterion, referencing the actual input fields",
      "hypotheses_to_test": ["passed through from the Questioning Agent, reordered by priority, with any new hypotheses implied by knowledge_gaps appended"]
    }
  ],
  "segments_killed": ["segment_id"],
  "segments_retained": ["max 3 segment_id, ordered by weighted_total among non-killed segments"]
}
```

## Kill Gate 1 logic, explicit

1. A segment is killed only when `reachability` is confirmed scored at 0. Unscoreable reachability never triggers an automatic kill.
2. Among the remaining segments, keep the top 3 by `weighted_total`.
3. If fewer than 3 segments survive step 1, keep all of them.
4. A segment with `overall_confidence: "low"` can still be retained, but the meta-agent should treat it as provisional: don't commit enrichment budget (Fullenrich) to it until Phase 2 resolves its knowledge gaps. This mirrors the conditional-enrichment rule you already have (enrich only after 2+ signals).

## System prompt (drop-in for the Claude API call)

```
You are the ICP Scoring Agent in a multi-agent ICP discovery pipeline.

You receive segments from the ICP Questioning Agent, each described by 8 dimensions: firmographics, tech_stack_signals, buyer_persona, jtbd, existing_alternatives, trigger_events, budget_authority, reachability. These are hypotheses, some may be thin or unresolved because founder clarification was capped at 2 rounds.

Score each segment on four criteria, using this mapping:
market_size from firmographics and existing_alternatives.
urgency from trigger_events and jtbd.
reachability from reachability, buyer_persona, and reachable_channels if provided.
ltv_proxy from firmographics and budget_authority.

For each criterion, use the 0-5 rubric provided. If the relevant input fields don't support a confident score, do not guess. Mark that criterion as unscoreable and add an entry to knowledge_gaps explaining what's missing and which downstream agent should resolve it (Persona Builder, Stakeholder Mapper, Content Listener, or Signal Aggregator).

Never treat unscoreable as equivalent to a score of 0. A score of 0 on reachability must only be used when the input actively confirms no channel or decision-maker path exists, not when the information is simply absent.

Compute weighted_total using equal weights across whichever criteria were scored, rescaled to sum to 1. Set overall_confidence based on how many of the 4 criteria were actually scored (all 4 = high, 3 = medium, 2 or fewer = low).

Apply Kill Gate 1: kill only segments with a confirmed reachability score of 0. Among the rest, retain at most 3, ranked by weighted_total.

Pass through the hypotheses_to_test you received, reordered by relevance to the top-ranked criteria, and append any new hypotheses implied by unresolved knowledge_gaps.

Output strictly as JSON matching the schema you were given. No prose outside the JSON.
```

## Worked example (illustrative, restaurant sector test case)

Segment: "Restaurant groups 5+ sites, Paris region"
market_size 4, urgency 4, reachability unscoreable (input mentions a persona hypothesis but no confirmed channel), ltv_proxy 4.
weighted_total computed over 3 scored criteria, rescaled. overall_confidence: medium.
knowledge_gaps: reachability, resolve via Persona Builder and Stakeholder Mapper.
Not killed, but flagged as provisional: no enrichment budget until Phase 2 confirms a channel.

Segment: "Independent single-site restaurants"
market_size 5, urgency 2, reachability 0 confirmed (input states owner-operators with no identifiable buying process or accessible channel at scale).
Killed by Kill Gate 1. This is the case where 0 is a real, evidenced score, not an absence of information.

## Gap resolution mechanism (Phase 2)

A segment retained with `overall_confidence: low` (or any unscoreable criterion) doesn't get special treatment on entry to Phase 2, it runs in parallel with the other segments like normal, carrying its `knowledge_gaps` array as a tag.

**Which agent resolves which gap.** No new agent is created for this. Existing Phase 2 agents absorb it:
`reachability` gap resolved by Persona Builder and Stakeholder Mapper. If they identify a named decision-maker with an active channel (LinkedIn profile, activity detected by Sillage) on at least part of the segment's top accounts, that confirms a channel exists, without needing Fullenrich enrichment to prove it.
`trigger_events` gap resolved by Content Listener and Signal Aggregator, who check whether the hypothesized trigger actually shows up in detected signals.
`buyer_persona` or `budget_authority` gap resolved by Stakeholder Mapper.
`existing_alternatives` or `tech_stack_signals` gap resolved by Content Listener.

**Who decides a gap is resolved.** This extends the Hypothesis Validator rather than adding a separate re-scoring agent, since it already sits at the right point in the pipeline (it receives aggregated signals and confirms or kills hypotheses). It now also produces an updated score for any criterion still marked `unscoreable`, using the same rule as the Scoring Agent: either a real score if evidence surfaced, or it stays `unscoreable` if nothing did.

**Fullenrich unlock condition changes.** Enrichment becomes possible only when both hold: the existing rule (2+ signals on a contact), and the new rule (no open `reachability` gap remaining on the segment). Both conditions together, not either alone.

**Gap that stays unresolved after a real Phase 2 pass.** This has a different epistemic status than an unscoreable at Questioning stage. At Questioning stage, "unknown" means the founder doesn't have the answer yet. After an active Phase 2 search for signal that comes back empty, the absence becomes evidence itself. So a gap still unresolved after its resolution deadline is treated as a confirmed negative retroactively, triggering a retroactive kill for reachability, or a permanent low-confidence flag for the other criteria. This extends Kill Gate 2, which already kills segments with no signals coherent with the JTBD, to also kill segments whose reachability gap was never closed.

**Resolution deadlines, split by gap speed.** Finding a decision-maker and finding a content signal don't resolve at the same pace, so the deadline is set per gap type rather than as one global number. Whichever condition is hit first, time or volume, ends the investigation.

Fast gaps, `reachability`, `buyer_persona`, `budget_authority`, resolved via Persona Builder / Stakeholder Mapper: deadline at 1 week, or 10 of the segment's top accounts checked with no identifiable decision-maker or active channel found, whichever comes first.

Slow gaps, `trigger_events`, `existing_alternatives`, `tech_stack_signals`, resolved via Content Listener / Signal Aggregator: deadline at 2 weeks, or 20 pieces of content (LinkedIn posts, job postings) reviewed with no match to the hypothesized trigger, whichever comes first.

A `reachability` gap that hits its deadline unresolved triggers the retroactive kill above, since reachability is the one criterion with hard-kill power. Any other gap hitting its deadline unresolved doesn't kill the segment, it locks `overall_confidence` at `low` permanently for that criterion, and the segment proceeds on its remaining scored criteria alone.

## Updated output schema addition

The `knowledge_gaps` entries now carry a status that changes over the pipeline:

```json
{
  "dimension": "reachability",
  "why_it_matters": "string",
  "resolve_via": "Persona Builder / Stakeholder Mapper",
  "status": "open",
  "opened_at_phase": "scoring",
  "resolution_deadline": "1 week or 10 accounts checked for fast gaps (reachability, buyer_persona, budget_authority); 2 weeks or 20 content items reviewed for slow gaps (trigger_events, existing_alternatives, tech_stack_signals)"
}
```

`status` moves from `open` to either `resolved` (Hypothesis Validator produced a real score) or `confirmed_negative` (deadline passed with no signal, retroactive kill applied). This is what lets the meta-agent tell the difference between "still investigating" and "investigated, genuinely a dead end" without re-deriving that logic itself.
