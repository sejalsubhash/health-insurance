/**
 * STP Eligibility Classifier — Phase 1
 *
 * Pure function. Decides whether a proposal can be straight-through processed,
 * routed to lightweight TeleMER NSTP, or full PPHC NSTP.
 *
 * Inputs:
 *   proposal — same shape as POST /api/workflow/create payload
 *   policyOverrides — the matched policy.overrides object (optional, controls per-product opt-in)
 *   stpRules — risk-params.json → stp_eligibility_rules
 *
 * Output:
 *   { eligible, route, reason, blocking_factors[], soft_flags[], applied_rules[] }
 */

const HARD_KNOCKOUT_REASONS = {
  age_too_high: 'Age exceeds STP max',
  age_too_low: 'Age below minimum entry age',
  sum_assured_too_high: 'Sum Assured exceeds STP cap',
  declared_pec: 'Declared pre-existing condition(s)',
  current_smoker: 'Current smoker',
  current_tobacco_chewer: 'Current tobacco chewer',
  occupation_hazard: 'Occupation hazard above STP threshold',
  bmi_underweight: 'Declared BMI below safe range',
  bmi_obese: 'Declared BMI in obesity range',
  alcohol_heavy: 'Heavy alcohol consumption declared',
  family_history_critical: 'Critical family history declared',
  policy_not_stp_enabled: 'Product policy does not permit STP',
  hospitalizations_declared: 'Prior hospitalizations declared',
  surgical_history_declared: 'Prior surgeries declared'
};

const CRITICAL_FAMILY_CONDITIONS = ['cancer', 'cardiac', 'multiple', 'stroke'];
const HAZARD_RANK = { none: 0, low: 1, moderate: 2, high: 3, unknown: 1 };

