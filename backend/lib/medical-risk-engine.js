/**
 * Medical Risk Engine — Insurance Underwriting
 * Replaces calculation-engine.js from MSME lending platform
 * 
 * Health Risk Score (100-point scale) with 5 components:
 *   Medical Parameters (35 pts) — blood chemistry, vitals, BMI
 *   Lifestyle Risk (20 pts) — smoking, alcohol, occupation hazard
 *   Medical History (15 pts) — pre-existing conditions, family history
 *   Clinical Correlation (15 pts) — multi-system findings, drug-condition matches
 *   Documentation Quality (15 pts) — report completeness, consistency
 *
 * Grade: A+ (>=90), A (>=80), B+ (>=70), B (>=60), C (>=50), D (<50)
 * Decision: Accept Standard (>=80), Accept with Loading (65-79), Refer (50-64), Decline (<50)
 */

const fs = require('fs');
const path = require('path');

// Load configurable masters
function loadConfig(filename) {
  const configPath = path.join(__dirname, '..', 'config', filename);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Config load error ${filename}:`, e.message);
    return null;
  }
}

// ─── Component Evaluators ───

function evaluateMetric(value, thresholds, maxScore) {
  if (value === null || value === undefined) {
    return { score: 0, max: maxScore, logic: 'Not available', status: 'missing' };
  }

  // thresholds: { excellent: x, good: y, fair: z, poor: w, operator: '>|<|range' }
  const op = thresholds.operator || '>';
  let level = 'poor';

  if (op === '>') {
    if (value >= thresholds.excellent) level = 'excellent';
    else if (value >= thresholds.good) level = 'good';
    else if (value >= thresholds.fair) level = 'fair';
    else level = 'poor';
  } else if (op === '<') {
    if (value <= thresholds.excellent) level = 'excellent';
    else if (value <= thresholds.good) level = 'good';
    else if (value <= thresholds.fair) level = 'fair';
    else level = 'poor';
  } else if (op === 'range') {
    const mid = (thresholds.range_low + thresholds.range_high) / 2;
    const deviation = Math.abs(value - mid) / (thresholds.range_high - thresholds.range_low);
    if (deviation <= 0.2) level = 'excellent';
    else if (deviation <= 0.4) level = 'good';
    else if (deviation <= 0.7) level = 'fair';
    else level = 'poor';
  }

  const scoreMap = { excellent: 1.0, good: 0.75, fair: 0.5, poor: 0.25 };
  const score = Math.round(maxScore * scoreMap[level] * 100) / 100;

  return {
    score,
    max: maxScore,
    logic: `${value} → ${level} (${score}/${maxScore})`,
    status: level
  };
}

// Component 1: Medical Parameters (35 pts)
function scoreMedicalParameters(extractedData) {
  const config = loadConfig('medical-scoring.json');
  const weights = config?.components?.medical_parameters?.metrics || {};
  const results = {};
  let totalScore = 0;
  const maxTotal = 35;

  const bloodChem = extractedData?.blood_chemistry || {};
  const hematology = extractedData?.hematology || {};
  const physicalExam = extractedData?.physical_exam || {};
  const cardiac = extractedData?.cardiac || {};

  // BMI (5 pts)
  const bmi = physicalExam?.bmi?.value || null;
  results.bmi = evaluateMetric(bmi, { excellent: 22, good: 18.5, fair: 25, poor: 30, operator: 'range', range_low: 18.5, range_high: 24.9 }, 5);

  // Blood Pressure (5 pts)
  const systolic = physicalExam?.blood_pressure?.systolic?.value || null;
  results.blood_pressure = evaluateMetric(systolic, { excellent: 120, good: 130, fair: 140, poor: 160, operator: '<' }, 5);

  // Fasting Glucose (4 pts)
  const glucose = bloodChem?.fasting_glucose?.value || null;
  results.fasting_glucose = evaluateMetric(glucose, { excellent: 100, good: 110, fair: 126, poor: 200, operator: '<' }, 4);

  // HbA1c (4 pts)
  const hba1c = bloodChem?.hba1c?.value || null;
  results.hba1c = evaluateMetric(hba1c, { excellent: 5.6, good: 6.0, fair: 6.5, poor: 8.0, operator: '<' }, 4);

  // Lipid Profile — TC/HDL Ratio (3 pts)
  const tcHdl = bloodChem?.tc_hdl_ratio?.value || null;
  results.tc_hdl_ratio = evaluateMetric(tcHdl, { excellent: 3.5, good: 4.5, fair: 5.5, poor: 7.0, operator: '<' }, 3);

  // Liver Function — SGPT (3 pts)
  const sgpt = bloodChem?.sgpt_alt?.value || null;
  results.sgpt = evaluateMetric(sgpt, { excellent: 40, good: 56, fair: 80, poor: 120, operator: '<' }, 3);

  // Kidney Function — Creatinine (3 pts)
  const creat = bloodChem?.serum_creatinine?.value || null;
  results.creatinine = evaluateMetric(creat, { excellent: 1.0, good: 1.3, fair: 1.5, poor: 2.0, operator: '<' }, 3);

  // ECG (4 pts)
  const ecgInterpretation = cardiac?.ecg?.overall_interpretation || null;
  const ecgScore = ecgInterpretation === 'normal' ? 4 : ecgInterpretation === 'borderline' ? 2 : ecgInterpretation === 'abnormal' ? 1 : 0;
  results.ecg = { score: ecgScore, max: 4, logic: `ECG: ${ecgInterpretation || 'N/A'} → ${ecgScore}/4`, status: ecgInterpretation || 'missing' };

  // Hemoglobin (2 pts)
  const hb = hematology?.hemoglobin?.value || null;
  results.hemoglobin = evaluateMetric(hb, { excellent: 14, good: 13, fair: 11, poor: 9, operator: '>' }, 2);

  // Urine Protein (2 pts)
  const urineProtein = extractedData?.urine_analysis?.protein?.value || null;
  const upScore = (urineProtein === 'nil' || urineProtein === 'negative' || urineProtein === 'trace') ? 2 : urineProtein === null ? 0 : 0.5;
  results.urine_protein = { score: upScore, max: 2, logic: `Urine Protein: ${urineProtein || 'N/A'} → ${upScore}/2`, status: urineProtein || 'missing' };

  for (const key in results) {
    totalScore += results[key].score;
  }

  return { score: Math.min(totalScore, maxTotal), max: maxTotal, breakdown: results };
}

// Component 2: Lifestyle Risk (20 pts)
function scoreLifestyleRisk(extractedData) {
  const results = {};
  let totalScore = 0;
  const maxTotal = 20;

  const lifestyle = extractedData?.telemer_data?.lifestyle || extractedData?.lifestyle || {};

  // Smoking (7 pts) — highest impact
  const smoking = lifestyle?.smoking?.status || 'unknown';
  const smokingScore = smoking === 'never' ? 7 : smoking === 'former' ? 4 : smoking === 'current' ? 1 : 3;
  results.smoking = { score: smokingScore, max: 7, logic: `Smoking: ${smoking} → ${smokingScore}/7`, status: smoking };

  // Alcohol (5 pts)
  const alcohol = lifestyle?.alcohol?.status || 'unknown';
  const alcoholScore = alcohol === 'never' ? 5 : alcohol === 'occasional' ? 4 : alcohol === 'regular' ? 2 : alcohol === 'heavy' ? 0.5 : 3;
  results.alcohol = { score: alcoholScore, max: 5, logic: `Alcohol: ${alcohol} → ${alcoholScore}/5`, status: alcohol };

  // Tobacco Chewing (3 pts)
  const tobacco = lifestyle?.tobacco_chewing?.status || 'unknown';
  const tobaccoScore = tobacco === 'never' ? 3 : tobacco === 'former' ? 1.5 : tobacco === 'current' ? 0.5 : 2;
  results.tobacco_chewing = { score: tobaccoScore, max: 3, logic: `Tobacco: ${tobacco} → ${tobaccoScore}/3`, status: tobacco };

  // Occupation Hazard (3 pts)
  const hazard = lifestyle?.occupation_hazard || 'unknown';
  const hazardScore = hazard === 'none' ? 3 : hazard === 'low' ? 2.5 : hazard === 'moderate' ? 1.5 : hazard === 'high' ? 0.5 : 2;
  results.occupation_hazard = { score: hazardScore, max: 3, logic: `Occupation Hazard: ${hazard} → ${hazardScore}/3`, status: hazard };

  // Exercise (2 pts)
  const exercise = lifestyle?.exercise?.frequency || 'unknown';
  const exerciseScore = exercise === 'daily' ? 2 : exercise === 'regular' ? 1.5 : exercise === 'occasional' ? 1 : exercise === 'none' ? 0.5 : 1;
  results.exercise = { score: exerciseScore, max: 2, logic: `Exercise: ${exercise} → ${exerciseScore}/2`, status: exercise };

  for (const key in results) {
    totalScore += results[key].score;
  }

  return { score: Math.min(totalScore, maxTotal), max: maxTotal, breakdown: results };
}

// Component 3: Medical History (15 pts)
function scoreMedicalHistory(extractedData) {
  const results = {};
  let totalScore = 0;
  const maxTotal = 15;

  const history = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};

  // Pre-existing Conditions (7 pts)
  const conditions = history?.pre_existing_conditions || [];
  const activeConditions = conditions.filter(c => c.current_status === 'active' || c.current_status === 'poorly_controlled');
  const condScore = conditions.length === 0 ? 7 : activeConditions.length === 0 ? 5 : activeConditions.length <= 2 ? 3 : 1;
  results.pre_existing = { score: condScore, max: 7, logic: `${conditions.length} conditions (${activeConditions.length} active) → ${condScore}/7`, status: conditions.length === 0 ? 'none' : `${conditions.length} found` };

  // Family History (4 pts)
  const family = history?.family_history || {};
  const familyRisks = ['cardiac', 'diabetes', 'cancer', 'stroke'].filter(k => family[k] === true);
  const famScore = familyRisks.length === 0 ? 4 : familyRisks.length === 1 ? 3 : familyRisks.length === 2 ? 2 : 1;
  results.family_history = { score: famScore, max: 4, logic: `${familyRisks.length} family risk factors → ${famScore}/4`, status: familyRisks.length === 0 ? 'clean' : familyRisks.join(', ') };

  // Hospitalizations (2 pts)
  const hospitalizations = history?.hospitalizations || [];
  const hospScore = hospitalizations.length === 0 ? 2 : hospitalizations.length <= 2 ? 1 : 0.5;
  results.hospitalizations = { score: hospScore, max: 2, logic: `${hospitalizations.length} hospitalizations → ${hospScore}/2`, status: `${hospitalizations.length} events` };

  // Surgical History (2 pts)
  const surgeries = history?.surgical_history || [];
  const surgScore = surgeries.length === 0 ? 2 : surgeries.length <= 1 ? 1.5 : 1;
  results.surgical_history = { score: surgScore, max: 2, logic: `${surgeries.length} surgeries → ${surgScore}/2`, status: `${surgeries.length} events` };

  for (const key in results) {
    totalScore += results[key].score;
  }

  return { score: Math.min(totalScore, maxTotal), max: maxTotal, breakdown: results };
}

// Component 4: Clinical Correlation (15 pts)
function scoreClinicalCorrelation(correlationData, extractedData) {
  const results = {};
  let totalScore = 0;
  const maxTotal = 15;

  const correlation = correlationData || {};
  const hasCorrelationData = correlation.medications_found?.length > 0 || correlation.drug_condition_mismatches?.length > 0 || correlation.multi_system_correlations?.length > 0 || (correlation.cardiovascular_risk?.framingham_risk_category && correlation.cardiovascular_risk.framingham_risk_category !== 'low|moderate|high|very_high');

  // Drug-Condition Matches (5 pts)
  const mismatches = correlation?.drug_condition_mismatches || [];
  const undisclosed = mismatches.filter(m => !m.disclosed);
  let mismatchScore;
  if (undisclosed.length > 0) mismatchScore = undisclosed.length <= 1 ? 3 : 1;
  else if (correlation.medications_found?.length > 0) mismatchScore = 5; // Meds found, all disclosed = genuinely clean
  else mismatchScore = 3; // No medications data available — partial score, not full
  results.drug_condition = { score: mismatchScore, max: 5, logic: `${undisclosed.length} undisclosed${correlation.medications_found?.length ? ', '+correlation.medications_found.length+' meds checked' : ', no medication data available'} → ${mismatchScore}/5`, status: undisclosed.length === 0 ? (correlation.medications_found?.length ? 'consistent' : 'no data') : `${undisclosed.length} mismatches` };

  // Multi-System Findings (5 pts) — also check EM interactions as backup
  const multiSystem = correlation?.multi_system_correlations || [];
  const significantFindings = multiSystem.filter(m => m.clinical_significance === 'high' || m.clinical_significance === 'critical');

  // Cross-check with extracted data for obvious patterns the AI might have missed
  let missedPatterns = 0;
  if (extractedData) {
    const bc = extractedData.blood_chemistry || {};
    const hdl = parseFloat(bc.hdl?.value); const tg = parseFloat(bc.triglycerides?.value);
    const gluc = parseFloat(bc.fasting_glucose?.value); const creat = parseFloat(bc.serum_creatinine?.value);
    // Check for atherogenic dyslipidemia (low HDL + high TG) not caught by AI
    if (hdl < 50 && tg > 150 && !multiSystem.some(m => m.finding?.toLowerCase().includes('dyslipidemia') || m.finding?.toLowerCase().includes('lipid'))) missedPatterns++;
    // Check for pre-diabetic + kidney stress not caught by AI
    if (gluc > 100 && creat > 1.3 && !multiSystem.some(m => m.finding?.toLowerCase().includes('nephropathy') || m.finding?.toLowerCase().includes('kidney'))) missedPatterns++;
  }

  let multiScore;
  if (significantFindings.length > 0) multiScore = significantFindings.length <= 1 ? 3 : 1;
  else if (missedPatterns > 0) multiScore = 3; // AI missed patterns but EM scoring caught them
  else if (hasCorrelationData) multiScore = 5; // Genuinely assessed and clean
  else multiScore = 3; // No correlation data — partial score
  results.multi_system = { score: multiScore, max: 5, logic: `${significantFindings.length} significant correlations${missedPatterns > 0 ? ', '+missedPatterns+' patterns detected by EM' : ''} → ${multiScore}/5`, status: significantFindings.length === 0 ? (missedPatterns > 0 ? `${missedPatterns} EM patterns` : hasCorrelationData ? 'clean' : 'not assessed') : `${significantFindings.length} findings` };

  // CV Risk (5 pts) — calculate from raw data if AI didn't provide it
  let cvRisk = correlation?.cardiovascular_risk?.framingham_risk_category || 'unknown';
  let cvRiskFactors = correlation?.cardiovascular_risk?.risk_factors_count || 0;

  // If AI returned template placeholder or unknown, calculate from raw data
  if (cvRisk === 'unknown' || cvRisk === 'low|moderate|high|very_high' || cvRisk === '') {
    if (extractedData) {
      const bc = extractedData.blood_chemistry || {};
      const pe = extractedData.physical_exam || {};
      // Count risk factors
      const age = parseFloat(extractedData._proposer_age) || 0;
      const isMale = (extractedData._proposer_gender || '').toLowerCase() !== 'female';
      const isSmoker = (extractedData.lifestyle?.smoking?.status || '').includes('current');
      if ((isMale && age > 55) || (!isMale && age > 65)) cvRiskFactors++;
      if (isSmoker) cvRiskFactors++;
      if (parseFloat(bc.fasting_glucose?.value) > 126) cvRiskFactors++;
      const sys = parseFloat(pe.blood_pressure_systolic?.value || pe.blood_pressure?.systolic?.value);
      if (sys > 140) cvRiskFactors++;
      if (parseFloat(bc.total_cholesterol?.value) > 240) cvRiskFactors++;
      if (parseFloat(bc.hdl?.value) < 40) cvRiskFactors++;
      if (parseFloat(bc.tc_hdl_ratio?.value) > 5.5) cvRiskFactors++;

      if (cvRiskFactors >= 4) cvRisk = 'very_high';
      else if (cvRiskFactors >= 3) cvRisk = 'high';
      else if (cvRiskFactors >= 2) cvRisk = 'moderate';
      else if (cvRiskFactors >= 1) cvRisk = 'low_moderate';
      else cvRisk = 'low';
    }
  }

  const cvScore = cvRisk === 'low' ? 5 : cvRisk === 'low_moderate' ? 4 : cvRisk === 'moderate' ? 3 : cvRisk === 'high' ? 1 : cvRisk === 'very_high' ? 0 : 3;
  results.cv_risk = { score: cvScore, max: 5, logic: `CV Risk: ${cvRisk} (${cvRiskFactors} risk factors) → ${cvScore}/5`, status: cvRisk };

  for (const key in results) {
    totalScore += results[key].score;
  }

  return { score: Math.min(totalScore, maxTotal), max: maxTotal, breakdown: results };
}

// Component 5: Documentation Quality (15 pts)
function scoreDocumentationQuality(extractedData) {
  const results = {};
  let totalScore = 0;
  const maxTotal = 15;

  // Count tested parameters across all PPHC sections
  const sections = ['blood_chemistry', 'hematology', 'urine_analysis', 'cardiac', 'physical_exam', 'imaging'];
  let totalParams = 0;
  let testedParams = 0;

  for (const section of sections) {
    const data = extractedData?.[section] || {};
    for (const key in data) {
      if (typeof data[key] === 'object' && data[key] !== null && 'value' in data[key]) {
        totalParams++;
        if (data[key].value !== null && data[key].value !== '' && data[key].flag !== 'not_tested') {
          testedParams++;
        }
      }
    }
  }

  // Completeness (8 pts)
  const completeness = totalParams > 0 ? testedParams / totalParams : 0;
  const compScore = completeness >= 0.9 ? 8 : completeness >= 0.75 ? 6 : completeness >= 0.5 ? 4 : 2;
  results.completeness = { score: compScore, max: 8, logic: `${testedParams}/${totalParams} params (${(completeness * 100).toFixed(0)}%) → ${compScore}/8`, status: `${(completeness * 100).toFixed(0)}%` };

  // Module Coverage (4 pts)
  const modulesPresent = sections.filter(s => {
    const data = extractedData?.[s];
    return data && Object.keys(data).length > 0;
  }).length;
  const modScore = modulesPresent >= 5 ? 4 : modulesPresent >= 3 ? 3 : modulesPresent >= 2 ? 2 : 1;
  results.module_coverage = { score: modScore, max: 4, logic: `${modulesPresent}/${sections.length} modules → ${modScore}/4`, status: `${modulesPresent} modules` };

  // Consistency (3 pts) — check for internal contradictions
  const consistencyIssues = [];
  // Example: BMI vs weight/height
  const pe = extractedData?.physical_exam || {};
  if (pe.height_cm && pe.weight_kg && pe.bmi?.value) {
    const calculatedBMI = pe.weight_kg / ((pe.height_cm / 100) ** 2);
    if (Math.abs(calculatedBMI - pe.bmi.value) > 1.5) {
      consistencyIssues.push('BMI mismatch with height/weight');
    }
  }
  const consistScore = consistencyIssues.length === 0 ? 3 : 1;
  results.consistency = { score: consistScore, max: 3, logic: `${consistencyIssues.length} issues → ${consistScore}/3`, status: consistencyIssues.length === 0 ? 'consistent' : consistencyIssues.join(', ') };

  for (const key in results) {
    totalScore += results[key].score;
  }

  return { score: Math.min(totalScore, maxTotal), max: maxTotal, breakdown: results };
}

// ─── Main Calculation ───

function calculateAll(extractedData, correlationData, dynamicConfig) {
  const components = {
    medical_parameters: scoreMedicalParameters(extractedData),
    lifestyle_risk: scoreLifestyleRisk(extractedData),
    medical_history: scoreMedicalHistory(extractedData),
    clinical_correlation: scoreClinicalCorrelation(correlationData, extractedData),
    documentation_quality: scoreDocumentationQuality(extractedData)
  };

  // ── Dynamic per-CAT weight rescaling ──────────────────────────────────────
  // If a per-CAT config is passed (riskParams._component_weights), rescale each
  // component's contribution to the editable weight instead of its hardcoded max.
  // Each component already produces a score/max performance ratio (0..1); we
  // multiply that ratio by the configured weight so edits in Masters Config
  // actually move the computed score. Falls back to hardcoded maxes otherwise.
  const dynWeights = dynamicConfig?.component_weights || null;
  // Map engine component keys → config component keys (config uses short names)
  const KEY_MAP = {
    medical_parameters: ['medical_parameters', 'medical'],
    lifestyle_risk:     ['lifestyle_risk', 'lifestyle'],
    medical_history:    ['medical_history', 'history'],
    clinical_correlation:['clinical_correlation', 'clinical', 'correlation'],
    documentation_quality:['documentation_quality', 'documentation', 'docs']
  };
  function resolveWeight(engineKey) {
    if (!dynWeights) return null;
    for (const alias of KEY_MAP[engineKey]) {
      if (dynWeights[alias] != null) return Number(dynWeights[alias]);
    }
    return null;
  }

  let totalScore, maxScore;
  if (dynWeights) {
    // Weighted mode: each component contributes (score/max) × configuredWeight
    totalScore = 0; maxScore = 0;
    for (const [key, comp] of Object.entries(components)) {
      const w = resolveWeight(key);
      if (w == null) {
        // No configured weight for this component — keep its raw contribution
        totalScore += comp.score; maxScore += comp.max;
        continue;
      }
      const ratio = comp.max > 0 ? (comp.score / comp.max) : 0;
      const weightedScore = Math.round(ratio * w * 100) / 100;
      totalScore += weightedScore;
      maxScore += w;
      comp.weighted_score = weightedScore;
      comp.weight = w;
    }
  } else {
    totalScore = Object.values(components).reduce((sum, c) => sum + c.score, 0);
    maxScore = Object.values(components).reduce((sum, c) => sum + c.max, 0);
  }
  const normalizedScore = maxScore > 0 ? Math.round((totalScore / maxScore) * 100 * 100) / 100 : 0;

  // Grade mapping
  let grade;
  if (normalizedScore >= 90) grade = 'A+';
  else if (normalizedScore >= 80) grade = 'A';
  else if (normalizedScore >= 70) grade = 'B+';
  else if (normalizedScore >= 60) grade = 'B';
  else if (normalizedScore >= 50) grade = 'C';
  else grade = 'D';

  // Decision
  let decision, loading_percentage = 0;
  if (normalizedScore >= 80) {
    decision = 'accept_standard';
    loading_percentage = 0;
  } else if (normalizedScore >= 65) {
    decision = 'accept_with_loading';
    loading_percentage = Math.round((80 - normalizedScore) * 5); // 5% per point below 80
  } else if (normalizedScore >= 50) {
    decision = 'refer';
    loading_percentage = Math.round((80 - normalizedScore) * 5);
  } else {
    decision = 'decline';
    loading_percentage = 0;
  }

  // UW Guidelines Compliance
  const guidelines_compliance = checkUWGuidelines(extractedData, correlationData, normalizedScore);

  return {
    risk_score: {
      total: Math.round(totalScore * 100) / 100,
      max: maxScore,
      normalized: normalizedScore,
      grade,
      components
    },
    decision: {
      recommendation: decision,
      loading_percentage,
      exclusions: correlationData?.exclusions || [],
      rationale: generateRationale(components, normalizedScore, grade, decision)
    },
    guidelines_compliance,
    calculated_at: new Date().toISOString()
  };
}

function checkUWGuidelines(extractedData, correlationData, score) {
  const guidelines = loadConfig('uw-guidelines.json');
  if (!guidelines) return { compliant: true, violations: [], checks: [] };

  const checks = [];
  const violations = [];

  // Check each guideline rule
  const rules = guidelines.rules || [];
  for (const rule of rules) {
    const result = evaluateGuidelineRule(rule, extractedData, correlationData, score);
    checks.push(result);
    if (!result.compliant) violations.push(result);
  }

  return {
    compliant: violations.length === 0,
    violations,
    checks,
    checked_at: new Date().toISOString()
  };
}

function evaluateGuidelineRule(rule, extractedData, correlationData, score) {
  let value;
  let compliant = true;

  // Navigate to the value using the rule path
  try {
    const parts = rule.path.split('.');
    value = extractedData;
    for (const part of parts) {
      value = value?.[part];
    }
  } catch (e) {
    value = null;
  }

  if (value !== null && value !== undefined) {
    switch (rule.operator) {
      case '<': compliant = value < rule.threshold; break;
      case '<=': compliant = value <= rule.threshold; break;
      case '>': compliant = value > rule.threshold; break;
      case '>=': compliant = value >= rule.threshold; break;
      case '==': compliant = value === rule.threshold; break;
      case '!=': compliant = value !== rule.threshold; break;
      case 'in': compliant = rule.threshold.includes(value); break;
      case 'not_in': compliant = !rule.threshold.includes(value); break;
    }
  }

  return {
    rule_id: rule.id,
    rule_name: rule.name,
    path: rule.path,
    value,
    threshold: rule.threshold,
    operator: rule.operator,
    compliant,
    action: rule.action || 'flag',
    severity: rule.severity || 'medium'
  };
}

function generateRationale(components, score, grade, decision) {
  const parts = [];
  parts.push(`Overall Health Risk Score: ${score}/100 (Grade: ${grade})`);

  for (const [name, comp] of Object.entries(components)) {
    const displayName = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    parts.push(`${displayName}: ${comp.score}/${comp.max}`);
  }

  switch (decision) {
    case 'accept_standard':
      parts.push('Recommendation: Accept at standard rates. All parameters within acceptable limits.');
      break;
    case 'accept_with_loading':
      parts.push('Recommendation: Accept with extra premium loading. Some risk factors identified requiring additional premium.');
      break;
    case 'refer':
      parts.push('Recommendation: Refer to senior underwriter. Multiple risk factors require manual review.');
      break;
    case 'decline':
      parts.push('Recommendation: Decline. Risk profile exceeds acceptable thresholds.');
      break;
  }

  return parts.join('\n');
}

// ─── Biometric Risk Assessment (Module 1) ───

function calculateBiometricRisk(biometricData) {
  let score = 100;
  const deductions = [];

  if (biometricData?.liveness_check?.status === 'fail') {
    score -= 100; // Immediate fail
    deductions.push('Liveness check failed — -100');
  }
  if (biometricData?.identity_match?.status === 'mismatch') {
    score -= 50;
    deductions.push('Identity mismatch — -50');
  }
  if (biometricData?.fraud_screening?.blacklist_match) {
    score -= 100;
    deductions.push('Blacklist match — -100');
  }
  if (biometricData?.fraud_screening?.risk_score > 70) {
    score -= 30;
    deductions.push(`High fraud risk score (${biometricData.fraud_screening.risk_score}) — -30`);
  }
  if (biometricData?.fraud_screening?.multiple_applications_flag) {
    score -= 20;
    deductions.push('Multiple applications flagged — -20');
  }

  score = Math.max(0, score);
  const decision = score >= 80 ? 'proceed' : score >= 50 ? 'manual_review' : 'reject';

  return { score, deductions, decision };
}

// ─── TeleMER Risk Assessment (Module 2) ───

function calculateTeleMERRisk(telemerData, voiceAnalysis) {
  let score = 100;
  const deductions = [];

  // Voice consistency
  const consistency = voiceAnalysis?.consistency_analysis?.overall_score || 100;
  if (consistency < 70) {
    const deduct = Math.round((100 - consistency) * 0.3);
    score -= deduct;
    deductions.push(`Low consistency score (${consistency}) — -${deduct}`);
  }

  // Deception risk
  const deceptionRisk = voiceAnalysis?.deception_risk_index || 0;
  if (deceptionRisk > 60) {
    score -= 20;
    deductions.push(`High deception risk (${deceptionRisk}) — -20`);
  }

  // Medical conditions from interview
  const conditions = telemerData?.medical_history?.pre_existing_conditions || [];
  const activeCount = conditions.filter(c => c.current_status === 'active').length;
  if (activeCount > 0) {
    const deduct = Math.min(activeCount * 10, 30);
    score -= deduct;
    deductions.push(`${activeCount} active conditions — -${deduct}`);
  }

  // Cooperativeness
  if (telemerData?.interviewer_observations?.cooperativeness === 'evasive') {
    score -= 15;
    deductions.push('Evasive during interview — -15');
  }

  score = Math.max(0, score);
  const autoDecisionEligible = score >= 85 && conditions.length === 0;

  return { score, deductions, auto_decision_eligible: autoDecisionEligible };
}

// ─── EM (Extra Mortality) Scoring — Scores ALL extracted parameters ───

// EM thresholds for every parameter the AI might extract
const EM_TABLES = {
  // Blood Chemistry
  fasting_glucose: { normal: [70, 100], mild: [100, 126], moderate: [126, 200], severe: [200, 999], em: [0, 25, 50, 100], unit: 'mg/dL', op: 'range' },
  hba1c: { normal: [0, 5.7], mild: [5.7, 6.5], moderate: [6.5, 8.0], severe: [8.0, 99], em: [0, 30, 60, 120], unit: '%', op: 'range' },
  total_cholesterol: { normal: [0, 200], mild: [200, 240], moderate: [240, 280], severe: [280, 999], em: [0, 15, 30, 50], unit: 'mg/dL', op: 'range' },
  hdl: { normal_m: [40, 999], normal_f: [50, 999], low_m: [35, 40], low_f: [40, 50], vlow: [0, 35], em_m: [0, 15, 30], em_f: [0, 25, 40], op: 'gender_lower' },
  ldl: { normal: [0, 100], mild: [100, 130], moderate: [130, 160], severe: [160, 999], em: [0, 10, 25, 50], unit: 'mg/dL', op: 'range' },
  triglycerides: { normal: [0, 150], mild: [150, 200], moderate: [200, 500], severe: [500, 9999], em: [0, 15, 30, 60], unit: 'mg/dL', op: 'range' },
  tc_hdl_ratio: { normal: [0, 3.5], mild: [3.5, 4.5], moderate: [4.5, 5.5], severe: [5.5, 99], em: [0, 10, 25, 50], op: 'range' },
  sgpt_alt: { normal: [0, 40], mild: [40, 80], moderate: [80, 120], severe: [120, 9999], em: [0, 15, 30, 75], unit: 'U/L', op: 'range' },
  sgot_ast: { normal: [0, 40], mild: [40, 80], moderate: [80, 120], severe: [120, 9999], em: [0, 15, 30, 75], unit: 'U/L', op: 'range' },
  ggt: { normal: [0, 60], mild: [60, 100], moderate: [100, 200], severe: [200, 9999], em: [0, 10, 25, 50], unit: 'U/L', op: 'range' },
  alp: { normal: [0, 120], mild: [120, 200], moderate: [200, 350], severe: [350, 9999], em: [0, 10, 20, 40], unit: 'U/L', op: 'range' },
  total_bilirubin: { normal: [0, 1.2], mild: [1.2, 2.0], moderate: [2.0, 3.0], severe: [3.0, 99], em: [0, 10, 25, 50], unit: 'mg/dL', op: 'range' },
  direct_bilirubin: { normal: [0, 0.3], mild: [0.3, 0.6], moderate: [0.6, 1.0], severe: [1.0, 99], em: [0, 10, 20, 40], unit: 'mg/dL', op: 'range' },
  serum_creatinine: { normal_m: [0, 1.3], normal_f: [0, 1.1], mild_m: [1.3, 1.5], mild_f: [1.1, 1.3], moderate: [1.5, 2.0], severe: [2.0, 99], em: [0, 20, 50, 100], unit: 'mg/dL', op: 'gender_upper' },
  blood_urea: { normal: [0, 20], mild: [20, 30], moderate: [30, 50], severe: [50, 999], em: [0, 10, 25, 50], unit: 'mg/dL', op: 'range' },
  bun: { normal: [0, 20], mild: [20, 30], moderate: [30, 50], severe: [50, 999], em: [0, 10, 25, 50], unit: 'mg/dL', op: 'range' },
  uric_acid: { normal: [0, 7.0], mild: [7.0, 8.5], moderate: [8.5, 10.0], severe: [10.0, 99], em: [0, 10, 20, 35], unit: 'mg/dL', op: 'range' },
  total_protein: { normal: [6.0, 8.3], low: [0, 6.0], high: [8.3, 99], em_low: 15, em_high: 10, op: 'range_both' },
  albumin: { normal: [3.5, 5.5], low: [0, 3.5], em_low: 20, op: 'lower_bound' },
  globulin: { normal: [2.0, 3.5], high: [3.5, 99], em_high: 15, op: 'upper_bound' },
  // Hematology
  hemoglobin: { normal_m: [13.5, 17.5], normal_f: [12.0, 15.5], low_m: [11, 13.5], low_f: [9, 12], vlow: [0, 9], em: [0, 15, 40], unit: 'g/dL', op: 'gender_lower' },
  wbc: { normal: [4000, 11000], mild_high: [11000, 15000], severe_high: [15000, 99999], low: [0, 4000], em_high: [0, 15, 40], em_low: 20, unit: '/cumm', op: 'range_both_wbc' },
  platelet_count: { normal: [150000, 400000], low: [100000, 150000], vlow: [0, 100000], high: [400000, 999999], em_low: [0, 15, 40], em_high: 10, op: 'range_both_plt' },
  rbc: { normal_m: [4.5, 5.5], normal_f: [4.0, 5.0], low: [0, 4.0], em_low: 15, op: 'gender_lower_rbc' },
  esr: { normal_m: [0, 15], normal_f: [0, 20], mild: [20, 40], moderate: [40, 80], severe: [80, 999], em: [0, 10, 25, 50], op: 'gender_upper_esr' },
  // Physical Exam
  bmi: { normal: [18.5, 24.9], overweight: [25, 29.9], obese1: [30, 34.9], obese2: [35, 39.9], obese3: [40, 99], underweight: [0, 18.5], em: [0, 15, 35, 75, 125, 20], op: 'bmi' },
  systolic_bp: { normal: [0, 120], elevated: [120, 130], stage1: [130, 140], stage2: [140, 160], crisis: [160, 999], em: [0, 10, 25, 50, 100], op: 'range' },
  diastolic_bp: { normal: [0, 80], elevated: [80, 85], stage1: [85, 90], stage2: [90, 100], crisis: [100, 999], em: [0, 10, 25, 50, 100], op: 'range' },
  pulse_rate: { normal: [60, 100], mild: [100, 110], moderate: [110, 130], severe: [130, 999], low: [0, 50], em_high: [0, 5, 15, 30], em_low: 15, op: 'range_both_pulse' },
  // Thyroid
  tsh: { normal: [0.4, 4.0], mild_high: [4.0, 10.0], severe_high: [10.0, 999], low: [0, 0.4], em_high: [0, 15, 40], em_low: 20, op: 'range_both_tsh' },
};

// Interaction EM — when multiple adverse findings coexist in same system
const EM_INTERACTIONS = [
  { conditions: ['hdl_low', 'triglycerides_high'], em: 20, name: 'Atherogenic Dyslipidemia', system: 'cardiovascular' },
  { conditions: ['fasting_glucose_high', 'serum_creatinine_high'], em: 30, name: 'Possible Diabetic Nephropathy', system: 'metabolic_renal' },
  { conditions: ['fasting_glucose_high', 'bmi_high'], em: 15, name: 'Metabolic Syndrome Risk', system: 'metabolic' },
  { conditions: ['sgpt_alt_high', 'sgot_ast_high'], em: 15, name: 'Hepatic Stress Pattern', system: 'hepatic' },
  { conditions: ['systolic_bp_high', 'serum_creatinine_high'], em: 20, name: 'Hypertensive Nephropathy Risk', system: 'cardiovascular_renal' },
  { conditions: ['wbc_high', 'esr_high'], em: 15, name: 'Active Inflammatory Process', system: 'hematology' },
  { conditions: ['fasting_glucose_high', 'tc_hdl_ratio_high', 'systolic_bp_high'], em: 30, name: 'Cardiovascular Triad', system: 'cardiovascular' },
];

/**
 * Calculate EM for a single parameter
 */
function calcParamEM(paramKey, value, gender) {
  const table = EM_TABLES[paramKey];
  if (!table || value === null || value === undefined) return { em: 0, level: 'missing', paramKey };

  const v = parseFloat(value);
  if (!Number.isFinite(v)) return { em: 0, level: 'non_numeric', paramKey };

  if (table.op === 'range') {
    if (v >= table.normal[0] && v <= table.normal[1]) return { em: 0, level: 'normal', paramKey };
    if (table.mild && v >= table.mild[0] && v <= table.mild[1]) return { em: table.em[1], level: 'mild', paramKey };
    if (table.moderate && v >= table.moderate[0] && v <= table.moderate[1]) return { em: table.em[2], level: 'moderate', paramKey };
    if (table.severe && v >= table.severe[0] && v <= table.severe[1]) return { em: table.em[3], level: 'severe', paramKey };
    if (table.elevated && v >= table.elevated[0] && v <= table.elevated[1]) return { em: table.em[1], level: 'elevated', paramKey };
    if (table.stage1 && v >= table.stage1[0] && v <= table.stage1[1]) return { em: table.em[2], level: 'stage1', paramKey };
    if (table.stage2 && v >= table.stage2[0] && v <= table.stage2[1]) return { em: table.em[3], level: 'stage2', paramKey };
    if (table.crisis && v >= table.crisis[0]) return { em: table.em[4] || table.em[3], level: 'crisis', paramKey };
    return { em: table.em[1] || 10, level: 'abnormal', paramKey };
  }

  if (table.op === 'bmi') {
    if (v < 18.5) return { em: table.em[5], level: 'underweight', paramKey };
    if (v <= 24.9) return { em: 0, level: 'normal', paramKey };
    if (v <= 29.9) return { em: table.em[1], level: 'overweight', paramKey };
    if (v <= 34.9) return { em: table.em[2], level: 'obese_1', paramKey };
    if (v <= 39.9) return { em: table.em[3], level: 'obese_2', paramKey };
    return { em: table.em[4], level: 'obese_3', paramKey };
  }

  if (table.op === 'gender_lower') {
    const g = (gender || '').toLowerCase().startsWith('f') ? 'f' : 'm';
    const normalLow = g === 'f' ? (table.normal_f?.[0] || table.normal_m[0]) : table.normal_m[0];
    const lowRange = g === 'f' ? (table.low_f || table.low_m) : table.low_m;
    const emArr = g === 'f' ? (table.em_f || table.em_m) : table.em_m;
    if (v >= normalLow) return { em: 0, level: 'normal', paramKey };
    if (lowRange && v >= lowRange[0]) return { em: emArr[1], level: 'low', paramKey };
    return { em: emArr[2] || emArr[1], level: 'very_low', paramKey };
  }

  if (table.op === 'gender_upper' || table.op === 'gender_upper_esr') {
    const g = (gender || '').toLowerCase().startsWith('f') ? 'f' : 'm';
    const normalHigh = g === 'f' ? (table.normal_f?.[1] || table.normal_m[1]) : table.normal_m[1];
    if (v <= normalHigh) return { em: 0, level: 'normal', paramKey };
    if (table.mild && v <= (table.mild[1] || normalHigh * 2)) return { em: table.em[1], level: 'mild', paramKey };
    if (table.moderate && v <= (table.moderate[1] || normalHigh * 4)) return { em: table.em[2], level: 'moderate', paramKey };
    return { em: table.em[3] || table.em[2] || 25, level: 'severe', paramKey };
  }

  // Fallback for other ops
  return { em: 0, level: 'normal', paramKey };
}

/**
 * Calculate EM for ALL extracted parameters across all sections
 */
function calculateFullEM(extractedData, gender) {
  const paramResults = [];
  const adverseFlags = new Set(); // For interaction detection

  // Blood Chemistry
  const bc = extractedData?.blood_chemistry || {};
  const bcMap = {
    fasting_glucose: bc.fasting_glucose, hba1c: bc.hba1c, total_cholesterol: bc.total_cholesterol,
    hdl: bc.hdl, ldl: bc.ldl, triglycerides: bc.triglycerides, tc_hdl_ratio: bc.tc_hdl_ratio,
    sgpt_alt: bc.sgpt_alt, sgot_ast: bc.sgot_ast, ggt: bc.ggt, alp: bc.alp,
    total_bilirubin: bc.total_bilirubin, direct_bilirubin: bc.direct_bilirubin,
    serum_creatinine: bc.serum_creatinine, blood_urea: bc.blood_urea, bun: bc.bun,
    uric_acid: bc.uric_acid, total_protein: bc.total_protein, albumin: bc.albumin, globulin: bc.globulin
  };
  for (const [key, data] of Object.entries(bcMap)) {
    const val = data?.value;
    if (val === null || val === undefined) continue;
    const r = calcParamEM(key, val, gender);
    r.section = 'blood_chemistry'; r.value = val; r.unit = data?.unit || EM_TABLES[key]?.unit || '';
    r.normalRange = EM_TABLES[key] ? `${EM_TABLES[key].normal[0]}-${EM_TABLES[key].normal[1]}` : '';
    paramResults.push(r);
    if (r.em > 0) adverseFlags.add(`${key}_high`);
    if (r.level === 'low' || r.level === 'very_low') adverseFlags.add(`${key}_low`);
  }

  // Hematology
  const hm = extractedData?.hematology || {};
  const hmMap = { hemoglobin: hm.hemoglobin, wbc: hm.wbc, platelet_count: hm.platelet_count, rbc: hm.rbc, esr: hm.esr };
  for (const [key, data] of Object.entries(hmMap)) {
    const val = data?.value;
    if (val === null || val === undefined) continue;
    const r = calcParamEM(key, val, gender);
    r.section = 'hematology'; r.value = val; r.unit = data?.unit || EM_TABLES[key]?.unit || '';
    r.normalRange = EM_TABLES[key] ? `${EM_TABLES[key].normal?.[0] || ''}-${EM_TABLES[key].normal?.[1] || ''}` : '';
    paramResults.push(r);
    if (r.em > 0) adverseFlags.add(`${key}_high`);
    if (r.level === 'low' || r.level === 'very_low') adverseFlags.add(`${key}_low`);
  }

  // Physical Exam
  const pe = extractedData?.physical_exam || {};
  if (pe.bmi?.value) {
    const r = calcParamEM('bmi', pe.bmi.value, gender);
    r.section = 'physical_exam'; r.value = pe.bmi.value; r.unit = 'kg/m²'; r.normalRange = '18.5-24.9';
    paramResults.push(r);
    if (r.em > 0) adverseFlags.add('bmi_high');
  }
  if (pe.blood_pressure_systolic?.value || pe.blood_pressure?.systolic?.value) {
    const sysVal = pe.blood_pressure_systolic?.value || pe.blood_pressure?.systolic?.value;
    const r = calcParamEM('systolic_bp', sysVal, gender);
    r.section = 'physical_exam'; r.value = sysVal; r.unit = 'mmHg'; r.normalRange = '<120';
    paramResults.push(r);
    if (r.em > 0) adverseFlags.add('systolic_bp_high');
  }
  if (pe.blood_pressure_diastolic?.value || pe.blood_pressure?.diastolic?.value) {
    const diaVal = pe.blood_pressure_diastolic?.value || pe.blood_pressure?.diastolic?.value;
    const r = calcParamEM('diastolic_bp', diaVal, gender);
    r.section = 'physical_exam'; r.value = diaVal; r.unit = 'mmHg'; r.normalRange = '<80';
    paramResults.push(r);
  }

  // Thyroid
  const thy = extractedData?.thyroid || {};
  if (thy.tsh?.value) {
    const r = calcParamEM('tsh', thy.tsh.value, gender);
    r.section = 'thyroid'; r.value = thy.tsh.value; r.unit = 'mIU/L'; r.normalRange = '0.4-4.0';
    paramResults.push(r);
    if (r.em > 0) adverseFlags.add('tsh_high');
  }

  // Calculate interaction EM
  const interactions = [];
  for (const inter of EM_INTERACTIONS) {
    const match = inter.conditions.every(c => adverseFlags.has(c));
    if (match) interactions.push({ ...inter, applied: true });
  }

  // Sum up
  const paramEM = paramResults.reduce((s, r) => s + r.em, 0);
  const interactionEM = interactions.reduce((s, i) => s + i.em, 0);
  const totalMedicalEM = paramEM + interactionEM;

  // Group by system for display
  const bySection = {};
  for (const r of paramResults) {
    if (!bySection[r.section]) bySection[r.section] = { params: [], totalEM: 0 };
    bySection[r.section].params.push(r);
    bySection[r.section].totalEM += r.em;
  }

  return {
    param_results: paramResults,
    param_em: paramEM,
    interactions,
    interaction_em: interactionEM,
    total_medical_em: totalMedicalEM,
    by_section: bySection,
    adverse_count: paramResults.filter(r => r.em > 0).length,
    normal_count: paramResults.filter(r => r.level === 'normal').length,
    missing_count: paramResults.filter(r => r.level === 'missing').length,
    total_params_scored: paramResults.length
  };
}

module.exports = {
  calculateAll,
  calculateBiometricRisk,
  calculateTeleMERRisk,
  scoreMedicalParameters,
  scoreLifestyleRisk,
  scoreMedicalHistory,
  scoreClinicalCorrelation,
  scoreDocumentationQuality,
  calculateFullEM,
  EM_TABLES
};
