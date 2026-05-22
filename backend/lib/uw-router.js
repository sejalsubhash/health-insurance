/**
 * UW Router — Phase 2
 *
 * Two responsibilities:
 *   1. classifyCaseSpecialty(workflow) — assigns a primary specialty and complexity score
 *   2. assignToUnderwriter(workflow, users, tiers) — picks the right UW based on authority + specialty + load
 *
 * Pure functions. Storage/IO lives in server.js and s3-client.
 */

const fs = require('fs');
const path = require('path');

// ─── Specialty classification ───
// Maps dotted paths (as used in findings/violations/extracted_data) to specialties.
const PATH_TO_SPECIALTY = {
  // Cardiac
  'cardiac.': 'cardiac',
  'cardiac_extended.': 'cardiac',
  'physical_exam.blood_pressure.': 'cardiac',
  // Renal
  'blood_chemistry.serum_creatinine': 'renal',
  'blood_chemistry.blood_urea': 'renal',
  'blood_chemistry.egfr': 'renal',
  'urine_analysis.protein': 'renal',
  'urine_analysis.microalbumin': 'renal',
  'urine_analysis.acr': 'renal',
  // Hepatic
  'blood_chemistry.sgot_ast': 'hepatic',
  'blood_chemistry.sgpt_alt': 'hepatic',
  'blood_chemistry.total_bilirubin': 'hepatic',
  'blood_chemistry.albumin': 'hepatic',
  'liver_extended.': 'hepatic',
  // Metabolic
  'blood_chemistry.fasting_glucose': 'metabolic',
  'blood_chemistry.hba1c': 'metabolic',
  'blood_chemistry.total_cholesterol': 'metabolic',
  'blood_chemistry.ldl': 'metabolic',
  'blood_chemistry.triglycerides': 'metabolic',
  'blood_chemistry.tc_hdl_ratio': 'metabolic',
  'physical_exam.bmi': 'metabolic',
  'thyroid.': 'metabolic'
};

// Finding parameter name → specialty (for freeform findings without a strict path)
const FINDING_NAME_TO_SPECIALTY = {
  'BMI': 'metabolic',
  'Blood Pressure': 'cardiac',
  'Fasting Glucose': 'metabolic',
  'HbA1c': 'metabolic',
  'TC/HDL Ratio': 'metabolic',
  'SGPT/ALT': 'hepatic',
  'SGOT/AST': 'hepatic',
  'GGT': 'hepatic',
  'TSH': 'metabolic',
  'LVEF': 'cardiac',
  'ECG': 'cardiac',
  'TMT/Stress Test': 'cardiac',
  'Chest X-Ray': 'cardiac',
  'Serum Creatinine': 'renal',
  'CV Risk (Framingham)': 'cardiac',
  'Hemoglobin': 'general',
  'Age Factor': 'general',
  'Pre-existing: Cancer History': 'oncology',
  'Pre-existing: Heart Disease': 'cardiac',
  'Pre-existing: Diabetes': 'metabolic',
  'Pre-existing: Hypertension': 'cardiac',
  'Pre-existing: Kidney Disease': 'renal',
  'Pre-existing: Liver Disease': 'hepatic',
  'Pre-existing: Thyroid Disorder': 'metabolic',
  'Pre-existing: Asthma/COPD': 'general'
};

function pathToSpecialty(path) {
  if (!path) return 'general';
  // Longest prefix match
  let bestMatch = 'general';
  let bestLen = 0;
  for (const [prefix, specialty] of Object.entries(PATH_TO_SPECIALTY)) {
    if (path.startsWith(prefix) && prefix.length > bestLen) {
      bestMatch = specialty;
      bestLen = prefix.length;
    }
  }
  return bestMatch;
}

function findingNameToSpecialty(name) {
  if (!name) return 'general';
  // Strip "(Declared)" / "(Measured)" / etc. suffixes
  const base = name.replace(/\s*\(.*?\)\s*/g, '').trim();
  if (FINDING_NAME_TO_SPECIALTY[base]) return FINDING_NAME_TO_SPECIALTY[base];
  // Pre-existing fuzzy match
  for (const [key, spec] of Object.entries(FINDING_NAME_TO_SPECIALTY)) {
    if (base.toLowerCase().includes(key.toLowerCase())) return spec;
  }
  return 'general';
}

function loadTiers() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'uw-tiers.json'), 'utf8'));
  } catch (e) {
    console.error('[UW Router] Failed to load uw-tiers.json:', e.message);
    return null;
  }
}

/**
 * classifyCaseSpecialty(workflow) → { primary_specialty, secondary_specialties, complexity_score, recommended_tier, signals }
 */
