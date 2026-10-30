/**
 * END-TO-END FLOW built strictly on `Solar CRM flow diagrams.md`: one PM Surya Ghar residential project from the first enquiry to the warranty ticket,
 * plus the side branches of every decision node, driven only through HTTP with the real seed, every router, the in-memory database and a controllable clock.
 * Stage files register their describe blocks in order and share state through flowKit.ts; the last test proves every diagram node has an assertion.
 */
import { describe, expect, it } from 'vitest';
import { FLOW_NODES, coverageTable, proofCount, uncovered, writeTraceability } from './flowCoverage';
import { stage1 } from './flowStage1';
import { stage2 } from './flowStage2';
import { stage3 } from './flowStage3';
import { stage4 } from './flowStage4';
import { stage5 } from './flowStage5';
import { stage6 } from './flowStage6';
import { stage6b } from './flowStage6b';
import { stage7, stage7b } from './flowStage7';

stage1();
stage2();
stage3();
stage4();
stage5();
stage6();
stage6b();
stage7();
stage7b();

describe('coverage of Solar CRM flow diagrams.md', () => {
  it('every diagram node has an assertion', () => {
    const missing = uncovered();
    console.log(coverageTable());
    console.log(`flow coverage: ${FLOW_NODES.length - missing.length}/${FLOW_NODES.length} nodes proven by ${proofCount()} assertions; traceability written to ${writeTraceability()}`);
    expect(missing).toEqual([]);
  });
});
