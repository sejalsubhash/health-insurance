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
// ─── Hybrid Lifestyle Risk Scorer (C1 — 25 pts normalised from raw 18) ───
// occupation_hazard and exercise removed — not captured in TeleMER form.
// Points redistributed: smoking 7→8, alcohol 5→6, tobacco 3→4. Raw max = 18.
// Normalised to 25 pts using: (raw / 18) * 25
function scoreLifestyleRisk(extractedData) {
  const results = {};
  const rawMax = 18;
  const normalisedMax = 25;

  const lifestyle = extractedData?.telemer_data?.lifestyle || extractedData?.lifestyle || {};

  // Smoking (8 pts)
  const smoking = lifestyle?.smoking?.status || 'unknown';
  let smokingScore;
  if (smoking === 'never')       smokingScore = 8;
  else if (smoking === 'former_gt5' || (smoking === 'former' && (lifestyle?.smoking?.years || 0) > 5)) smokingScore = 6;
  else if (smoking === 'former') smokingScore = 3;
  else if (smoking === 'current') smokingScore = 0;
  else smokingScore = 0; // unknown — no data = no credit
  results.smoking = { score: smokingScore, max: 8, logic: `Smoking: ${smoking} → ${smokingScore}/8`, status: smoking };

  // Alcohol (6 pts)
  const alcohol = lifestyle?.alcohol?.status || 'unknown';
  let alcoholScore;
  if (alcohol === 'never')        alcoholScore = 6;
  else if (alcohol === 'occasional') alcoholScore = 5;
  else if (alcohol === 'regular')    alcoholScore = 2;
  else if (alcohol === 'heavy')      alcoholScore = 0;
  else alcoholScore = 0; // unknown — no data = no credit
  results.alcohol = { score: alcoholScore, max: 6, logic: `Alcohol: ${alcohol} → ${alcoholScore}/6`, status: alcohol };

  // Tobacco / Gutkha / Pan (4 pts)
  const tobacco = lifestyle?.tobacco_chewing?.status || 'unknown';
  let tobaccoScore;
  if (tobacco === 'never')   tobaccoScore = 4;
  else if (tobacco === 'former') tobaccoScore = 2;
  else if (tobacco === 'current') tobaccoScore = 0;
  else tobaccoScore = 0; // unknown — no data = no credit
  results.tobacco_chewing = { score: tobaccoScore, max: 4, logic: `Tobacco: ${tobacco} → ${tobaccoScore}/4`, status: tobacco };

  const rawTotal = results.smoking.score + results.alcohol.score + results.tobacco_chewing.score;
  const normalisedScore = Math.round((rawTotal / rawMax) * normalisedMax * 100) / 100;

  return {
    score: Math.min(normalisedScore, normalisedMax),
    max: normalisedMax,
    raw_score: rawTotal,
    raw_max: rawMax,
    breakdown: results
  };
}

// ─── Hybrid Medical History Scorer (C2 — 20 pts normalised from raw 13) ───
// Family history extracted to its own domain (C7 — scoreHybridFamilyHistory).
// PEC scoring is now severity-tier based, not count-based.
// Normalised to 20 pts using: (raw / 13) * 20
function scoreMedicalHistory(extractedData) {
  const results = {};
  const rawMax = 13;
  const normalisedMax = 20;

  const history = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const callingDate = extractedData?.calling_date || extractedData?.telemer_data?.calling_date || null;

  // ── PEC Severity Tier Scoring (9 pts) ───────────────────────────────────────
  // Tiers: none=0 deduction | resolved/minor=-1 | active-controlled=-2to-3 |
  //        active-uncontrolled=-4to-5 | acute/post-surgical=-8 + override flag
  const conditions = history?.pre_existing_conditions || [];
  let pecScore = 9; // start at max, deduct per condition

  for (const cond of conditions) {
    const status   = (cond.current_status || '').toLowerCase();
    const medName  = (cond.medication || '').trim();
    const sinceYr  = cond.since_year || null;

    // Check if post-surgical / acute
    let surgeryDaysAgo = null;
    if (cond.surgery_date && callingDate) {
      const surgDate  = new Date(cond.surgery_date);
      const callDate  = new Date(callingDate);
      surgeryDaysAgo  = Math.floor((callDate - surgDate) / (1000 * 60 * 60 * 24));
    }
    const isAcute = surgeryDaysAgo !== null && surgeryDaysAgo < 90;

    // Determine if controlled: check for known target readings
    const bp = parseFloat(cond.last_reading_systolic || cond.bp_systolic || 0);
    const hba1c = parseFloat(cond.hba1c || 0);
    const ppbsl = parseFloat(cond.ppbsl || cond.post_prandial_glucose || 0);
    const medicationUnknown = !medName || medName === '' || medName.toLowerCase() === 'unknown' || medName.toLowerCase() === 'not known';

    let tier, deduction;
    if (isAcute) {
      tier = 'acute_post_surgical';
      deduction = 8;
    } else if (status === 'resolved' || status === 'controlled') {
      tier = 'resolved_minor';
      deduction = 1;
    } else if (status === 'active' || status === 'poorly_controlled' || status === 'uncontrolled') {
      // Check readings to determine controlled vs uncontrolled
      let isUncontrolled = false;
      if (medicationUnknown) isUncontrolled = true;
      if (bp > 0 && bp > 140) isUncontrolled = true;
      if (hba1c > 0 && hba1c > 7.5) isUncontrolled = true;
      if (ppbsl > 0 && ppbsl > 180) isUncontrolled = true;
      if (status === 'poorly_controlled' || status === 'uncontrolled') isUncontrolled = true;

      if (isUncontrolled) {
        tier = 'active_uncontrolled';
        deduction = 4;
      } else {
        tier = 'active_controlled';
        deduction = 2;
      }
    } else {
      // unknown status — treat as active controlled conservatively
      tier = 'active_controlled';
      deduction = 2;
    }

    pecScore = Math.max(0, pecScore - deduction);
    cond._scored_tier = tier;
    cond._scored_deduction = deduction;
  }

  if (conditions.length === 0) pecScore = 9;
  results.pre_existing_conditions = {
    score: pecScore,
    max: 9,
    logic: `${conditions.length} condition(s) — severity-tier scoring → ${pecScore}/9`,
    status: conditions.length === 0 ? 'none' : conditions.map(c => `${c.condition || 'unknown'}(${c._scored_tier})`).join(', ')
  };

  // ── Hospitalisation History (2 pts) ─────────────────────────────────────────
  const hospitalizations = history?.hospitalizations || [];
  let hospScore;
  if (hospitalizations.length === 0)                          hospScore = 2;
  else if (hospitalizations.length <= 2)                      hospScore = 1;
  else                                                         hospScore = 0;
  results.hospitalizations = { score: hospScore, max: 2, logic: `${hospitalizations.length} hospitalisation(s) → ${hospScore}/2`, status: `${hospitalizations.length} events` };

  // ── Other Systemic Conditions (2 pts) ────────────────────────────────────────
  // Count yes-answers in systemic question groups (respiratory, renal, neuro, haem, etc.)
  const systemicFlags = extractedData?.telemer_data?.systemic_flags || extractedData?.systemic_flags || {};
  const systemicCount = Object.values(systemicFlags).filter(v => v === true).length;
  let systemicScore;
  if (systemicCount === 0)      systemicScore = 2;
  else if (systemicCount === 1) systemicScore = 1;
  else                           systemicScore = 0;
  results.systemic_conditions = { score: systemicScore, max: 2, logic: `${systemicCount} systemic flag(s) → ${systemicScore}/2`, status: systemicCount === 0 ? 'clear' : `${systemicCount} flags` };

  const rawTotal = results.pre_existing_conditions.score + results.hospitalizations.score + results.systemic_conditions.score;
  const normalisedScore = Math.round((rawTotal / rawMax) * normalisedMax * 100) / 100;

  return {
    score: Math.min(normalisedScore, normalisedMax),
    max: normalisedMax,
    raw_score: rawTotal,
    raw_max: rawMax,
    breakdown: results
  };
}

