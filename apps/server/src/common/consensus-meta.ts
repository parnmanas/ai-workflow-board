/**
 * 다중담당자·합의 (multi-assignee consensus) — comment metadata contract.
 *
 * A ticket phase (= the column it currently sits in) can be staffed by several
 * holders of the same role (T1). Those co-holders talk to each other through
 * ordinary comments (the T3 "discussion channel"), and eventually cast a formal
 * agreement signal (the T4 "consensus" comment) that a gate reads to decide
 * whether the phase may advance.
 *
 * Two comment kinds share the timeline, so they MUST be unambiguously
 * distinguishable by downstream consumers (the dispatch fan-out, the future
 * consensus gate, the client). This module is the single authoritative
 * definition of that boundary so T3 (discussion), T4 (consensus), and the
 * trigger-loop can never drift on the marker string:
 *
 *   • DISCUSSION comment  — `type: 'note' | 'chat'`, and MUST NOT carry the
 *     consensus marker. This is co-holders reasoning out loud / calling each
 *     other in. It is deliberately unstructured.
 *
 *   • CONSENSUS comment   — carries `metadata.consensus_vote === true` (stamped
 *     by T4). Casting a vote must NOT re-wake the other holders: the trigger
 *     loop consults `isConsensusVoteComment` on the comment-fan-out path and
 *     suppresses the re-trigger, so mutual votes don't ping-pong into the
 *     self-echo / watchdog exit-143 infinite-loop family.
 *
 * T2 secured the suppression HOOK (`_commentSuppressesFanout`) but read the key
 * inline; nothing stamps it yet, so today `isConsensusVoteComment` is always
 * false and there is zero behavior change until T4 lands. Extracting the key
 * here is what "reserve the seat T4 builds on" means for T3.
 */

/**
 * Reserved `metadata` key a T4 consensus/agreement comment stamps `=== true`.
 * Discussion comments (T3) never set it. Keep this the ONLY place the literal
 * lives so trigger-loop, the consensus tool, and tests agree by construction.
 */
export const CONSENSUS_VOTE_META_KEY = 'consensus_vote';

/**
 * Reserved `metadata` key a T5 **move proposal** comment stamps `=== true`.
 *
 * `propose_move` opens a proposal by writing a comment carrying this marker plus
 * a structured `consensus_proposal` payload (target column + proposer). The
 * proposal comment's own id BECOMES the `proposalId` that consensus votes
 * ({@link CONSENSUS_VOTE_META_KEY}) reference, so the two markers never collide:
 * a proposal comment carries THIS key (and deliberately NOT the vote key, so it
 * still fans out to wake the co-holders who must vote), while each vote carries
 * the vote key (suppressed from fan-out). The consensus gate reads the latest
 * un-executed proposal to know where a satisfied consensus should move the
 * ticket. Kept here so the tool, the gate, and tests agree on one literal.
 */
export const CONSENSUS_PROPOSAL_META_KEY = 'consensus_proposal';

/**
 * Optional `metadata` marker a discussion comment (T3) MAY carry so the client
 * / a future consensus gate can facet "this was phase discussion" without
 * guessing from `type` alone. Purely advisory — its presence or absence never
 * gates dispatch (only {@link CONSENSUS_VOTE_META_KEY} does). Reserved here so
 * discussion tooling and consensus tooling share one namespace and cannot
 * collide on a key name.
 */
export const DISCUSSION_META_KEY = 'discussion';

/**
 * True iff a comment's (already-parsed) metadata bag marks it as a consensus
 * vote. Tolerant of null/undefined/non-object bags — anything that isn't an
 * explicit `true` reads as "ordinary comment" (the safe default that keeps the
 * fan-out flowing for normal discussion). Callers that hold the raw JSON string
 * should parse it first (e.g. via the repo's `safeJsonParse`) and pass the
 * object in — this predicate stays free of any JSON/parse dependency so both
 * the server dispatch path and the MCP tool layer can import it.
 */
export function isConsensusVoteComment(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>)[CONSENSUS_VOTE_META_KEY] === true;
}

/**
 * True iff a comment's (already-parsed) metadata bag marks it as a T5 move
 * proposal. Same tolerant contract as {@link isConsensusVoteComment}. A proposal
 * comment is deliberately NOT a vote comment, so it does NOT suppress fan-out —
 * proposing a move SHOULD wake the co-holders so they can cast their votes.
 */
export function isConsensusProposalComment(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>)[CONSENSUS_PROPOSAL_META_KEY] === true;
}
