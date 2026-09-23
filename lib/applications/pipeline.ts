// Valid stages from the schema CHECK constraint
const STAGES = [
  "Started",
  "Submitted",
  "Under Review",
  "Semi-Finalist",
  "Finalist",
  "Awarded",
  "Rejected",
] as const;

type Stage = (typeof STAGES)[number];

// Derive which boolean flags are consistent with a given stage
function deriveFlags(stage: Stage): { is_semi_finalist: boolean; is_finalist: boolean } {
  if (stage === "Finalist" || stage === "Awarded") {
    return { is_semi_finalist: true, is_finalist: true };
  }
  if (stage === "Semi-Finalist") {
    return { is_semi_finalist: true, is_finalist: false };
  }
  return { is_semi_finalist: false, is_finalist: false };
}

// Validate that stage and boolean flags are internally consistent.
// Returns an error string or null if valid.
function validateConsistency(
  stage: string,
  is_semi_finalist: boolean,
  is_finalist: boolean
): string | null {
  const earlyStages = ["Started", "Submitted", "Under Review", "Rejected"];

  if (is_finalist && !is_semi_finalist) {
    return "A finalist must also be marked as a semi-finalist.";
  }
  if (is_finalist && earlyStages.includes(stage)) {
    return `Stage "${stage}" conflicts with Finalist status. A finalist must have a stage of Finalist or Awarded.`;
  }
  if (is_semi_finalist && earlyStages.includes(stage)) {
    return `Stage "${stage}" conflicts with Semi-Finalist status. A semi-finalist must have a stage of Semi-Finalist, Finalist, or Awarded.`;
  }
  if (stage === "Finalist" && !is_finalist) {
    return 'Stage is "Finalist" but the Finalist flag is not checked.';
  }
  if (stage === "Semi-Finalist" && !is_semi_finalist) {
    return 'Stage is "Semi-Finalist" but the Semi-Finalist flag is not checked.';
  }
  if (stage === "Awarded" && !is_finalist) {
    return 'Stage is "Awarded" but the Finalist flag is not checked.';
  }
  return null;
}

export { STAGES, type Stage, deriveFlags, validateConsistency };