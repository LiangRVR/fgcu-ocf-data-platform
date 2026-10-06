import { describe, it, expect } from "vitest";
import {
  STAGES,
  type Stage,
  deriveFlags,
  validateConsistency,
  formatApplicationLabel,
} from "@/lib/applications/pipeline";

describe("STAGES", () => {
  it("exposes the nine schema stages in order", () => {
    expect(STAGES).toEqual([
      "Started",
      "Submitted",
      "Under Review",
      "Semi-Finalist",
      "Finalist",
      "Awarded",
      "Did Not Submit",
      "Rejected",
      "Withdrawn",
    ]);
  });

  it("is a readonly tuple matching the Stage type", () => {
    const first: Stage = STAGES[0];
    expect(STAGES.length).toBe(9);
    expect(first).toBe("Started");
  });
});

describe("deriveFlags", () => {
  const cases: Array<[Stage, ReturnType<typeof deriveFlags>]> = [
    ["Started", { is_semi_finalist: false, is_finalist: false }],
    ["Submitted", { is_semi_finalist: false, is_finalist: false }],
    ["Under Review", { is_semi_finalist: false, is_finalist: false }],
    ["Did Not Submit", { is_semi_finalist: false, is_finalist: false }],
    ["Semi-Finalist", { is_semi_finalist: true, is_finalist: false }],
    ["Finalist", { is_semi_finalist: true, is_finalist: true }],
    ["Awarded", { is_semi_finalist: true, is_finalist: true }],
    ["Rejected", { is_semi_finalist: false, is_finalist: false }],
    ["Withdrawn", { is_semi_finalist: false, is_finalist: false }],
  ];

  it.each(cases)("derives consistent flags for stage %s", (stage, expected) => {
    expect(deriveFlags(stage)).toEqual(expected);
  });
});

describe("validateConsistency", () => {
  it("returns null for consistent stage/flag combinations", () => {
    expect(validateConsistency("Started", false, false)).toBeNull();
    expect(validateConsistency("Submitted", false, false)).toBeNull();
    expect(validateConsistency("Under Review", false, false)).toBeNull();
    expect(validateConsistency("Did Not Submit", false, false)).toBeNull();
    expect(validateConsistency("Rejected", false, false)).toBeNull();
    expect(validateConsistency("Withdrawn", false, false)).toBeNull();
    expect(validateConsistency("Semi-Finalist", true, false)).toBeNull();
    expect(validateConsistency("Finalist", true, true)).toBeNull();
    expect(validateConsistency("Awarded", true, true)).toBeNull();
  });

  it("returns null for every stage paired with its derived flags", () => {
    for (const stage of STAGES) {
      const flags = deriveFlags(stage);
      expect(
        validateConsistency(stage, flags.is_semi_finalist, flags.is_finalist)
      ).toBeNull();
    }
  });

  // Work 2 parity: validateConsistency must agree with deriveFlags on EVERY
  // (stage, is_semi_finalist, is_finalist) combination — exactly the domain the
  // forward-only local CHECK constraint enforces. This guards against future
  // drift between the validator and the DB invariant.
  it("agrees with deriveFlags on every possible stage/flag combination", () => {
    const booleans = [false, true] as const;
    for (const stage of STAGES) {
      for (const is_semi_finalist of booleans) {
        for (const is_finalist of booleans) {
          const expected = deriveFlags(stage);
          const invariantHolds =
            expected.is_semi_finalist === is_semi_finalist &&
            expected.is_finalist === is_finalist;
          const verdict = validateConsistency(stage, is_semi_finalist, is_finalist);
          if (invariantHolds) {
            expect(verdict, `${stage} sf=${is_semi_finalist} f=${is_finalist} must be valid`).toBeNull();
          } else {
            expect(verdict, `${stage} sf=${is_semi_finalist} f=${is_finalist} must be rejected`).not.toBeNull();
          }
        }
      }
    }
  });

  it("rejects a finalist who is not marked as a semi-finalist", () => {
    expect(validateConsistency("Finalist", false, true)).toBe(
      "A finalist must also be marked as a semi-finalist."
    );
    expect(validateConsistency("Awarded", false, true)).toBe(
      "A finalist must also be marked as a semi-finalist."
    );
  });

  it.each(["Started", "Submitted", "Under Review", "Did Not Submit", "Rejected", "Withdrawn"] as const)(
    "rejects an early stage (%s) marked as a finalist",
    (stage) => {
      expect(validateConsistency(stage, true, true)).toBe(
        `Stage "${stage}" conflicts with Finalist status. A finalist must have a stage of Finalist or Awarded.`
      );
    }
  );

  it.each(["Started", "Submitted", "Under Review", "Did Not Submit", "Rejected", "Withdrawn"] as const)(
    "rejects an early stage (%s) marked as a semi-finalist without finalist",
    (stage) => {
      expect(validateConsistency(stage, true, false)).toBe(
        `Stage "${stage}" conflicts with Semi-Finalist status. A semi-finalist must have a stage of Semi-Finalist, Finalist, or Awarded.`
      );
    }
  );

  it('rejects stage "Finalist" when the finalist flag is not checked', () => {
    expect(validateConsistency("Finalist", false, false)).toBe(
      'Stage is "Finalist" but the Finalist flag is not checked.'
    );
    expect(validateConsistency("Finalist", true, false)).toBe(
      'Stage is "Finalist" but the Finalist flag is not checked.'
    );
  });

  it('rejects stage "Semi-Finalist" when the semi-finalist flag is not checked', () => {
    expect(validateConsistency("Semi-Finalist", false, false)).toBe(
      'Stage is "Semi-Finalist" but the Semi-Finalist flag is not checked.'
    );
  });

  // Validator-consistency regression (hardening Work 2): the forward-only local
  // stage/flag invariant CHECK (and deriveFlags) require a Semi-Finalist to have
  // is_finalist = false. validateConsistency must agree, not silently accept a
  // Semi-Finalist that is also marked as a finalist.
  it('rejects stage "Semi-Finalist" when the Finalist flag is checked (a semi-finalist is not yet a finalist)', () => {
    expect(validateConsistency("Semi-Finalist", true, true)).toBe(
      'Stage is "Semi-Finalist" but the Finalist flag is checked; a semi-finalist cannot be marked as a finalist.'
    );
  });

  it('rejects stage "Awarded" when the finalist flag is not checked', () => {
    expect(validateConsistency("Awarded", false, false)).toBe(
      'Stage is "Awarded" but the Finalist flag is not checked.'
    );
    expect(validateConsistency("Awarded", true, false)).toBe(
      'Stage is "Awarded" but the Finalist flag is not checked.'
    );
  });
});