// ─── Hybrid Cardiovascular Scorer (C4 — 15 pts direct) ───────────────────────
// Standalone domain covering HTN and cardiac history extracted from Q10–Q14.
function scoreHybridCardiovascular(extractedData) {
  const maxTotal = 15;
  let cvScore = 15;
  let status = 'no_cardiac_history';

  const history   = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const conditions = history?.pre_existing_conditions || [];
  const answers    = extractedData?.telemer_data?.answers || extractedData?.answers || {};

  // Find HTN condition in PEC list
  const htnCond = conditions.find(c =>
    (c.condition || '').toLowerCase().includes('hypertension') ||
    (c.condition || '').toLowerCase().includes('htn') ||
    (c.condition || '').toLowerCase().includes('blood pressure')
  );

  // Find cardiac condition
  const cardiacCond = conditions.find(c =>
    (c.condition || '').toLowerCase().includes('cardiac') ||
    (c.condition || '').toLowerCase().includes('heart') ||
    (c.condition || '').toLowerCase().includes('ischemic') ||
    (c.condition || '').toLowerCase().includes('coronary') ||
    (c.condition || '').toLowerCase().includes('stenting') ||
    (c.condition || '').toLowerCase().includes('cabg')
  );

  if (cardiacCond) {
    cvScore = Math.min(cvScore, 2);
    status = 'cardiac_history';
  } else if (htnCond) {
    const bp          = parseFloat(htnCond.last_reading_systolic || htnCond.bp_systolic || 0);
    const medUnknown  = !(htnCond.medication || '').trim() || (htnCond.medication || '').toLowerCase() === 'unknown' || (htnCond.medication || '').toLowerCase() === 'not known';
    const sinceYr     = htnCond.since_year || null;
    const callingYr   = extractedData?.calling_date ? new Date(extractedData.calling_date).getFullYear() : new Date().getFullYear();
    const durationYrs = sinceYr ? callingYr - sinceYr : null;
    const isRecentOnset = durationYrs !== null && durationYrs <= 1;

    if (bp > 140 || medUnknown) {
      cvScore = 5;
      status = 'htn_uncontrolled';
    } else if (isRecentOnset) {
      cvScore = 8;
      status = 'htn_controlled_recent_onset';
    } else {
      cvScore = 10;
      status = 'htn_controlled';
    }
  } else if (answers?.prior_htn_self_stopped) {
    // Prior HTN, self-discontinued medication, BP now reportedly normal
    cvScore = 12;
    status = 'htn_prior_self_stopped';
  }

  // HTN + DM comorbidity penalty — deduct additional 3 pts
  const hasDM = conditions.some(c =>
    (c.condition || '').toLowerCase().includes('diabetes') ||
    (c.condition || '').toLowerCase().includes('dm') ||
    (c.condition || '').toLowerCase().includes('blood sugar')
  );
  if (htnCond && hasDM) {
    cvScore = Math.max(0, cvScore - 3);
    status += '_plus_dm_comorbidity';
  }

  return {
    score: Math.max(0, Math.min(cvScore, maxTotal)),
    max: maxTotal,
    breakdown: { htn_cardiac_status: { score: cvScore, max: maxTotal, logic: `CV status: ${status} → ${cvScore}/15`, status } }
  };
}

// ─── Hybrid Surgical + GI Scorer (C6 — 5 pts direct) ────────────────────────
function scoreHybridSurgicalGI(extractedData) {
  const maxTotal = 5;
  let score = 5;
  let status = 'no_surgery';

  const history      = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const surgeries    = history?.surgical_history || [];
  const callingDate  = extractedData?.calling_date || extractedData?.telemer_data?.calling_date || null;

  if (surgeries.length === 0) {
    score = 5; status = 'no_surgery';
  } else {
    for (const surg of surgeries) {
      let surgeryDaysAgo = null;
      if (surg.surgery_date && callingDate) {
        surgeryDaysAgo = Math.floor((new Date(callingDate) - new Date(surg.surgery_date)) / (1000 * 60 * 60 * 24));
      }
      const surgeryYrsAgo = surg.year ? (new Date(callingDate || Date.now()).getFullYear() - surg.year) : null;
      const recordsAvailable = surg.records_available !== false; // default assume available

      if (surgeryDaysAgo !== null && surgeryDaysAgo < 90) {
        score = Math.min(score, 0); status = 'surgery_lt_90_days';
      } else if (surgeryYrsAgo !== null && surgeryYrsAgo < 1) {
        score = Math.min(score, 1); status = 'surgery_lt_1yr';
      } else if (surgeryYrsAgo !== null && surgeryYrsAgo < 5 && !recordsAvailable) {
        score = Math.min(score, 2); status = 'surgery_lt5yr_no_records';
      } else if (surgeryYrsAgo !== null && surgeryYrsAgo < 5) {
        score = Math.min(score, 3); status = 'surgery_lt5yr_records_available';
      } else if (!recordsAvailable) {
        score = Math.min(score, 3); status = 'surgery_gt5yr_no_records';
      } else {
        score = Math.min(score, 4); status = 'surgery_gt5yr_resolved';
      }
    }
  }

  return {
    score: Math.max(0, score),
    max: maxTotal,
    breakdown: { surgical_gi_status: { score, max: maxTotal, logic: `Surgical/GI status: ${status} → ${score}/5`, status } }
  };
}

