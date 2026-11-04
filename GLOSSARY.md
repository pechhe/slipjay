# SlipJay

SlipJay owns isolated workspaces, bounded verification, and serial integration and publication of changes.

## Language

**Batch check**:
The one complete release verification of a promotion's frozen head, measured from the commit Production serves. Only a passing batch check of the exact commit lets it deploy.
_Avoid_: Pre-verification of a landing, release gate

**Culprit**:
A landing of a red batch at whose commit a failing suite first goes from passing to failing, found by diagnosis and routed to that landing's own Forge work.
_Avoid_: Suspect, blame

**Cause class**:
A deterministic category explaining why an operation did not complete, assigned from recorded execution evidence under a versioned rule.
_Avoid_: Model judgement, diagnosis

**Flake candidate**:
A named test that failed across different changes within an observation window. A later successful run on unchanged source confirms the candidate; neither observation permits ignoring a failing gate.
_Avoid_: Ignored failure

**Held integration**:
A change integrated locally whose finalization or publication has not completed. It must be recovered before another change integrates.
_Avoid_: Landed change, published change