function classifyCaseSpecialty(workflow, tiersConfig) {
  const tiers = tiersConfig || loadTiers();
  const config = tiers?.complexity_scoring || { violations_weight: 15, loading_weight: 0.5, specialty_count_weight: 10, sa_tier_weight: 5, max_score: 100 };

  const analysis = workflow.ai_analysis || {};
  const findings = analysis.findings || [];
  const violations = analysis.guidelines_compliance?.violations || [];
  const warnings = analysis.guidelines_compliance?.warnings || [];
  const loadingPct = analysis.loading_percentage || 0;
  const sa = workflow.sum_assured || 0;

  // Collect specialty signals from findings, violations, and declared conditions
  const specialtyCounts = { general: 0, cardiac: 0, renal: 0, hepatic: 0, metabolic: 0, oncology: 0, neurological: 0 };
  const signals = [];

  // Findings
  for (const f of findings) {
    const spec = findingNameToSpecialty(f.parameter);
    specialtyCounts[spec] = (specialtyCounts[spec] || 0) + (f.status === 'high' || f.status === 'abnormal' ? 3 : 1);
    if (spec !== 'general') signals.push({ source: 'finding', parameter: f.parameter, specialty: spec, status: f.status });
  }

  // Violations (weighted higher — these are the drivers)
  for (const v of violations) {
    const spec = pathToSpecialty(v.path || '');
    specialtyCounts[spec] = (specialtyCounts[spec] || 0) + 5;
    if (spec !== 'general') signals.push({ source: 'violation', rule: v.rule_name, specialty: spec, severity: v.severity });
  }

  // Warnings (half weight)
  for (const w of warnings) {
    const spec = pathToSpecialty(w.path || '');
    specialtyCounts[spec] = (specialtyCounts[spec] || 0) + 2;
  }

  // Declared pre-existing conditions (strong signal)
  const pecs = workflow.medical_history?.pre_existing_conditions || [];
  const pecMap = { diabetes: 'metabolic', hypertension: 'cardiac', cardiac: 'cardiac', thyroid: 'metabolic', kidney: 'renal', liver: 'hepatic', cancer: 'oncology', asthma: 'general' };
  for (const c of pecs) {
    const spec = pecMap[c] || 'general';
    specialtyCounts[spec] = (specialtyCounts[spec] || 0) + 4;
    signals.push({ source: 'declared_pec', condition: c, specialty: spec });
  }

  // Pick primary (highest count; tie-break: non-general wins)
  let primary = 'general';
  let primaryScore = 0;
  for (const [spec, count] of Object.entries(specialtyCounts)) {
    if (count > primaryScore || (count === primaryScore && primary === 'general' && spec !== 'general')) {
      primary = spec;
      primaryScore = count;
    }
  }

  // Secondaries: any non-primary specialty with ≥3 signal points
  const secondaries = Object.entries(specialtyCounts)
    .filter(([s, c]) => s !== primary && s !== 'general' && c >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);

  // Complexity score
  const violationScore = Math.min(violations.length * config.violations_weight, 60);
  const loadingScore = Math.min(loadingPct * config.loading_weight, 30);
  const specialtyScore = Math.min(secondaries.length * config.specialty_count_weight, 30);
  const saTier = sa <= 2500000 ? 0 : sa <= 10000000 ? config.sa_tier_weight : sa <= 50000000 ? config.sa_tier_weight * 2 : config.sa_tier_weight * 4;
  const complexity = Math.min(violationScore + loadingScore + specialtyScore + saTier, config.max_score);

  // Recommended tier from complexity + SA. Specialty filtering is enforced at assignment time, not here.
  const thresholds = tiers?.recommended_tier_thresholds || { junior_max_complexity: 30, senior_max_complexity: 60, chief_max_complexity: 85 };
  let recommendedTier;
  if (primary === 'oncology' || violations.some(v => v.severity === 'critical')) {
    recommendedTier = 'medical_officer';
  } else if (sa > 50000000) {
    recommendedTier = 'medical_officer';
  } else if (complexity <= thresholds.junior_max_complexity && sa <= 2500000) {
    recommendedTier = 'junior';
  } else if (complexity <= thresholds.senior_max_complexity && sa <= 10000000) {
    recommendedTier = 'senior';
  } else if (complexity <= thresholds.chief_max_complexity && sa <= 50000000) {
    recommendedTier = 'chief';
  } else {
    recommendedTier = 'medical_officer';
  }

  return {
    primary_specialty: primary,
    secondary_specialties: secondaries,
    complexity_score: Math.round(complexity),
    recommended_tier: recommendedTier,
    signals: signals.slice(0, 20),  // cap for audit log size
    scoring_breakdown: { violations: violationScore, loading: loadingScore, specialty_count: specialtyScore, sa_tier: saTier },
    classified_at: new Date().toISOString()
  };
}

/**
 * assignToUnderwriter(workflow, users, tiersConfig, currentLoadMap)
 *
 * users: array of user records from s3Client.getUsers()
 * currentLoadMap: { [email]: activeCaseCount } computed by caller
 *
 * Returns { success, assigned_email, assigned_tier, classification, reason, alternates }
 */