// ─── Hybrid Family History Scorer (C7 — 5 pts direct) ───────────────────────
function scoreHybridFamilyHistory(extractedData) {
  const maxTotal = 5;
  const history = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const family  = history?.family_history || {};

  const hasCancer      = family.cancer === true || (family.details || '').toLowerCase().includes('cancer') || (family.details || '').toLowerCase().includes('leukaemia') || (family.details || '').toLowerCase().includes('lymphoma');
  const hasBloodCancer = (family.details || '').toLowerCase().includes('blood cancer') || (family.details || '').toLowerCase().includes('leukaemia') || (family.details || '').toLowerCase().includes('lymphoma');
  const hasStroke      = family.stroke === true;
  const hasCardiac     = family.cardiac === true;
  const hasDiabetes    = family.diabetes === true;
  const hasHTN         = family.hypertension === true;

  let score, status;
  if (!hasCancer && !hasStroke && !hasCardiac && !hasDiabetes && !hasHTN && !hasBloodCancer) {
    score = 5; status = 'none';
  } else if (hasBloodCancer) {
    score = 1; status = 'blood_cancer_first_degree';
  } else if (hasCancer || hasStroke) {
    score = 2; status = 'cancer_or_stroke_first_degree';
  } else if (hasCardiac) {
    score = 3; status = 'cardiac_first_degree';
  } else if (hasDiabetes && hasHTN) {
    score = 3; status = 'dm_and_htn_first_degree';
  } else if (hasDiabetes || hasHTN) {
    score = 4; status = 'dm_or_htn_first_degree';
  } else {
    score = 4; status = 'minor_family_risk';
  }

  return {
    score,
    max: maxTotal,
    needs_senior_review: hasCancer || hasBloodCancer || hasStroke,
    breakdown: { family_history_status: { score, max: maxTotal, logic: `Family history: ${status} → ${score}/5`, status } }
  };
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
  else if (correlation.medications_found?.length > 0) mismatchScore = 5;
  else mismatchScore = 0; // No medication data — no credit
  results.drug_condition = { score: mismatchScore, max: 5, logic: `${undisclosed.length} undisclosed${correlation.medications_found?.length ? ', '+correlation.medications_found.length+' meds checked' : ', no medication data'} → ${mismatchScore}/5`, status: undisclosed.length === 0 ? (correlation.medications_found?.length ? 'consistent' : 'no data') : `${undisclosed.length} mismatches` };

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
  else multiScore = 0; // No correlation data — no credit
  results.multi_system = { score: multiScore, max: 5, logic: `${significantFindings.length} significant correlations${missedPatterns > 0 ? ', '+missedPatterns+' patterns detected by EM' : ''} → ${multiScore}/5`, status: significantFindings.length === 0 ? (missedPatterns > 0 ? `${missedPatterns} EM patterns` : hasCorrelationData ? 'clean' : 'not assessed') : `${significantFindings.length} findings` };

  // CV Risk (5 pts) — calculate from raw data if AI didn't provide it
  let cvRisk = correlation?.cardiovascular_risk?.framingham_risk_category || 'unknown';
  let cvRiskFactors = correlation?.cardiovascular_risk?.risk_factors_count || 0;

  // If AI returned template placeholder or unknown, calculate from raw data
  if (cvRisk === 'unknown' || cvRisk === 'low|moderate|high|very_high' || cvRisk === '') {
    if (extractedData) {
      const bc = extractedData.blood_chemistry || {};
      const pe = extractedData.physical_exam || {};
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
      // No meaningful lab/exam data present → score = 0 (no data = no credit)
      const hasLabData = bc.fasting_glucose?.value != null || bc.total_cholesterol?.value != null ||
                         bc.hdl?.value != null || (sys != null && !isNaN(sys)) || age > 0;
      if (!hasLabData) cvRisk = 'unknown';
      else if (cvRiskFactors >= 4) cvRisk = 'very_high';
      else if (cvRiskFactors >= 3) cvRisk = 'high';
      else if (cvRiskFactors >= 2) cvRisk = 'moderate';
      else if (cvRiskFactors >= 1) cvRisk = 'low_moderate';
      else cvRisk = 'low';
    }
  }
  const cvScore = cvRisk === 'unknown' ? 0 : cvRisk === 'low' ? 5 : cvRisk === 'low_moderate' ? 4 : cvRisk === 'moderate' ? 3 : cvRisk === 'high' ? 1 : cvRisk === 'very_high' ? 0 : 0;
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

// ─── Dynamic Factor Scoring ──────────────────────────────────────────────────
//
// scoreComponentFromConfig() scores an entire component using the factor
// definitions stored in PostgreSQL (edited via Masters > Per-CAT Scoring).
//
// Each factor in the DB config looks like:
//   { id, label, max, bands: [{ label, value, points }] }
//
// To score a factor we need to know WHICH extracted value maps to it.
// The FACTOR_VALUE_EXTRACTORS map resolves factor id → extracted value.
// If no extractor exists for a factor id, the factor is scored at 50% (partial).
//
function scoreComponentFromConfig(compConfig, extractedData, correlationData) {
  if (!compConfig || !Array.isArray(compConfig.factors) || compConfig.factors.length === 0) {
    return null; // No DB config — fall back to hardcoded scorer
  }

  // ── Maps factor id → function that extracts the relevant value ─────────────
  const FACTOR_VALUE_EXTRACTORS = {
    // Medical parameter factors
    bmi_bp: (ed) => {
      const bmi = ed?.physical_exam?.bmi?.value;
      const sys = ed?.physical_exam?.blood_pressure_systolic?.value ||
                  ed?.physical_exam?.blood_pressure?.systolic?.value;
      if (!bmi && !sys) return null;
      // Return composite status string
      const bmiOk  = bmi && bmi >= 18.5 && bmi < 25;
      const bmiBdr = bmi && bmi >= 25 && bmi < 30;
      const bpOk   = sys && sys < 130;
      const bpBdr  = sys && sys >= 130 && sys < 140;
      if ((bmiOk || !bmi) && (bpOk || !sys))   return 'both_normal';
      if (bmiBdr || bpBdr)                       return 'one_borderline';
      return 'both_abnormal';
    },
    ecg: (ed) => {
      const raw = ed?.cardiac?.ecg?.overall_interpretation ?? ed?.cardiac?.ecg?.value;
      if (!raw) return null;
      const v = String(raw).toLowerCase().trim();
      if (v === 'normal' || v === 'borderline' || v === 'abnormal') return v;
      const abnormal = ['ischaem','ischem','lbbb','left bundle branch','atrial fib','\\baf\\b','a-fib','a fib','myocardial','\\bmi\\b','q wave','arrhythmia','arrythmia','infarct','st elevation','st depression','heart block','complete block'];
      const borderline = ['minor','nonspecific','non-specific','st-t','st t change','lvh','left ventricular hypertrophy','rbbb','right bundle','incomplete','brady','tachy','ectopic','first degree','1st degree'];
      const normal = ['normal','within normal limit','wnl','sinus rhythm','nsr','no abnormalit','unremarkable','no significant','regular'];
      if (abnormal.some(s => new RegExp(s).test(v))) {
        if (v.includes('incomplete')) return 'borderline'; // incomplete block is borderline, not abnormal
        return 'abnormal';
      }
      if (borderline.some(s => v.includes(s))) return 'borderline';
      if (normal.some(s => v.includes(s)))     return 'normal';
      return 'abnormal';
    },
    urine_routine: (ed) => {
      // Urine "Albumin" and "Protein" are the same measure — read whichever the lab labelled.
      const p = String(ed?.urine_analysis?.protein?.value ?? ed?.urine_analysis?.albumin?.value ?? '').toLowerCase().trim();
      if (!p) return null;
      if (p === 'nil' || p === 'trace' || p === 'abnormal') return p;
      const nilSet   = ['nil','negative','absent','nad','trace-negative','trace negative','none','not detected'];
      const traceSet = ['trace','1+','+1','trace +'];
      const abnSet   = ['2+','3+','4+','+2','+3','+4','present','positive'];
      if (abnSet.some(s => p.includes(s)))            return 'abnormal';
      if (nilSet.some(s => p === s || p.includes(s))) return 'nil';
      if (traceSet.some(s => p.includes(s)))          return 'trace';
      return 'abnormal';
    },
    cbc: (ed) => {
      const hb  = ed?.hematology?.hemoglobin?.value;
      const wbc = ed?.hematology?.wbc_count?.value;
      if (hb == null && wbc == null) return null;
      // Hb status (gender-neutral lower bound; band label says Hb≥13.5M/12F)
      let hbStatus = 'normal';
      if (hb != null) {
        if (hb < 11)        hbStatus = 'abnormal';
        else if (hb < 13.5) hbStatus = 'one_low';
      } else hbStatus = null;
      // WBC status: normal 4k-11k, borderline 11k-15k, abnormal >15k or <4k
      let wbcStatus = null;
      if (wbc != null) {
        if (wbc > 15000 || wbc < 4000) wbcStatus = 'abnormal';
        else if (wbc > 11000)          wbcStatus = 'one_low';
        else                           wbcStatus = 'normal';
      }
      // Combine: worst of the two drives the band (matches "Hb<11 OR Leukocytosis>15k → abnormal")
      const rank = { normal:0, one_low:1, abnormal:2 };
      const worst = [hbStatus, wbcStatus].filter(Boolean).reduce((a,b)=> rank[b]>rank[a]?b:a, 'normal');
      return worst;
    },
    esr: (ed) => {
      const v = ed?.hematology?.esr?.value;
      if (v == null) return null;
      if (v < 20)  return 'normal';
      if (v <= 40) return 'borderline';
      return 'high';
    },
    hba1c: (ed) => {
      const v = ed?.blood_chemistry?.hba1c?.value;
      if (v == null) return null;
      if (v < 5.7)  return '< 5.7';
      if (v < 6.5)  return '5.7-6.4';
      if (v < 8.0)  return '6.5-7.9';
      return '>= 8';
    },
    sgpt: (ed) => {
      const v = ed?.blood_chemistry?.sgpt_alt?.value;
      if (v == null) return null;
      if (v < 40)  return 'normal';
      if (v <= 80) return 'mild';
      return 'high';
    },
    serum_creatinine: (ed) => {
      const v = ed?.blood_chemistry?.serum_creatinine?.value;
      if (v == null) return null;
      if (v < 1.3)  return 'normal';
      if (v <= 1.7) return 'mild';
      return 'high';
    },
    total_cholesterol: (ed) => {
      const v = ed?.blood_chemistry?.total_cholesterol?.value;
      if (v == null) return null;
      if (v < 200) return '< 200';
      if (v < 240) return '200-239';
      return '>= 240';
    },
    triglyceride: (ed) => {
      const v = ed?.blood_chemistry?.triglycerides?.value;
      if (v == null) return null;
      if (v < 150)  return '< 150';
      if (v < 200)  return '150-199';
      if (v < 500)  return '200-499';
      return '>= 500';
    },
    urine_microalbumin: (ed) => {
      const v = ed?.urine_analysis?.microalbumin?.value ||
                ed?.urine_analysis?.albumin_creatinine_ratio?.value;
      if (v == null) return null;
      if (v < 30)  return '< 30';
      if (v <= 300) return '30-300';
      return '> 300';
    },
    lipid_profile: (ed) => {
      const ldl   = ed?.blood_chemistry?.ldl?.value;
      const ratio = ed?.blood_chemistry?.tc_hdl_ratio?.value;
      if (!ldl && !ratio) return null;
      if ((ldl && ldl >= 160) || (ratio && ratio > 5)) return 'high_risk';
      if ((ldl && ldl >= 100) || (ratio && ratio >= 3.5)) return 'borderline';
      return 'optimal';
    },
    lft: (ed) => {
      const sgpt  = ed?.blood_chemistry?.sgpt_alt?.value;
      const bili  = ed?.blood_chemistry?.total_bilirubin?.value;
      const alb   = ed?.blood_chemistry?.albumin?.value;
      if (!sgpt && !bili && !alb) return null;
      const badCount = [sgpt > 80, bili > 2, alb && alb < 3.0].filter(Boolean).length;
      if (badCount >= 2) return 'abnormal';
      if (sgpt > 40 || (bili && bili > 1.2)) return 'mild';
      return 'normal';
    },
    kft: (ed) => {
      const creat = ed?.blood_chemistry?.serum_creatinine?.value;
      const bun   = ed?.blood_chemistry?.bun?.value ||
                    ed?.blood_chemistry?.blood_urea?.value;
      if (!creat && !bun) return null;
      if ((creat && creat > 1.7) || (bun && bun > 40)) return 'high';
      if ((creat && creat > 1.3) || (bun && bun > 25)) return 'mild';
      return 'normal';
    },
    echo_2d: (ed) => {
      const lvef = ed?.cardiac?.lvef?.value ||
                   ed?.cardiac?.echo?.lvef_percent?.value;
      if (!lvef) return null;
      if (lvef >= 55) return 'normal';
      if (lvef >= 45) return 'mildly_reduced';
      return 'significantly_reduced';
    },
    psa_pap: (ed) => {
      const psa = ed?.blood_chemistry?.psa?.value;
      const pap = ed?.pap_smear?.result?.value;
      if (!psa && !pap) return null;
      if (psa) {
        if (psa < 4)  return 'normal';
        if (psa <= 10) return 'borderline';
        return 'high_risk';
      }
      if (pap) {
        const p = (pap || '').toLowerCase();
        if (p.includes('nilm') || p.includes('normal')) return 'normal';
        if (p.includes('ascus') || p.includes('lsil'))   return 'borderline';
        return 'high_risk';
      }
      return null;
    },

    // Lifestyle factors
    smoking: (ed) => {
      const v = ed?.telemer_data?.lifestyle?.smoking?.status ||
                ed?.lifestyle?.smoking || ed?.lifestyle?.smoking_status;
      return v || null;
    },
    alcohol: (ed) => {
      const v = ed?.telemer_data?.lifestyle?.alcohol?.status ||
                ed?.lifestyle?.alcohol || ed?.lifestyle?.alcohol_consumption;
      return v || null;
    },
    tobacco: (ed) => {
      const v = ed?.telemer_data?.lifestyle?.tobacco_chewing?.status ||
                ed?.lifestyle?.tobacco_chewing || ed?.lifestyle?.tobacco;
      return v || null;
    },
    occupation: (ed) => {
      const v = ed?.lifestyle?.occupation_hazard || ed?.lifestyle?.occupation;
      return v || null;
    },
    exercise: (ed) => {
      const v = ed?.telemer_data?.lifestyle?.exercise?.frequency ||
                ed?.lifestyle?.exercise || ed?.lifestyle?.exercise_frequency;
      return v || null;
    },

    // Medical history factors
    pre_existing: (ed) => {
      const h = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const conds = h.pre_existing_conditions || [];
      const active = conds.filter(c => c.current_status === 'active' || c.current_status === 'poorly_controlled');
      if (conds.length === 0)   return 'none';
      if (active.length === 0)  return 'controlled';
      if (active.length <= 2)   return '1-2 active';
      return '3+ active';
    },
    family_history: (ed) => {
      const h = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const fam = h.family_history || {};
      const risks = ['cardiac','diabetes','cancer','stroke'].filter(k => fam[k] === true);
      if (risks.length === 0) return 'none';
      if (risks.length === 1) return 'one_risk';
      if (risks.length === 2) return 'two_risks';
      return 'three_plus';
    },
    hospitalizations: (ed) => {
      const h = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const n = (h.hospitalizations || []).length;
      if (n === 0)    return 'none';
      if (n <= 2)     return '1-2';
      return '3+';
    },
    surgical_history: (ed) => {
      const h = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const n = (h.surgical_history || []).length;
      if (n === 0)    return 'none';
      if (n === 1)    return 'one_minor';
      return 'two_plus';
    },

    // Clinical correlation factors
    drug_condition: (ed, corr) => {
      const mismatches = corr?.drug_condition_mismatches || [];
      const undisclosed = mismatches.filter(m => !m.disclosed);
      if (undisclosed.length === 0 && (corr?.medications_found?.length || 0) > 0) return 'consistent';
      if (undisclosed.length <= 1) return 'minor gap';
      return 'non-disclosure';
    },
    // TeleMER variant — factor id used in Per-CAT tele_mer config
    drug_condition_match: (ed, corr) => {
      const meds   = corr?.medications_found || [];
      const mismatches = (corr?.drug_condition_mismatches || []).filter(m => !m.disclosed);
      if (mismatches.length > 0)  return 'mismatch';
      if (meds.length > 0)        return 'match';
      const pec = (ed?.telemer_data?.medical_history?.pre_existing_conditions || []);
      if (pec.some(c => c.medication && c.medication !== 'unknown')) return 'match';
      if (pec.some(c => !c.medication || c.medication === 'unknown')) return 'med_unknown';
      return 'na_clean';
    },
    multi_system: (ed, corr) => {
      const ms = corr?.multi_system_correlations || [];
      const sig = ms.filter(m => m.clinical_significance === 'high' || m.clinical_significance === 'critical');
      if (sig.length === 0) return 'none';
      if (sig.length === 1) return '1 cluster';
      return '2+ clusters';
    },
    // TeleMER variant — count of active PEC across different systems
    multi_system_risk: (ed) => {
      const h = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const active = (h.pre_existing_conditions || []).filter(c =>
        c.current_status === 'active' || c.current_status === 'poorly_controlled' || c.current_status === 'uncontrolled'
      );
      if (active.length === 0) return 'zero';
      if (active.length === 1) return 'one_single';
      if (active.length === 2) return 'two_diff';
      if (active.length === 3) return 'three';
      return 'four_plus';
    },
    cv_risk: (ed, corr) => {
      const cat = corr?.cardiovascular_risk?.framingham_risk_category || 'unknown';
      if (cat === 'low')          return 'low';
      if (cat === 'low_moderate') return 'moderate';
      if (cat === 'moderate')     return 'moderate';
      if (cat === 'high')         return 'high';
      return 'low'; // default
    },
    // TeleMER CV proxy — 5 protective factors
    cv_proxy: (ed) => {
      const age    = parseFloat(ed?._proposer_age || 0);
      const gender = (ed?._proposer_gender || '').toLowerCase();
      const bmi    = parseFloat(ed?.physical_exam?.bmi?.value || ed?.bmi || 0);
      const h      = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const conds  = h.pre_existing_conditions || [];
      const hasDM  = conds.some(c => /diabetes|dm\b/i.test(c.condition || ''));
      const hasHTN = conds.some(c => /hypertension|htn\b|blood pressure/i.test(c.condition || ''));
      let factors = 0;
      if (age > 0 && age < 45)         factors++;
      if (gender.startsWith('f'))       factors++;
      if (!hasDM)                       factors++;
      if (bmi > 0 && bmi < 25)         factors++;
      if (!hasHTN)                      factors++;
      if (factors >= 5) return '5_factors';
      if (factors === 4) return '4_factors';
      if (factors === 3) return '3_factors';
      if (factors === 2) return '2_factors';
      return '1_or_less';
    },

    // TeleMER PEC severity tier — maps to C2 pec_severity factor
    pec_severity: (ed) => {
      const h     = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const conds = h.pre_existing_conditions || [];
      if (conds.length === 0) return 'none';
      // Check for acute/post-surgical
      const callingDate = ed?.calling_date || new Date().toISOString().split('T')[0];
      const hasAcute = conds.some(c => {
        if (!c.surgery_date) return false;
        const days = Math.floor((new Date(callingDate) - new Date(c.surgery_date)) / 86400000);
        return days < 90;
      });
      if (hasAcute) return 'acute';
      // Check controlled vs uncontrolled
      const hasUncontrolled = conds.some(c => {
        const medUnknown = !c.medication || c.medication === 'unknown';
        const bp = parseFloat(c.last_reading_systolic || 0);
        const hba1c = parseFloat(c.hba1c || 0);
        if (medUnknown) return true;
        if (bp > 0 && bp > 140) return true;
        if (hba1c > 0 && hba1c > 7.5) return true;
        return false;
      });
      const hasActive = conds.some(c => c.current_status === 'active' || c.current_status === 'poorly_controlled');
      const allResolved = conds.every(c => c.current_status === 'resolved');
      if (allResolved) return 'resolved';
      if (hasUncontrolled) return 'active_uncontrolled';
      if (hasActive) return 'active_controlled';
      return 'resolved';
    },

    // TeleMER systemic flags (C2 sub-factor)
    systemic_flags: (ed) => {
      const sf = ed?.telemer_data?.medical_history?.systemic_flags || {};
      const count = Object.values(sf).filter(v => v === true).length;
      if (count === 0) return 'none';
      if (count === 1) return 'one_minor';
      return 'two_plus';
    },

    // TeleMER C4 cardiovascular+HTN direct scoring
    c4_cardiovascular: (ed) => {
      const h    = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const conds = h.pre_existing_conditions || [];
      const htn  = conds.find(c => /hypertension|htn\b|blood pressure/i.test(c.condition || ''));
      const cardiac = conds.find(c => /cardiac|heart|ischemic|coronary|stenting|cabg/i.test(c.condition || ''));
      if (!htn && !cardiac) return 'clean';
      if (cardiac) return 'cardiac_ihd';
      // HTN scoring
      const bp       = parseFloat(htn.last_reading_systolic || 0);
      const medUnknown = !htn.medication || htn.medication === 'unknown';
      const calYr    = ed?.calling_date ? new Date(ed.calling_date).getFullYear() : new Date().getFullYear();
      const durationYrs = htn.since_year ? calYr - htn.since_year : null;
      const recentOnset = durationYrs !== null && durationYrs <= 1;
      if (medUnknown) return 'htn_med_unknown';
      if (bp > 0 && bp > 140) return 'htn_uncontrolled';
      if (bp === 0) return 'htn_med_no_reading';
      if (recentOnset) return 'htn_ctrl_lte1yr';
      return 'htn_ctrl_gt1yr';
    },

    // TeleMER C6 surgical/GI
    c6_surgical_gi: (ed) => {
      const h       = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const surgs   = h.surgical_history || [];
      const calling = ed?.calling_date || new Date().toISOString().split('T')[0];
      if (surgs.length === 0) return 'none';
      const calYr = new Date(calling).getFullYear();
      for (const s of surgs) {
        const surgDays = s.surgery_date
          ? Math.floor((new Date(calling) - new Date(s.surgery_date)) / 86400000)
          : null;
        const surgYrs  = s.year ? calYr - s.year : null;
        const hasRecords = s.records_available !== false;
        if (surgDays !== null && surgDays < 90)    return 'lt90days';
        if (surgYrs !== null && surgYrs < 1)       return 'lt1yr';
        if (surgYrs !== null && surgYrs < 5 && !hasRecords) return 'lt5yr_no_records';
        if (surgYrs !== null && surgYrs < 5)       return 'lt5yr_records';
        if (!hasRecords)                           return 'gt5yr_no_records';
        return 'gt5yr_records';
      }
      return 'none';
    },

    // TeleMER C7 family history
    c7_family_history: (ed) => {
      const h   = ed?.telemer_data?.medical_history || ed?.medical_history || {};
      const fam = h.family_history || {};
      const det = (fam.details || '').toLowerCase();
      const hasBloodCancer = det.includes('blood cancer') || det.includes('leukaemia') || det.includes('lymphoma');
      const hasCancer  = fam.cancer === true || det.includes('cancer') || hasBloodCancer;
      const hasStroke  = fam.stroke === true;
      const hasCardiac = fam.cardiac === true;
      const hasDM      = fam.diabetes === true;
      const hasHTN     = fam.hypertension === true;
      if (hasBloodCancer)         return 'blood_cancer';
      if (hasCancer || hasStroke) return 'cancer';
      if (hasCardiac)             return 'cardiac';
      if (hasDM && hasHTN)        return 'dm_and_htn';
      if (hasDM || hasHTN)        return 'dm_or_htn';
      return 'none';
    },

    // Documentation quality factors
    completeness: (ed) => {
      const sections = ['blood_chemistry','hematology','urine_analysis','cardiac','physical_exam','imaging'];
      let total = 0, filled = 0;
      for (const s of sections) {
        const data = ed?.[s] || {};
        for (const key in data) {
          if (typeof data[key] === 'object' && data[key] !== null && 'value' in data[key]) {
            total++;
            if (data[key].value !== null && data[key].value !== '' && data[key].flag !== 'not_tested') filled++;
          }
        }
      }
      if (total === 0) return '0%';
      const pct = filled / total;
      if (pct >= 0.9)  return '90%+';
      if (pct >= 0.75) return '75%';
      if (pct >= 0.5)  return '50%';
      return '<50%';
    },
    module_coverage: (ed) => {
      const sections = ['blood_chemistry','hematology','urine_analysis','cardiac','physical_exam','imaging'];
      const present = sections.filter(s => ed?.[s] && Object.keys(ed[s]).length > 0).length;
      if (present >= 5) return 'all';
      if (present >= 3) return 'most';
      return 'few';
    },
    consistency: (ed) => {
      const pe = ed?.physical_exam || {};
      if (pe.height_cm && pe.weight_kg && pe.bmi?.value) {
        const calc = pe.weight_kg / ((pe.height_cm / 100) ** 2);
        if (Math.abs(calc - pe.bmi.value) > 1.5) return 'conflicts/expired';
      }
      return 'no conflicts';
    }
  };

  // ── Score each factor using its bands ──────────────────────────────────────
  const factorResults = {};
  let totalScore = 0;

  for (const factor of compConfig.factors) {
    const extractor = FACTOR_VALUE_EXTRACTORS[factor.id];
    const rawValue  = extractor ? extractor(extractedData, correlationData) : null;

    if (!rawValue || !Array.isArray(factor.bands) || factor.bands.length === 0) {
      // No data extracted — score = 0 (unknown/missing data gets no credit)
      factorResults[factor.id] = {
        score: 0,
        max:   factor.max,
        label: factor.label,
        value: rawValue,
        matched_band: 'no data',
        logic: `${factor.label}: no data → 0/${factor.max}`,
        status: 'missing'
      };
      totalScore += 0;
      continue;
    }

    // Find matching band — match by value field (case-insensitive substring)
    const val = String(rawValue).toLowerCase().trim();
    let matched = null;

    // 1st pass: exact match on band.value
    for (const band of factor.bands) {
      if (String(band.value || '').toLowerCase().trim() === val) { matched = band; break; }
    }
    // 2nd pass: substring match on band.label or band.value
    if (!matched) {
      for (const band of factor.bands) {
        const bv = String(band.value || band.label || '').toLowerCase();
        if (bv.includes(val) || val.includes(bv)) { matched = band; break; }
      }
    }
    // 3rd pass: first band whose label contains a key word from value
    if (!matched) {
      const words = val.split(/[\s_\-]+/).filter(w => w.length > 2);
      for (const band of factor.bands) {
        const bl = (band.label || '').toLowerCase();
        if (words.some(w => bl.includes(w))) { matched = band; break; }
      }
    }
    // Fallback: no band matched — score 0 (unknown value gets no credit)
    if (!matched && factor.bands.length > 0) {
      matched = null;
    }

    const pts = matched ? Number(matched.points) : 0;
    factorResults[factor.id] = {
      score:        pts,
      max:          factor.max,
      label:        factor.label,
      value:        rawValue,
      matched_band: matched?.label || 'unknown',
      logic:        `${factor.label}: "${rawValue}" → band "${matched?.label}" → ${pts}/${factor.max}`,
      status:       matched?.label || 'unknown'
    };
    totalScore += pts;
  }

  return {
    score:     Math.round(Math.min(totalScore, compConfig.weight || 999) * 100) / 100,
    max:       compConfig.weight || compConfig.factors.reduce((s, f) => s + f.max, 0),
    breakdown: factorResults,
    source:    'dynamic_db_config'
  };
}

// ─── Main Calculation ───

function calculateAll(extractedData, correlationData, dynamicConfig) {
  // ── If full component configs are available from DB, score dynamically ──────
  // dynamicConfig._scoring_components contains the full factor/band definitions
  // saved by the user in Masters > Per-CAT Scoring Configuration.
  // We score EACH component using those DB definitions.
  // If no DB config exists for a component, fall back to the hardcoded scorer.
  const dbComponents = dynamicConfig?.scoring_components ||
                       dynamicConfig?._scoring_components || null;

  // Component key mapping: engine key → DB config key
  const COMP_KEY_MAP = {
    medical_parameters:   ['medical', 'medical_parameters'],
    lifestyle_risk:       ['lifestyle', 'lifestyle_risk'],
    medical_history:      ['history', 'medical_history'],
    clinical_correlation: ['clinical', 'clinical_correlation'],
    documentation_quality:['documentation', 'documentation_quality']
  };

  function getDbComp(engineKey) {
    if (!dbComponents) return null;
    for (const alias of COMP_KEY_MAP[engineKey] || []) {
      if (dbComponents[alias]) return dbComponents[alias];
    }
    return null;
  }

  // Score each component — DB first, hardcoded fallback
  const components = {};
  const engineKeys = [
    'medical_parameters', 'lifestyle_risk', 'medical_history',
    'clinical_correlation', 'documentation_quality'
  ];
  const hardcodedScorers = {
    medical_parameters:    () => scoreMedicalParameters(extractedData),
    lifestyle_risk:        () => scoreLifestyleRisk(extractedData),
    medical_history:       () => scoreMedicalHistory(extractedData),
    clinical_correlation:  () => scoreClinicalCorrelation(correlationData, extractedData),
    documentation_quality: () => scoreDocumentationQuality(extractedData)
  };

  for (const key of engineKeys) {
    const dbComp = getDbComp(key);
    if (dbComp) {
      const dynResult = scoreComponentFromConfig(dbComp, extractedData, correlationData);
      components[key] = dynResult || hardcodedScorers[key]();
    } else {
      components[key] = hardcodedScorers[key]();
    }
  }

  // ── Apply component weights from DB config ──────────────────────────────────
  const dynWeights = dynamicConfig?.component_weights || null;
  const KEY_MAP = {
    medical_parameters:   ['medical_parameters', 'medical'],
    lifestyle_risk:       ['lifestyle_risk', 'lifestyle'],
    medical_history:      ['medical_history', 'history'],
    clinical_correlation: ['clinical_correlation', 'clinical', 'correlation'],
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
    totalScore = 0; maxScore = 0;
    for (const [key, comp] of Object.entries(components)) {
      const w = resolveWeight(key);
      if (w == null) {
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
    maxScore   = Object.values(components).reduce((sum, c) => sum + c.max,   0);
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

// ─── Contradiction Detection (runs before scoring) ────────────────────────────
// Checks 8 cross-pairs between free-text answers (Q2/Q3) and structured Yes/No
// answers (Q12, Q13, Q17, Q4, Q26, Q24/Q25, Q14, Q48).
// Returns { contradiction_count, contradiction_list[] }
function scoreContradictions(telemerData) {
  const contradiction_list = [];
  const answers  = telemerData?.answers || {};
  const details  = telemerData?.detail_text || {};
  const remarks  = (telemerData?.examiner_remarks || telemerData?.q48_remark || '').toLowerCase();
  const q2_text  = (details?.q2 || telemerData?.free_text_q2 || '').toLowerCase();
  const q3_text  = (details?.q3 || telemerData?.free_text_q3 || '').toLowerCase();
  const q5_text  = (details?.q5 || telemerData?.free_text_q5 || '').toLowerCase();

  const combined = q2_text + ' ' + q3_text + ' ' + q5_text + ' ' + remarks;

  function hasKeywords(text, keywords) {
    return keywords.some(k => text.includes(k));
  }

  // C-01: HTN confirmed in detail but Q12 = No
  if (hasKeywords(combined, ['htn', 'hypertension', 'high bp', 'blood pressure', 'telmisartan', 'amlodipine', 'enalapril', 'ramipril', 'losartan', 'metoprolol']) &&
      answers?.q12 === false) {
    contradiction_list.push({ check_id: 'C-01', description: 'HTN confirmed in Q2/Q3/Q48 detail but Q12 denies hypertension' });
  }

  // C-02: DM confirmed in detail but Q13 = No
  if (hasKeywords(combined, ['diabetes', 'dm', 'blood sugar', 'bsl', 'hba1c', 'metformin', 'glimepiride', 'glipizide', 'insulin', 'dapagliflozin']) &&
      answers?.q13 === false) {
    contradiction_list.push({ check_id: 'C-02', description: 'Diabetes confirmed in Q2/Q3/Q48 detail but Q13 denies diabetes' });
  }

  // C-03: Gallbladder surgery confirmed but Q17 = No
  if (hasKeywords(combined, ['gall', 'gallstone', 'cholecyst', 'gallbladder']) &&
      answers?.q17 === false) {
    contradiction_list.push({ check_id: 'C-03', description: 'Gallbladder surgery confirmed in Q2/Q5 detail but Q17 denies gallbladder disorder' });
  }

  // C-04: Active treatment declared but Q4 (treatment in last 5 yrs) = No
  const hasActiveTreatment = hasKeywords(combined, ['tab ', 'tablet', 'medicine', 'medication', 'mg od', 'mg bd', 'mg tds', '1od', '1bd', 'once a day', 'twice a day', 'insulin']);
  if (hasActiveTreatment && answers?.q4 === false) {
    contradiction_list.push({ check_id: 'C-04', description: 'Active medication confirmed in Q2/Q3 but Q4 denies any treatment in last 5 years' });
  }

  // C-05: DM or thyroid confirmed but Q26 (metabolic/endocrine) = No
  if (hasKeywords(combined, ['diabetes', 'dm', 'blood sugar', 'hypothyroid', 'thyroid', 'levothyroxine', 'thyroxine']) &&
      answers?.q26 === false) {
    contradiction_list.push({ check_id: 'C-05', description: 'Metabolic/endocrine condition confirmed in Q2/Q3 but Q26 denies endocrine/metabolic disorder' });
  }

  // C-06: Spine/lumbar surgery confirmed but Q24/Q25 = No
  if (hasKeywords(combined, ['spine', 'lumbar', 'sciatica', 'laminectomy', 'discectomy', 'back surgery', 'spinal surgery', 'mri spine']) &&
      (answers?.q24 === false || answers?.q25 === false)) {
    contradiction_list.push({ check_id: 'C-06', description: 'Spinal surgery confirmed in Q2/Q5 but Q24/Q25 denies musculoskeletal history' });
  }

  // C-07: Cardiac/HTN confirmed but Q14 (IHD history) = No
  if (hasKeywords(combined, ['stenting', 'ptca', 'cabg', 'open heart', 'heart attack', 'myocardial', 'ischemic heart']) &&
      answers?.q14 === false) {
    contradiction_list.push({ check_id: 'C-07', description: 'Cardiac procedure/IHD confirmed in detail but Q14 denies IHD/cardiac history' });
  }

  // C-08: Q48 doctor remarks mention condition not in Q2/Q3 structured answers
  if (remarks.length > 10) {
    const remarksAddNew = hasKeywords(remarks, ['htn', 'dm', 'diabetes', 'spine', 'gallstone', 'cancer', 'thyroid', 'kidney', 'liver']) &&
                          !hasKeywords(q2_text + q3_text, ['htn', 'dm', 'diabetes', 'spine', 'gallstone', 'cancer', 'thyroid', 'kidney', 'liver']);
    if (remarksAddNew) {
      contradiction_list.push({ check_id: 'C-08', description: 'Q48 doctor remarks mention condition not explicitly declared in Q2/Q3 responses' });
    }
  }

  return {
    contradiction_count: contradiction_list.length,
    contradiction_list,
    contradiction_penalty: Math.min(contradiction_list.length, 2) * 5
  };
}

// ─── Hard Override Rules (run before scoring, highest priority) ──────────────
// Returns { override_action, override_flags[], should_stop }
// override_action values: AUTO_DEFER | AUTO_DECLINE | MANDATORY_RE_MER | null
// should_stop: true means do not continue scoring
function evaluateHardOverrides(telemerData, extractedData, contradictionResult) {
  const override_flags = [];
  let override_action  = null;
  let should_stop      = false;

  const callingDate  = telemerData?.calling_date || extractedData?.calling_date || null;
  const history      = telemerData?.medical_history || extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const surgeries    = history?.surgical_history || [];
  const conditions   = history?.pre_existing_conditions || [];
  const remarks      = (telemerData?.examiner_remarks || telemerData?.q48_remark || '').toLowerCase();
  const answers      = telemerData?.answers || extractedData?.telemer_data?.answers || {};
  const proposer     = extractedData?.proposer_name || '';
  const insured      = extractedData?.insured_name  || extractedData?.telemer_data?.proposer_info?.name || '';

  // PRIORITY 1 — Surgery within 90 days
  for (const surg of surgeries) {
    if (surg.surgery_date && callingDate) {
      const daysAgo = Math.floor((new Date(callingDate) - new Date(surg.surgery_date)) / (1000 * 60 * 60 * 24));
      if (daysAgo < 90) {
        override_flags.push({
          type: 'AUTO_DEFER',
          priority: 1,
          reason: `Surgery within 90 days of TeleMER call (${daysAgo} days ago — ${surg.procedure || 'procedure'})`,
          source: 'surgical_history'
        });
        override_action = 'AUTO_DEFER';
        should_stop     = true;
      }
    }
  }

  // PRIORITY 2 — Identity / voice mismatch flagged by doctor in Q48
  const identityKeywords = ['voice younger', 'younger than age', 'younger one', 'voice mismatch', 'verify identity', 'identity concern', 'age mismatch'];
  if (identityKeywords.some(k => remarks.includes(k))) {
    override_flags.push({
      type: 'AUTO_DEFER',
      priority: 2,
      reason: 'TeleMER doctor flagged identity/voice mismatch in Q48 remarks — mandatory video KYC required',
      source: 'q48_remark'
    });
    if (!override_action) { override_action = 'AUTO_DEFER'; should_stop = true; }
  }

  // PRIORITY 3 — Active cancer, HIV, end-stage conditions
  const cancerKeywords    = ['active cancer', 'malignancy', 'cancer treatment', 'chemotherapy', 'radiotherapy'];
  const hivKeywords       = ['hiv positive', 'aids'];
  const endStageKeywords  = ['esrd', 'dialysis', 'end stage renal', 'end stage liver', 'lvef below 30'];
  const combined = remarks + JSON.stringify(conditions).toLowerCase();

  if (answers?.q28 === true || cancerKeywords.some(k => combined.includes(k))) {
    override_flags.push({ type: 'AUTO_DECLINE', priority: 3, reason: 'Active cancer / malignancy declared', source: 'Q28 or conditions' });
    if (!override_action) { override_action = 'AUTO_DECLINE'; should_stop = true; }
  }
  if (answers?.q18 === true || hivKeywords.some(k => combined.includes(k))) {
    override_flags.push({ type: 'AUTO_DECLINE', priority: 3, reason: 'HIV/AIDS declared', source: 'Q18' });
    if (!override_action) { override_action = 'AUTO_DECLINE'; should_stop = true; }
  }
  if (endStageKeywords.some(k => combined.includes(k))) {
    override_flags.push({ type: 'AUTO_DECLINE', priority: 3, reason: 'End-stage organ failure indicated', source: 'conditions' });
    if (!override_action) { override_action = 'AUTO_DECLINE'; should_stop = true; }
  }

  // PRIORITY 4 — 3+ contradictions → mandatory re-MER
  if (contradictionResult.contradiction_count >= 3) {
    override_flags.push({
      type: 'MANDATORY_RE_MER',
      priority: 4,
      reason: `${contradictionResult.contradiction_count} material contradictions found — TeleMER invalid, fresh call required`,
      source: 'contradiction_matrix'
    });
    if (!override_action) { override_action = 'MANDATORY_RE_MER'; should_stop = true; }
  }

  // PRIORITY 5 — Medication name unknown for active condition (non-stopping flag)
  for (const cond of conditions) {
    const medName = (cond.medication || '').trim().toLowerCase();
    const isActive = ['active', 'poorly_controlled', 'uncontrolled'].includes((cond.current_status || '').toLowerCase());
    if (isActive && (!medName || medName === 'unknown' || medName === 'not known')) {
      override_flags.push({
        type: 'MANDATORY_DOCS',
        priority: 5,
        reason: `Medication name unknown for active condition: ${cond.condition || 'unnamed'}`,
        source: 'current_medications',
        action_required: 'Obtain medication name, dose and prescribing doctor details before binding'
      });
    }
  }

  // PRIORITY 6 — Surgery <5 years with records unavailable (non-stopping flag)
  for (const surg of surgeries) {
    const surgYrsAgo    = surg.year ? (new Date(callingDate || Date.now()).getFullYear() - surg.year) : null;
    const recordsAvail  = surg.records_available !== false;
    if (surgYrsAgo !== null && surgYrsAgo < 5 && !recordsAvail) {
      override_flags.push({
        type: 'MANDATORY_DOCS',
        priority: 6,
        reason: `Surgery within last 5 years with records unavailable: ${surg.procedure || 'unnamed procedure'} (${surg.year})`,
        source: 'surgical_history',
        action_required: 'Obtain discharge summary or statutory declaration'
      });
    }
  }

  // PRIORITY 7 — First-degree family history of cancer/blood cancer/stroke (non-stopping flag)
  const familyHistory = history?.family_history || {};
  const familyDetails = (familyHistory.details || '').toLowerCase();
  if (familyHistory.cancer === true || familyHistory.stroke === true ||
      familyDetails.includes('cancer') || familyDetails.includes('leukaemia') || familyDetails.includes('lymphoma') || familyDetails.includes('blood cancer')) {
    override_flags.push({
      type: 'SENIOR_REVIEW',
      priority: 7,
      reason: 'First-degree family history of cancer, blood disorder or stroke — senior underwriter review required',
      source: 'family_history'
    });
  }

  // PRIORITY 8 — Third-party proposal (proposer ≠ insured, non-stopping flag)
  if (proposer && insured && proposer.toLowerCase().trim() !== insured.toLowerCase().trim()) {
    override_flags.push({
      type: 'SENIOR_REVIEW',
      priority: 8,
      reason: `Third-party proposal — proposer (${proposer}) ≠ insured (${insured}). Verify insurable interest.`,
      source: 'proposer_vs_insured'
    });
  }

  // Build mandatory docs list from MANDATORY_DOCS flags
  const mandatory_docs = override_flags
    .filter(f => f.type === 'MANDATORY_DOCS' && f.action_required)
    .map(f => f.action_required);

  return { override_action, override_flags, should_stop, mandatory_docs };
}

// ─── Hybrid TeleMER Risk Calculator — Main Entry Point ───────────────────────
// Phase 1: C1(25) + C2(20) + C3(20) + C4(15) + C6(5) + C7(5) = 90 pts → scaled to 100
// Phase 2: add C5 documentation quality (10 pts), remove scaling multiplier
function calculateTeleMERRisk(telemerData, voiceAnalysis, correlationData) {
  const extractedData = telemerData; // alias for compatibility with existing component scorers

  // ── Step 1: Contradiction Detection ─────────────────────────────────────────
  const contradictionResult = scoreContradictions(telemerData);

  // ── Step 2: Hard Override Rules ──────────────────────────────────────────────
  const overrideResult = evaluateHardOverrides(telemerData, extractedData, contradictionResult);

  // If AUTO_DEFER, AUTO_DECLINE or MANDATORY_RE_MER fires → stop scoring, return override decision
  if (overrideResult.should_stop) {
    const overrideDecisionMap = {
      'AUTO_DEFER':      'defer',
      'AUTO_DECLINE':    'decline',
      'MANDATORY_RE_MER':'mandatory_re_mer'
    };
    return {
      risk_score: { total: 0, max: 100, normalized: 0, grade: 'N/A', components: {} },
      decision: {
        recommendation:   overrideDecisionMap[overrideResult.override_action] || 'refer',
        loading_percentage: 0,
        exclusions:         [],
        rationale:          `Scoring stopped — override rule fired: ${overrideResult.override_action}. See override_flags for details.`
      },
      override_action:      overrideResult.override_action,
      override_flags:       overrideResult.override_flags,
      contradiction_count:  contradictionResult.contradiction_count,
      contradiction_list:   contradictionResult.contradiction_list,
      mandatory_docs:       overrideResult.mandatory_docs,
      auto_decision_eligible: false,
      calculated_at:        new Date().toISOString()
    };
  }

  // ── Step 3: Score all 6 components (Phase 1) ────────────────────────────────
  const C1 = scoreLifestyleRisk(extractedData);
  const C2 = scoreMedicalHistory(extractedData);
  const C3 = scoreClinicalCorrelation(correlationData || {}, extractedData);
  const C4 = scoreHybridCardiovascular(extractedData);
  const C6 = scoreHybridSurgicalGI(extractedData);
  const C7 = scoreHybridFamilyHistory(extractedData);

  const components = {
    lifestyle_risk:       C1,
    medical_history:      C2,
    clinical_correlation: C3,
    cardiovascular:       C4,
    surgical_gi:          C6,
    family_history:       C7
  };

  // ── Step 4: Aggregate — Phase 1 max = 90, scale to 100 ─────────────────────
  const phase1Total = C1.score + C2.score + C3.score + C4.score + C6.score + C7.score;
  const penaltyAdjusted = Math.max(0, phase1Total - contradictionResult.contradiction_penalty);
  const scaledTotal = Math.min(100, Math.round((penaltyAdjusted / 90) * 100 * 100) / 100);

  // ── Step 5: Grade ────────────────────────────────────────────────────────────
  let grade;
  if (scaledTotal >= 90) grade = 'A+';
  else if (scaledTotal >= 80) grade = 'A';
  else if (scaledTotal >= 70) grade = 'B+';
  else if (scaledTotal >= 60) grade = 'B';
  else if (scaledTotal >= 50) grade = 'C';
  else grade = 'D';

  // ── Step 6: Decision band ────────────────────────────────────────────────────
  let recommendation, loading_percentage = 0;
  if (scaledTotal >= 80) {
    recommendation = 'accept_standard';
    loading_percentage = 0;
  } else if (scaledTotal >= 65) {
    recommendation = 'accept_with_loading';
    loading_percentage = computeHybridLoading(extractedData, C4, C6, C7);
  } else if (scaledTotal >= 50) {
    recommendation = 'refer';
    loading_percentage = computeHybridLoading(extractedData, C4, C6, C7);
  } else {
    recommendation = 'decline';
    loading_percentage = 0;
  }

  // Senior review flag from override results
  const seniorReviewRequired = overrideResult.override_flags.some(f => f.type === 'SENIOR_REVIEW') || C7.needs_senior_review;

  // Build PED list per condition
  const ped_per_condition = buildPEDList(extractedData);

  // Build pre-policy tests list
  const pre_policy_tests = buildPrePolicyTests(scaledTotal);

  return {
    risk_score: {
      total:      Math.round(penaltyAdjusted * 100) / 100,
      max:        90,
      normalized: scaledTotal,
      grade,
      components,
      phase: 1,
      phase1_note: 'Score scaled from 90-pt base to 100. Phase 2 adds documentation quality (10 pts).'
    },
    decision: {
      recommendation,
      loading_percentage,
      exclusions:  [],
      rationale:   generateHybridRationale(components, scaledTotal, grade, recommendation, contradictionResult, overrideResult)
    },
    override_action:       overrideResult.override_action,
    override_flags:        overrideResult.override_flags,
    contradiction_count:   contradictionResult.contradiction_count,
    contradiction_list:    contradictionResult.contradiction_list,
    contradiction_penalty: contradictionResult.contradiction_penalty,
    mandatory_docs:        overrideResult.mandatory_docs,
    pre_policy_tests,
    ped_per_condition,
    senior_review_required: seniorReviewRequired,
    auto_decision_eligible: scaledTotal >= 80 && contradictionResult.contradiction_count === 0 && overrideResult.override_flags.length === 0,
    calculated_at:          new Date().toISOString()
  };
}

// ─── Helper: compute additive loading % from conditions (capped at 50%) ──────
function computeHybridLoading(extractedData, C4, C6, C7) {
  let total = 0;
  const history    = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const conditions = history?.pre_existing_conditions || [];

  for (const cond of conditions) {
    const name   = (cond.condition || '').toLowerCase();
    const status = (cond._scored_tier || cond.current_status || '').toLowerCase();
    const sinceYr = cond.since_year || null;
    const callingYr = new Date().getFullYear();
    const durationYrs = sinceYr ? callingYr - sinceYr : null;

    if (name.includes('hypertension') || name.includes('htn') || name.includes('blood pressure')) {
      if (status.includes('uncontrolled'))     total += 25;
      else if (durationYrs && durationYrs <= 1) total += 10;
      else                                      total += 15;
    } else if (name.includes('diabetes') || name.includes('dm')) {
      if (status.includes('uncontrolled'))          total += 35;
      else if (durationYrs && durationYrs <= 3)     total += 15;
      else if (durationYrs && durationYrs <= 7)     total += 20;
      else                                           total += 25;
    }
  }

  // BMI loading
  const bmi = parseFloat(extractedData?.physical_exam?.bmi?.value || extractedData?.bmi || 0);
  if (bmi >= 35)      total += 20;
  else if (bmi >= 30) total += 10;
  else if (bmi >= 25) total += 5;

  // Family history cancer/stroke loading
  if (C7?.needs_senior_review) total += 5;

  // Multi-PEC comorbidity loading
  const activePECCount = conditions.filter(c => ['active_controlled','active_uncontrolled'].includes(c._scored_tier || '')).length;
  if (activePECCount >= 2) total += 5;

  return Math.min(50, total);
}

// ─── Helper: build PED per condition list ────────────────────────────────────
function buildPEDList(extractedData) {
  const ped = [];
  const history    = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const conditions = history?.pre_existing_conditions || [];
  const surgeries  = history?.surgical_history || [];

  for (const cond of conditions) {
    const name   = (cond.condition || '').toLowerCase();
    const tier   = cond._scored_tier || cond.current_status || '';
    const sinceYr = cond.since_year;
    const callingYr = new Date().getFullYear();
    const durationYrs = sinceYr ? callingYr - sinceYr : null;

    if (name.includes('hypertension') || name.includes('htn')) {
      const yrs = tier === 'active_uncontrolled' ? 4 : (durationYrs && durationYrs <= 1) ? 2 : 3;
      ped.push({ condition: cond.condition || 'Hypertension', ped_years: yrs, exclusion_type: 'time_limited', scope: 'Hypertension and cardiovascular events' });
    } else if (name.includes('diabetes') || name.includes('dm')) {
      ped.push({ condition: cond.condition || 'Diabetes', ped_years: 4, exclusion_type: 'time_limited', scope: 'Diabetes and related complications' });
    } else if (name.includes('thyroid')) {
      ped.push({ condition: cond.condition || 'Thyroid disorder', ped_years: 2, exclusion_type: 'time_limited', scope: 'Thyroid disorders' });
    } else if (name.includes('asthma') || name.includes('copd')) {
      ped.push({ condition: cond.condition || 'Asthma/COPD', ped_years: 2, exclusion_type: 'time_limited', scope: 'Respiratory conditions' });
    } else if (tier && tier !== 'none') {
      ped.push({ condition: cond.condition || 'Pre-existing condition', ped_years: 3, exclusion_type: 'time_limited', scope: 'Standard PED per IRDAI' });
    }
  }

  for (const surg of surgeries) {
    const proc = (surg.procedure || '').toLowerCase();
    const yr   = surg.year || null;
    const callingYr = new Date().getFullYear();
    const yrsAgo = yr ? callingYr - yr : null;

    if (proc.includes('spine') || proc.includes('lumbar') || proc.includes('sciatica')) {
      const pedYrs = yrsAgo && yrsAgo < 1 ? 4 : 3;
      ped.push({ condition: surg.procedure || 'Spinal surgery', ped_years: pedYrs, exclusion_type: 'time_limited_plus_spine_exclusion', scope: 'Spinal/back conditions' });
    } else if (proc.includes('gall') || proc.includes('cholecyst')) {
      const pedYrs = yrsAgo && yrsAgo < 5 ? 3 : 2;
      ped.push({ condition: surg.procedure || 'Gallbladder surgery', ped_years: pedYrs, exclusion_type: 'time_limited', scope: 'Gallbladder and GI conditions' });
    }
  }

  return ped;
}

// ─── Helper: build pre-policy tests list based on decision band ───────────────
function buildPrePolicyTests(scaledTotal) {
  if (scaledTotal >= 80)      return [];
  if (scaledTotal >= 65)      return ['FBS', 'Urine R/E'];
  if (scaledTotal >= 50)      return ['FBS', 'HbA1c', 'Lipid profile', 'ECG', 'Urine R/E'];
  return ['FBS', 'HbA1c', 'Lipid profile', 'ECG', 'Urine R/E', 'Full blood panel', 'Specialist report'];
}

// ─── Helper: generate plain-English rationale ────────────────────────────────
function generateHybridRationale(components, score, grade, decision, contradictionResult, overrideResult) {
  const parts = [];
  parts.push(`TeleMER Hybrid Score: ${score}/100 (Grade: ${grade})`);

  const compLabels = {
    lifestyle_risk:       'Lifestyle Risk',
    medical_history:      'Medical History',
    clinical_correlation: 'Clinical Correlation',
    cardiovascular:       'Cardiovascular',
    surgical_gi:          'Surgical / GI',
    family_history:       'Family History'
  };
  for (const [key, comp] of Object.entries(components)) {
    parts.push(`${compLabels[key] || key}: ${Math.round(comp.score)}/${comp.max}`);
  }

  if (contradictionResult.contradiction_count > 0) {
    parts.push(`Contradictions detected: ${contradictionResult.contradiction_count} (penalty: -${contradictionResult.contradiction_penalty} pts)`);
  }

  const nonStopFlags = overrideResult.override_flags.filter(f => f.type === 'MANDATORY_DOCS' || f.type === 'SENIOR_REVIEW');
  for (const flag of nonStopFlags) {
    parts.push(`${flag.type}: ${flag.reason}`);
  }

  const decisionText = {
    accept_standard:    'Recommendation: Accept at standard rates.',
    accept_with_loading:'Recommendation: Accept with premium loading. Risk factors identified.',
    refer:              'Recommendation: Refer to senior underwriter. Multiple risk factors require manual review.',
    decline:            'Recommendation: Decline. Risk profile exceeds acceptable thresholds.',
    defer:              'Recommendation: Defer. Cannot underwrite until blocking condition is resolved.',
    mandatory_re_mer:   'Recommendation: Mandatory re-TeleMER. Current TeleMER is invalid due to material contradictions.'
  };
  parts.push(decisionText[decision] || `Decision: ${decision}`);

  return parts.join('\n');
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
  scoreHybridCardiovascular,
  scoreHybridSurgicalGI,
  scoreHybridFamilyHistory,
  scoreContradictions,
  evaluateHardOverrides,
  calculateFullEM,
  EM_TABLES
};