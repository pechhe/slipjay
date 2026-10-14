# SlipJay

SlipJay owns isolated workspaces and the serial verification, integration and publication of changes.

## Language

**Cause class**:
A deterministic category explaining why an operation did not complete, assigned from recorded execution evidence under a versioned rule.
_Avoid_: Model judgement, diagnosis

**Flake candidate**:
A named test that failed across different changes within an observation window. A later successful run on unchanged source confirms the candidate; neither observation permits ignoring a failing gate.
_Avoid_: Ignored failure

**Held integration**:
A change integrated locally whose finalization or publication has not completed. It must be recovered before another change integrates.
_Avoid_: Landed change, published change