function evaluateSTPEligibility(proposal, policyOverrides, stpRules) {
  if (!stpRules) {
    return { eligible: false, route: 'nstp_full_pphc', reason: 'STP rules not configured', blocking_factors: ['config_missing'], soft_flags: [], applied_rules: [] };
  }

  const blocking = [];
  const softFlags = [];
  const applied = [];

  const hk = stpRules.hard_knockouts || {};
  const sf = stpRules.soft_flags_route_to_telemer || {};

  // Per-product STP opt-in (default OFF for safety)
  const policySTPEnabled = policyOverrides?.stp_eligible === true;
  if (!policySTPEnabled) {
    blocking.push({ code: 'policy_not_stp_enabled', detail: HARD_KNOCKOUT_REASONS.policy_not_stp_enabled });
    applied.push('policy.stp_eligible');
  }

  // Determine effective caps (policy overrides global)
  const maxAge = policyOverrides?.stp_max_age || hk.max_age || 45;
  const maxSA = policyOverrides?.stp_max_sa || hk.max_sum_assured || 2500000;
  const minAge = hk.min_age || 18;

  const age = parseInt(proposal.age, 10);
  const sa = parseInt(proposal.sum_assured, 10);

  // ─── Hard knockouts ───
  if (!Number.isFinite(age) || age < minAge) {
    blocking.push({ code: 'age_too_low', detail: `${HARD_KNOCKOUT_REASONS.age_too_low} (${age} < ${minAge})` });
    applied.push('hard_knockouts.min_age');
  } else if (age > maxAge) {
    blocking.push({ code: 'age_too_high', detail: `${HARD_KNOCKOUT_REASONS.age_too_high} (${age} > ${maxAge})` });
    applied.push('hard_knockouts.max_age');
  }

  if (!Number.isFinite(sa) || sa > maxSA) {
    blocking.push({ code: 'sum_assured_too_high', detail: `${HARD_KNOCKOUT_REASONS.sum_assured_too_high} (₹${sa?.toLocaleString('en-IN')} > ₹${maxSA.toLocaleString('en-IN')})` });
    applied.push('hard_knockouts.max_sum_assured');
  }

  const ls = proposal.lifestyle || {};
  const mh = proposal.medical_history || {};

  if (hk.declared_pec_blocks_stp && Array.isArray(mh.pre_existing_conditions) && mh.pre_existing_conditions.length > 0) {
    blocking.push({ code: 'declared_pec', detail: `${HARD_KNOCKOUT_REASONS.declared_pec}: ${mh.pre_existing_conditions.join(', ')}` });
    applied.push('hard_knockouts.declared_pec_blocks_stp');
  }

  if (hk.current_smoker_blocks_stp && ls.smoking === 'current') {
    blocking.push({ code: 'current_smoker', detail: HARD_KNOCKOUT_REASONS.current_smoker });
    applied.push('hard_knockouts.current_smoker_blocks_stp');
  }

  if (hk.tobacco_chewing_current_blocks_stp && ls.tobacco_chewing === 'current') {
    blocking.push({ code: 'current_tobacco_chewer', detail: HARD_KNOCKOUT_REASONS.current_tobacco_chewer });
    applied.push('hard_knockouts.tobacco_chewing_current_blocks_stp');
  }

  if (hk.occupation_hazard_min_block) {
    const minBlockRank = HAZARD_RANK[hk.occupation_hazard_min_block] || 99;
    const propRank = HAZARD_RANK[ls.occupation_hazard] ?? 1;
    if (propRank >= minBlockRank) {
      blocking.push({ code: 'occupation_hazard', detail: `${HARD_KNOCKOUT_REASONS.occupation_hazard} (${ls.occupation_hazard})` });
      applied.push('hard_knockouts.occupation_hazard_min_block');
    }
  }

  if (hk.alcohol_heavy_blocks_stp && ls.alcohol === 'heavy') {
    blocking.push({ code: 'alcohol_heavy', detail: HARD_KNOCKOUT_REASONS.alcohol_heavy });
    applied.push('hard_knockouts.alcohol_heavy_blocks_stp');
  }

  // BMI from declared values (height/weight or declared_bmi)
  let bmi = parseFloat(proposal.declared_bmi);
  if (!Number.isFinite(bmi) && proposal.height_cm && proposal.weight_kg) {
    const h = parseFloat(proposal.height_cm) / 100;
    bmi = parseFloat(proposal.weight_kg) / (h * h);
  }
  if (Number.isFinite(bmi)) {
    if (bmi < (hk.bmi_low_threshold || 17)) {
      blocking.push({ code: 'bmi_underweight', detail: `${HARD_KNOCKOUT_REASONS.bmi_underweight} (${bmi.toFixed(1)})` });
      applied.push('hard_knockouts.bmi_low_threshold');
    } else if (bmi > (hk.bmi_high_threshold || 32)) {
      blocking.push({ code: 'bmi_obese', detail: `${HARD_KNOCKOUT_REASONS.bmi_obese} (${bmi.toFixed(1)})` });
      applied.push('hard_knockouts.bmi_high_threshold');
    }
  } else {
    // BMI data missing — cannot assess body composition risk, block STP
    blocking.push({ code: 'bmi_missing', detail: 'BMI data not available — height/weight or declared BMI required for STP evaluation' });
    applied.push('hard_knockouts.bmi_missing');
  }

  if (hk.family_history_critical_blocks_stp && mh.family_history && CRITICAL_FAMILY_CONDITIONS.includes(mh.family_history)) {
    blocking.push({ code: 'family_history_critical', detail: `${HARD_KNOCKOUT_REASONS.family_history_critical} (${mh.family_history})` });
    applied.push('hard_knockouts.family_history_critical_blocks_stp');
  }

  // Hospitalizations
  const hospCount = parseInt(mh.hospitalizations, 10);
  if (Number.isFinite(hospCount) && hospCount > 0) {
    blocking.push({ code: 'hospitalizations_declared', detail: `${HARD_KNOCKOUT_REASONS.hospitalizations_declared} (${hospCount})` });
    applied.push('hard_knockouts.hospitalizations');
  }

  if (Array.isArray(mh.surgery_types) && mh.surgery_types.length > 0) {
    blocking.push({ code: 'surgical_history_declared', detail: `${HARD_KNOCKOUT_REASONS.surgical_history_declared}: ${mh.surgery_types.join(', ')}` });
    applied.push('hard_knockouts.surgical_history');
  }

  // CRM-derived flags (passed in by caller if available)
  if (proposal._crm_data) {
    if (proposal._crm_data.blacklist_flag) {
      blocking.push({ code: 'blacklisted', detail: 'Customer flagged in CRM blacklist' });
      applied.push('hard_knockouts.blacklist');
    }
    if (Array.isArray(proposal._crm_data.past_claims) && proposal._crm_data.past_claims.length > 0) {
      blocking.push({ code: 'prior_claims', detail: `${proposal._crm_data.past_claims.length} prior claim(s) on file` });
      applied.push('hard_knockouts.prior_claims');
    }
  }

  // ─── Soft flags (only matter if no hard knockouts) ───
  if (blocking.length === 0) {
    if (Number.isFinite(age) && age >= (sf.age_min || 46) && age <= (sf.age_max || 50)) {
      softFlags.push({ code: 'age_band', detail: `Age ${age} in soft-flag band ${sf.age_min}-${sf.age_max}` });
      applied.push('soft_flags.age_band');
    }
    if (Number.isFinite(sa) && sa >= (sf.sum_assured_min || 2500001) && sa <= (sf.sum_assured_max || 10000000)) {
      softFlags.push({ code: 'sa_band', detail: `SA ₹${sa.toLocaleString('en-IN')} in soft-flag band` });
      applied.push('soft_flags.sa_band');
    }
    if (Number.isFinite(bmi) && bmi >= (sf.bmi_min || 28) && bmi <= (sf.bmi_max || 32)) {
      softFlags.push({ code: 'bmi_borderline', detail: `BMI ${bmi.toFixed(1)} in soft-flag band` });
      applied.push('soft_flags.bmi_band');
    }
    if (sf.alcohol_regular && ls.alcohol === 'regular') {
      softFlags.push({ code: 'alcohol_regular', detail: 'Regular alcohol consumption' });
      applied.push('soft_flags.alcohol_regular');
    }
    if (sf.former_smoker && ls.smoking === 'former') {
      softFlags.push({ code: 'former_smoker', detail: 'Former smoker' });
      applied.push('soft_flags.former_smoker');
    }
    if (sf.family_history_non_critical && mh.family_history && mh.family_history !== 'none' && !CRITICAL_FAMILY_CONDITIONS.includes(mh.family_history)) {
      softFlags.push({ code: 'family_history_minor', detail: `Family history: ${mh.family_history}` });
      applied.push('soft_flags.family_history_non_critical');
    }
  }

  // ─── Routing decision ───
  let route, eligible, reason;
  if (blocking.length > 0) {
    eligible = false;
    route = 'nstp_full_pphc';
    reason = `STP blocked: ${blocking.map(b => b.detail).join('; ')}`;
  } else if (softFlags.length > 0) {
    eligible = false;
    route = 'nstp_telemer';
    reason = `STP soft-flagged → TeleMER NSTP: ${softFlags.map(f => f.detail).join('; ')}`;
  } else {
    eligible = true;
    route = 'stp_auto_issue';
    reason = 'All STP eligibility checks passed';
  }

  return {
    eligible,
    route,
    reason,
    blocking_factors: blocking,
    soft_flags: softFlags,
    applied_rules: applied,
    evaluated_at: new Date().toISOString()
  };
}