describe("formatApplicationLabel", () => {
  it("renders a cycle-aware label for a known fellowship and year", () => {
    expect(formatApplicationLabel("Fulbright", 2026)).toBe("Fulbright — 2026");
  });

  it("renders DISTINCT labels for the same fellowship across different cycle years", () => {
    // The core same-fellowship-different-cycles requirement: two applications
    // for one fellowship must never collapse into one label.
    const oldCycle = formatApplicationLabel("Fulbright", 2025);
    const newCycle = formatApplicationLabel("Fulbright", 2026);
    expect(oldCycle).toBe("Fulbright — 2025");
    expect(newCycle).toBe("Fulbright — 2026");
    expect(oldCycle).not.toBe(newCycle);
  });

  it("accepts a string year and formats it identically to a numeric year", () => {
    expect(formatApplicationLabel("Fulbright", "2026")).toBe("Fulbright — 2026");
    expect(formatApplicationLabel("Fulbright", "2026")).toBe(
      formatApplicationLabel("Fulbright", 2026)
    );
  });

  it("never guesses a legacy null year: renders 'year unknown'", () => {
    // Historic rows keep application_year NULL; the label must stay truthful.
    expect(formatApplicationLabel("Fulbright", null)).toBe("Fulbright — year unknown");
    expect(formatApplicationLabel("Fulbright", undefined)).toBe("Fulbright — year unknown");
  });

  it("renders 'Unknown fellowship — <year>' when only the year is known", () => {
    expect(formatApplicationLabel(null, 2026)).toBe("Unknown fellowship — 2026");
    expect(formatApplicationLabel(undefined, 2026)).toBe("Unknown fellowship — 2026");
  });

  it("renders 'Unknown application' when neither fellowship nor year is known", () => {
    expect(formatApplicationLabel(null, null)).toBe("Unknown application");
    expect(formatApplicationLabel(undefined, undefined)).toBe("Unknown application");
    expect(formatApplicationLabel("", "")).toBe("Unknown application");
  });

  it("treats a falsy year (0) as unknown rather than rendering '— 0'", () => {
    // A SMALLINT cycle of 0 is not a meaningful cycle; the label must fall back
    // to the unknown-year wording instead of printing a misleading "— 0".
    expect(formatApplicationLabel("Fulbright", 0)).toBe("Fulbright — year unknown");
  });
});