function assignToUnderwriter(workflow, users, tiersConfig, currentLoadMap) {
  const tiers = tiersConfig || loadTiers();
  if (!tiers) return { success: false, reason: 'UW tiers config not available', classification: null };

  const classification = classifyCaseSpecialty(workflow, tiers);
  const loading = workflow.ai_analysis?.loading_percentage || 0;
  const sa = workflow.sum_assured || 0;

  // Tier ranks for escalation
  const tierRank = {};
  for (const [key, def] of Object.entries(tiers.tiers)) tierRank[key] = def.rank;

  // Filter to UW-role users
  const uwRoles = new Set(['UW Admin', 'Junior UW', 'Senior UW', 'Chief UW', 'Medical Officer', 'UW']);
  const candidates = (users || []).filter(u =>
    u.status === 'active' &&
    (uwRoles.has(u.role) || u.authority_tier) &&
    !u.out_of_office_until &&
    u.email !== (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase()  // don't auto-assign to super admin
  );

  if (candidates.length === 0) {
    return { success: false, reason: 'No active underwriters available', classification, alternates: [] };
  }

  // Score each candidate
  const scored = [];
  for (const u of candidates) {
    const tier = u.authority_tier || 'junior';
    const tierDef = tiers.tiers[tier];
    if (!tierDef) continue;

    // Enforce authority limits (use user's record first, tier default as fallback)
    const userSaLimit = u.authority_limit_sa || tierDef.authority_limit_sa;
    const userLoadingLimit = u.authority_limit_loading_pct || tierDef.authority_limit_loading_pct;
    const userMaxConcurrent = u.max_concurrent_cases || tierDef.max_concurrent_cases;
    const allowedSpecs = u.specialties || tierDef.allowed_specialties;

    // Hard gates
    if (sa > userSaLimit) continue;
    if (loading > userLoadingLimit) continue;
    if (!allowedSpecs.includes(classification.primary_specialty)) continue;

    // Load check
    const currentLoad = currentLoadMap?.[u.email.toLowerCase()] || 0;
    if (currentLoad >= userMaxConcurrent) continue;

    // Tier match: prefer lowest-tier that qualifies for the recommended tier
    const userRank = tierRank[tier] || 1;
    const recommendedRank = tierRank[classification.recommended_tier] || 1;
    if (userRank < recommendedRank) continue;  // not qualified — escalation will find a higher tier

    // Score: lower is better. Prefer matching rank over over-qualified, prefer least-loaded.
    const rankPenalty = (userRank - recommendedRank) * 100;  // prefer exact tier match
    const loadPenalty = currentLoad * 10;
    scored.push({ user: u, tier, tierDef, currentLoad, rankPenalty, loadPenalty, total: rankPenalty + loadPenalty });
  }

  if (scored.length === 0) {
    // Escalate: try again with any higher-tier that accepts the case regardless of recommended tier match
    for (const u of candidates) {
      const tier = u.authority_tier || 'junior';
      const tierDef = tiers.tiers[tier];
      if (!tierDef) continue;
      const userSaLimit = u.authority_limit_sa || tierDef.authority_limit_sa;
      const userLoadingLimit = u.authority_limit_loading_pct || tierDef.authority_limit_loading_pct;
      const userMaxConcurrent = u.max_concurrent_cases || tierDef.max_concurrent_cases;
      const allowedSpecs = u.specialties || tierDef.allowed_specialties;
      if (sa > userSaLimit) continue;
      if (loading > userLoadingLimit) continue;
      if (!allowedSpecs.includes(classification.primary_specialty) && !allowedSpecs.includes('general')) continue;
      const currentLoad = currentLoadMap?.[u.email.toLowerCase()] || 0;
      if (currentLoad >= userMaxConcurrent) continue;
      scored.push({ user: u, tier, tierDef, currentLoad, rankPenalty: 0, loadPenalty: currentLoad * 10, total: currentLoad * 10, escalated: true });
    }
  }

  if (scored.length === 0) {
    return { success: false, reason: `No underwriter found with authority_limit_sa ≥ ₹${sa}, authority_limit_loading_pct ≥ ${loading}%, specialty '${classification.primary_specialty}', and available capacity`, classification, alternates: [] };
  }

  // Sort ascending by total score
  scored.sort((a, b) => a.total - b.total);
  const winner = scored[0];
  const alternates = scored.slice(1, 4).map(s => ({ email: s.user.email, tier: s.tier, current_load: s.currentLoad }));

  return {
    success: true,
    assigned_email: winner.user.email,
    assigned_name: winner.user.name,
    assigned_tier: winner.tier,
    assigned_at: new Date().toISOString(),
    current_load_before: winner.currentLoad,
    classification,
    reason: winner.escalated
      ? `Escalated assignment to ${winner.tier} (${winner.user.email}) — no lower tier available`
      : `Assigned to ${winner.tier} ${winner.user.email} (complexity ${classification.complexity_score}, specialty ${classification.primary_specialty}, current load ${winner.currentLoad})`,
    alternates
  };
}

module.exports = {
  classifyCaseSpecialty,
  assignToUnderwriter,
  loadTiers,
  pathToSpecialty,
  findingNameToSpecialty
};
