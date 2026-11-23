# Oracle Mutation Testing Report

**Generated:** 2026-09-29T18:04:15.128Z  
**Scope:** Critical Financial & Consensus Modules (`src/aggregator/threshold.ts`, `src/aggregator/bond-reconciliation.ts`)  
**Target Mutation Score:** >= 90%  
**Achieved Mutation Score:** **96%** (27/28 mutants killed)  

## Executive Summary

Mutation testing verifies that test assertions are capable of detecting synthetic bugs, guarding against untested execution paths and regressions in critical financial workflows.

| Metric | Value |
| :--- | :--- |
| **Total Mutants Evaluated** | 28 |
| **Mutants Killed** | 27 |
| **Mutants Survived** | 1 |
| **Mutation Score** | **96%** |
| **Target Score Threshold** | 90% |
| **Status** | PASSED |

## Detailed Mutant Results

| ID | File | Category | Description | Status |
| :--- | :--- | :--- | :--- | :--- |
| TH-01 | `src/aggregator/threshold.ts` | boundary | Relax non-positive threshold check from <= 0 to < 0 (permits threshold 0) | KILLED |
| TH-02 | `src/aggregator/threshold.ts` | conditional | Bypass integer check on threshold (permits floats) | KILLED |
| TH-03 | `src/aggregator/threshold.ts` | statement | Do not trim member identifiers | KILLED |
| TH-04 | `src/aggregator/threshold.ts` | conditional | Allow blank member identifiers into vote map | **SURVIVED** |
| TH-05 | `src/aggregator/threshold.ts` | arithmetic | Invert tally counter increment logic (increment no on outcome true) | KILLED |
| TH-06 | `src/aggregator/threshold.ts` | boundary | Mutate yes threshold boundary from >= to > (strictly greater) | KILLED |
| TH-07 | `src/aggregator/threshold.ts` | boundary | Mutate yes threshold boundary from >= to === (exact match only) | KILLED |
| TH-08 | `src/aggregator/threshold.ts` | boundary | Mutate no threshold boundary from >= to > (strictly greater) | KILLED |
| TH-09 | `src/aggregator/threshold.ts` | boundary | Mutate no threshold boundary from >= to === (exact match only) | KILLED |
| TH-10 | `src/aggregator/threshold.ts` | logical | Mutate ambiguity condition from yesReached === noReached to yesReached && noReached | KILLED |
| TH-11 | `src/aggregator/threshold.ts` | conditional | Invert ternary selection: return yesReached on ambiguous and null on unambiguous | KILLED |
| TH-12 | `src/aggregator/threshold.ts` | statement | Omit logging vote tally details | KILLED |
| TH-13 | `src/aggregator/threshold.ts` | assignment | Remove null fallback for undefined marketId in logger payload | KILLED |
| BR-01 | `src/aggregator/bond-reconciliation.ts` | conditional | Invert settlement membership check in reconcileBonds (!settled -> settled) | KILLED |
| BR-02 | `src/aggregator/bond-reconciliation.ts` | assignment | Zero out expectedAmount in discrepancies | KILLED |
| BR-03 | `src/aggregator/bond-reconciliation.ts` | assignment | Blank submitter in discrepancies | KILLED |
| BR-04 | `src/aggregator/bond-reconciliation.ts` | assignment | Hardcode discrepancy status to finalized (ignoring cancelled/expired) | KILLED |
| BR-05 | `src/aggregator/bond-reconciliation.ts` | assignment | Corrupt finalizedAt date in discrepancies | KILLED |
| BR-06 | `src/aggregator/bond-reconciliation.ts` | statement | Do not execute onDiscrepancy callback in runBondReconciliation | KILLED |
| BR-07 | `src/aggregator/bond-reconciliation.ts` | statement | Omit discrepancy warning log in runBondReconciliation | KILLED |
| BR-08 | `src/aggregator/bond-reconciliation.ts` | statement | Omit completion info log in runBondReconciliation | KILLED |
| BR-09 | `src/aggregator/bond-reconciliation.ts` | conditional | Mutate recordSettlement return logic to always return true (bypassing conflict detection) | KILLED |
| BR-10 | `src/aggregator/bond-reconciliation.ts` | conditional | Mutate recordSettlement return logic to always return false | KILLED |
| BR-11 | `src/aggregator/bond-reconciliation.ts` | assignment | Swap marketId and recipient parameter bindings in recordSettlement query | KILLED |
| BR-12 | `src/aggregator/bond-reconciliation.ts` | assignment | Bind zero string for amount in recordSettlement query | KILLED |
| BR-13 | `src/aggregator/bond-reconciliation.ts` | assignment | Zero out checkedCount in runBondReconciliation summary result | KILLED |
| BR-14 | `src/aggregator/bond-reconciliation.ts` | assignment | Zero out settledCount in runBondReconciliation summary result | KILLED |
| BR-15 | `src/aggregator/bond-reconciliation.ts` | conditional | Narrow SQL status filter in oracle_submissions query to only finalized | KILLED |

### Surviving Mutants Details

#### TH-04: Allow blank member identifiers into vote map
- **File:** `src/aggregator/threshold.ts`
- **Original Code:**
```ts
if (member) votesByMember.set(member, vote.outcome);
```
- **Mutated Code:**
```ts
votesByMember.set(member, vote.outcome);
```
- **Recommendation:** Add explicit assertions in `test/threshold.test.ts` to catch this bug.


## Target Score Rationale

A target mutation score of **90%** is established for the oracle's consensus and settlement modules. Because bond refund reconciliation and vote threshold aggregation manage economic value and protocol finality, test suites must verify exact boundaries, object payloads, and error conditions rather than merely executing code paths.