/**
 * Lightweight analysis — runs the rule engine against declared data only.
 * No extracted_data, no documents. Used for STP decisions where we trust declarations.
 *
 * Returns the same shape as runAIAnalysis but with analysis_mode='declared_only'.
 */
function runDeclaredDataAnalysis(proposal, riskParams, uwGuidelines, customRules, riskEngine) {
  // Build a synthetic extractedData from declared values only
  const extractedData = {
    physical_exam: {},
    blood_chemistry: {},
    hematology: {},
    urine_analysis: {},
    cardiac: {},
    telemer_data: {
      lifestyle: {
        smoking: { status: proposal.lifestyle?.smoking || 'unknown' },
        alcohol: { status: proposal.lifestyle?.alcohol || 'unknown' },
        tobacco_chewing: { status: proposal.lifestyle?.tobacco_chewing || 'unknown' },
        occupation_hazard: proposal.lifestyle?.occupation_hazard || 'unknown',
        exercise: { frequency: proposal.lifestyle?.exercise || 'unknown' }
      },
      medical_history: {
        pre_existing_conditions: (proposal.medical_history?.pre_existing_conditions || []).map(c => ({ condition: c, current_status: 'active' })),
        family_history: {
          cardiac: proposal.medical_history?.family_history === 'cardiac' || proposal.medical_history?.family_history === 'multiple',
          diabetes: proposal.medical_history?.family_history === 'diabetes' || proposal.medical_history?.family_history === 'multiple',
          cancer: proposal.medical_history?.family_history === 'cancer' || proposal.medical_history?.family_history === 'multiple'
        },
        hospitalizations: Array(parseInt(proposal.medical_history?.hospitalizations) || 0).fill({ reason: 'declared', year: new Date().getFullYear() }),
        surgical_history: (proposal.medical_history?.surgery_types || []).map(t => ({ type: t, year: new Date().getFullYear() }))
      }
    }
  };

  // Inject declared BMI
  let bmi = parseFloat(proposal.declared_bmi);
  if (!Number.isFinite(bmi) && proposal.height_cm && proposal.weight_kg) {
    const h = parseFloat(proposal.height_cm) / 100;
    bmi = parseFloat(proposal.weight_kg) / (h * h);
  }
  if (Number.isFinite(bmi)) {
    extractedData.physical_exam.bmi = { value: Math.round(bmi * 10) / 10, ref_range: '18.5-24.9', flag: bmi < 18.5 ? 'low' : bmi < 25 ? 'normal' : bmi < 30 ? 'high' : 'high', source: 'declared' };
  }
  // Mirror lifestyle for risk engine compatibility
  extractedData.lifestyle = extractedData.telemer_data.lifestyle;
  extractedData.medical_history = extractedData.telemer_data.medical_history;

  // Run risk engine
  const riskResult = riskEngine.calculateAll(extractedData, {});

  // STP re-normalization: for declared-only data, lab-dependent components (medical_parameters beyond BMI,
  // documentation_quality module coverage) are not applicable. Compute a declared-only score that weights
  // only what the customer actually declared: lifestyle + medical history + the declared-data slice of
  // medical parameters (BMI only) + a fixed full credit for clinical correlation (no documents to correlate).
  const comps = riskResult.risk_score.components;
  const declaredBmiScore = comps.medical_parameters?.breakdown?.bmi?.score || 0;
  const declaredBmiMax = comps.medical_parameters?.breakdown?.bmi?.max || 5;
  const lifestyleScore = comps.lifestyle_risk?.score || 0;
  const lifestyleMax = comps.lifestyle_risk?.max || 20;
  const historyScore = comps.medical_history?.score || 0;
  const historyMax = comps.medical_history?.max || 15;
  // For declared-only, clinical correlation is N/A — treat as "no issues found" since nothing to correlate
  const correlationScore = 15;
  const correlationMax = 15;

  const declaredTotal = declaredBmiScore + lifestyleScore + historyScore + correlationScore;
  const declaredMax = declaredBmiMax + lifestyleMax + historyMax + correlationMax; // 5 + 20 + 15 + 15 = 55
  const declaredNormalized = Math.round((declaredTotal / declaredMax) * 100 * 100) / 100;

  let declaredGrade;
  if (declaredNormalized >= 90) declaredGrade = 'A+';
  else if (declaredNormalized >= 80) declaredGrade = 'A';
  else if (declaredNormalized >= 70) declaredGrade = 'B+';
  else if (declaredNormalized >= 60) declaredGrade = 'B';
  else if (declaredNormalized >= 50) declaredGrade = 'C';
  else declaredGrade = 'D';

  const declaredRiskScore = {
    total: Math.round(declaredTotal * 100) / 100,
    max: declaredMax,
    normalized: declaredNormalized,
    grade: declaredGrade,
    components: {
      declared_bmi: { score: declaredBmiScore, max: declaredBmiMax },
      lifestyle_risk: { score: lifestyleScore, max: lifestyleMax },
      medical_history: { score: historyScore, max: historyMax },
      clinical_correlation_na: { score: correlationScore, max: correlationMax, note: 'Full credit — no documents to correlate on declared-only analysis' }
    },
    scoring_mode: 'declared_only_renormalized'
  };

  // Walk rules — declared-only mode skips parameter rules where the value is null
  const allRules = [...(uwGuidelines.rules || []), ...(customRules || [])];
  const violations = [];
  const warnings = [];
  for (const rule of allRules) {
    if (rule._disabled || !rule.path || !rule.operator) continue;
    let value;
    try { const parts = rule.path.split('.'); value = extractedData; for (const p of parts) value = value?.[p]; } catch (e) { value = null; }
    if (value === null || value === undefined) continue; // skip — no data
    let violated = false;
    switch (rule.operator) {
      case '<': violated = !(value < rule.threshold); break;
      case '<=': violated = !(value <= rule.threshold); break;
      case '>': violated = !(value > rule.threshold); break;
      case '>=': violated = !(value >= rule.threshold); break;
      case '==': violated = value !== rule.threshold; break;
      case 'in': violated = Array.isArray(rule.threshold) && !rule.threshold.includes(value); break;
    }
    if (violated) {
      const item = { rule_id: rule.id, rule_name: rule.name, value, threshold: rule.threshold, action: rule.action, severity: rule.severity };
      if (rule.severity === 'critical') violations.push(item);
      else warnings.push(item);
    }
  }

  const recommendation = declaredNormalized >= 80 ? 'accept_standard' : declaredNormalized >= 65 ? 'accept_with_loading' : 'refer';

  return {
    analysis_mode: 'declared_only',
    recommendation,
    risk_score: declaredRiskScore,
    full_risk_score_reference: riskResult.risk_score, // kept for audit — the unadjusted score
    decision: { recommendation, loading_percentage: 0, exclusions: [], rationale: `Declared-only scoring: ${declaredNormalized}/100 from lifestyle + history + declared BMI` },
    guidelines_compliance: { violations, warnings, total_rules_checked: allRules.filter(r => !r._disabled && r.path).length },
    findings: [],
    loading_percentage: 0,
    loading_factors: [],
    rationale: `Declared-data analysis: renormalized score ${declaredNormalized}/100 (${declaredGrade}), ${violations.length} violations, ${warnings.length} warnings`,
    analyzed_at: new Date().toISOString()
  };
}

module.exports = { evaluateSTPEligibility, runDeclaredDataAnalysis, HARD_KNOCKOUT_REASONS };
