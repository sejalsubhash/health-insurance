/**
 * telemer-score.js — Standalone rule-based TeleMER scoring model
 * ----------------------------------------------------------------
 * SBI HealthAssure TeleMER (48-question Yes/No + free-text remarks).
 *
 * Design principles (per requirements):
 *   - Score out of 100. HIGH score = healthier / lower-risk (good applicant).
 *   - 5 parameters, each built from individual 3-5 point question-based checks
 *     that sum up and are capped at the parameter max.
 *   - The free-text REMARKS are the source of truth for the clinical picture.
 *     Where the Yes/No boxes contradict the remarks, the remarks win for
 *     medical scoring; the contradiction only dents Documentation Quality.
 *   - Always produces a 0-100 score (no hard stop).
 *
 * Point distribution (sums to 100):
 *   1) Medical Parameters    40   (objective vitals/labs from remarks + form)
 *   2) Medical History       20   (disclosed conditions, chronicity, family hx)
 *   3) Lifestyle Risk        15   (tobacco/alcohol, weight change, BMI, COVID)
 *   4) Clinical Correlation  15   (drug<->condition match, multi-system load, CV proxy)
 *   5) Documentation Quality 10   (completeness, examiner detail, form consistency)
 *
 * No external dependencies. No reuse of any existing engine.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// INPUT SHAPE (caller builds this from the parsed PDF):
//
// {
//   age: Number, gender: 'male'|'female',
//   bmi: Number, height_cm: Number, weight_kg: Number,
//   answers: { q4:Bool, q6:Bool, q7:Bool, q12:Bool, q13:Bool, q26:Bool, ... },
//   remarks: String,                 // combined Q2/Q3/Q48 doctor narrative
//   conditions: [                    // parsed FROM the remarks (source of truth)
//     { name, duration_years, medication, status:'controlled'|'uncontrolled'|'untreated',
//       systolic, diastolic, fbs, hba1c }
//   ],
//   family_history: [String],        // first-degree conditions, [] if none
//   reports_available: Bool,
//   examiner: { name, reg_no }
// }
// ─────────────────────────────────────────────────────────────────────────────

const PARAM_MAX = {
  medical_parameters:    40,
  medical_history:       20,
  lifestyle_risk:        15,
  clinical_correlation:  15,
  documentation_quality: 10
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v => Math.round(v * 100) / 100;
const lc = s => (s || '').toString().toLowerCase();

// ── 1) MEDICAL PARAMETERS (max 40) ───────────────────────────────────────────
// Objective measurables. Each check awards points for the healthy value.
function scoreMedicalParameters(d) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic });

  // BMI — 8 pts
  const bmi = d.bmi || 0;
  let bmiPts;
  if (bmi === 0)               bmiPts = 4;            // unknown → neutral-ish
  else if (bmi < 18.5)         bmiPts = 5;            // underweight
  else if (bmi <= 24.9)        bmiPts = 8;            // normal
  else if (bmi <= 29.9)        bmiPts = 5;            // overweight
  else if (bmi <= 34.9)        bmiPts = 3;            // obese I
  else                         bmiPts = 1;            // obese II+
  add('BMI', bmiPts, 8, `BMI ${bmi || 'unknown'} → ${bmiPts}/8`);

  // Blood pressure — 10 pts (from remarks; healthy = lower)
  const sys = maxReading(d.conditions, 'systolic');
  let bpPts, bpLogic;
  if (!sys)                    { bpPts = 5; bpLogic = 'no BP reading → 5/10'; }
  else if (sys < 120)          { bpPts = 10; bpLogic = `${sys} systolic (optimal) → 10/10`; }
  else if (sys < 130)          { bpPts = 9;  bpLogic = `${sys} systolic (normal) → 9/10`; }
  else if (sys < 140)          { bpPts = 7;  bpLogic = `${sys} systolic (high-normal/controlled) → 7/10`; }
  else if (sys < 160)          { bpPts = 4;  bpLogic = `${sys} systolic (stage 1) → 4/10`; }
  else                         { bpPts = 1;  bpLogic = `${sys} systolic (stage 2) → 1/10`; }
  add('Blood Pressure', bpPts, 10, bpLogic);

  // Fasting glucose — 10 pts
  const fbs = maxReading(d.conditions, 'fbs');
  let fbsPts, fbsLogic;
  if (!fbs)                    { fbsPts = 5; fbsLogic = 'no fasting glucose → 5/10'; }
  else if (fbs < 100)          { fbsPts = 10; fbsLogic = `${fbs} mg/dl (normal) → 10/10`; }
  else if (fbs <= 110)         { fbsPts = 8;  fbsLogic = `${fbs} mg/dl (well-controlled) → 8/10`; }
  else if (fbs <= 125)         { fbsPts = 6;  fbsLogic = `${fbs} mg/dl (impaired/controlled) → 6/10`; }
  else if (fbs <= 180)         { fbsPts = 3;  fbsLogic = `${fbs} mg/dl (elevated) → 3/10`; }
  else                         { fbsPts = 1;  fbsLogic = `${fbs} mg/dl (poor) → 1/10`; }
  add('Fasting Glucose', fbsPts, 10, fbsLogic);

  // HbA1c — 6 pts (if available)
  const hba1c = maxReading(d.conditions, 'hba1c');
  let a1cPts, a1cLogic;
  if (!hba1c)                  { a1cPts = 4; a1cLogic = 'no HbA1c → 4/6 (neutral)'; }
  else if (hba1c < 5.7)        { a1cPts = 6; a1cLogic = `${hba1c}% (normal) → 6/6`; }
  else if (hba1c < 6.5)        { a1cPts = 4; a1cLogic = `${hba1c}% (pre-diabetic) → 4/6`; }
  else if (hba1c < 7.5)        { a1cPts = 3; a1cLogic = `${hba1c}% (controlled DM) → 3/6`; }
  else                         { a1cPts = 1; a1cLogic = `${hba1c}% (uncontrolled) → 1/6`; }
  add('HbA1c', a1cPts, 6, a1cLogic);

  // Age band — 6 pts (older = lower)
  const age = d.age || 0;
  let agePts;
  if (age === 0)               agePts = 3;
  else if (age < 35)           agePts = 6;
  else if (age < 45)           agePts = 5;
  else if (age < 55)           agePts = 4;
  else if (age < 65)           agePts = 3;
  else                         agePts = 2;
  add('Age Band', agePts, 6, `Age ${age || 'unknown'} → ${agePts}/6`);

  const total = clamp(checks.reduce((s, c) => s + c.points, 0), 0, PARAM_MAX.medical_parameters);
  return { score: round2(total), max: PARAM_MAX.medical_parameters, checks };
}

// ── 2) MEDICAL HISTORY (max 20) ──────────────────────────────────────────────
function scoreMedicalHistory(d) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic });
  const conds = d.conditions || [];

  // Pre-existing condition burden — start at 12, deduct per condition by severity
  let pecScore = 12;
  const notes = [];
  for (const c of conds) {
    const status = lc(c.status);
    let ded;
    if (status === 'untreated')        ded = 1;  // disclosed, no treatment, minor
    else if (status === 'controlled')  ded = 2;  // active but controlled
    else if (status === 'uncontrolled')ded = 5;  // active, poorly controlled
    else                               ded = 2;  // default: active
    pecScore -= ded;
    notes.push(`${c.name}(${status||'active'}) -${ded}`);
  }
  pecScore = clamp(pecScore, 0, 12);
  add('Pre-existing Conditions', pecScore, 12,
      conds.length ? `${conds.length} cond: ${notes.join(', ')} → ${pecScore}/12` : 'none → 12/12');

  // Chronicity bonus/penalty — 4 pts (long well-controlled is better than new uncontrolled)
  let chronPts = 4;
  for (const c of conds) {
    if (lc(c.status) === 'uncontrolled') chronPts -= 2;
  }
  chronPts = clamp(chronPts, 0, 4);
  add('Condition Control', chronPts, 4, `control adjustment → ${chronPts}/4`);

  // Family history — 4 pts
  const fam = d.family_history || [];
  const serious = fam.some(f => /cancer|stroke|cardiac|heart/i.test(f));
  let famPts = fam.length === 0 ? 4 : (serious ? 1 : 2);
  add('Family History', famPts, 4,
      fam.length === 0 ? 'no family history → 4/4' : `${fam.join(', ')} → ${famPts}/4`);

  const total = clamp(checks.reduce((s, c) => s + c.points, 0), 0, PARAM_MAX.medical_history);
  return { score: round2(total), max: PARAM_MAX.medical_history, checks };
}

// ── 3) LIFESTYLE RISK (max 15) ───────────────────────────────────────────────
function scoreLifestyle(d) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic });
  const r = lc(d.remarks);

  // Tobacco / alcohol — 7 pts (Q7). Remarks win; default to clean if Q7=No and no mention.
  const usesTobacco = /smok|cigarette|beedi|gutkha|pan|tobacco|khaini/.test(r);
  const usesAlcohol = /alcohol|drink|whisky|beer|wine/.test(r) && !/no alcohol|nil alcohol/.test(r);
  let subPts = 7;
  if (usesTobacco) subPts -= 4;
  if (usesAlcohol) subPts -= 3;
  subPts = clamp(subPts, 0, 7);
  add('Tobacco/Alcohol', subPts, 7,
      `tobacco:${usesTobacco} alcohol:${usesAlcohol} → ${subPts}/7`);

  // Weight stability — 4 pts (Q6)
  const weightChange = d.answers && d.answers.q6 === true;
  const wPts = weightChange ? 1 : 4;
  add('Weight Stability', wPts, 4, weightChange ? 'recent weight change → 1/4' : 'stable weight → 4/4');

  // BMI as lifestyle proxy — 4 pts
  const bmi = d.bmi || 0;
  let bmiPts;
  if (bmi === 0)        bmiPts = 2;
  else if (bmi <= 24.9) bmiPts = 4;
  else if (bmi <= 29.9) bmiPts = 3;
  else if (bmi <= 34.9) bmiPts = 2;
  else                  bmiPts = 1;
  add('BMI (lifestyle proxy)', bmiPts, 4, `BMI ${bmi || 'unknown'} → ${bmiPts}/4`);

  const total = clamp(checks.reduce((s, c) => s + c.points, 0), 0, PARAM_MAX.lifestyle_risk);
  return { score: round2(total), max: PARAM_MAX.lifestyle_risk, checks };
}

// ── 4) CLINICAL CORRELATION (max 15) ─────────────────────────────────────────
function scoreClinicalCorrelation(d) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic });
  const conds = d.conditions || [];

  // Drug<->condition match — 5 pts (does each disclosed condition have a matching med?)
  let matched = 0;
  for (const c of conds) {
    const med = Array.isArray(c.medication) ? c.medication.join(', ') : String(c.medication || '');
    if (med.trim() && med.trim().toLowerCase() !== 'unknown') matched++;
  }
  let drugPts;
  if (conds.length === 0)        drugPts = 5;                       // nothing to mismatch
  else if (matched === conds.length) drugPts = 5;                  // all conditions medicated coherently
  else if (matched > 0)          drugPts = 3;
  else                           drugPts = 1;
  add('Drug-Condition Match', drugPts, 5,
      conds.length === 0 ? 'no conditions → 5/5' : `${matched}/${conds.length} conditions medicated → ${drugPts}/5`);

  // Multi-system load — 5 pts (more distinct active systems = lower)
  const systems = new Set();
  for (const c of conds) {
    const n = lc(c.name);
    if (/diabet|dm|sugar|thyroid|endocrine/.test(n)) systems.add('endocrine');
    else if (/hypertension|htn|cardiac|heart|bp/.test(n)) systems.add('cardiovascular');
    else if (/varicose|vein|vascular/.test(n)) systems.add('vascular');
    else if (/kidney|renal|liver|gi|gall/.test(n)) systems.add('gi_renal');
    else systems.add('other');
  }
  const sysCount = systems.size;
  let sysPts;
  if (sysCount === 0)      sysPts = 5;
  else if (sysCount === 1) sysPts = 4;
  else if (sysCount === 2) sysPts = 3;
  else if (sysCount === 3) sysPts = 2;
  else                     sysPts = 1;
  add('Multi-System Load', sysPts, 5,
      `${sysCount} system(s): ${[...systems].join(', ') || 'none'} → ${sysPts}/5`);

  // Cardiovascular proxy — 5 pts (age + BMI + BP + DM comorbidity factors)
  const age = d.age || 0;
  const bmi = d.bmi || 0;
  const sys = maxReading(conds, 'systolic');
  const hasDM = conds.some(c => /diabet|dm|sugar/.test(lc(c.name)));
  let protective = 0;
  if (age && age < 55) protective++;
  if (bmi && bmi < 30) protective++;
  if (!sys || sys < 140) protective++;
  if (!hasDM) protective++;
  if (conds.length < 3) protective++;
  const cvPts = clamp(protective, 1, 5);
  add('Cardiovascular Proxy', cvPts, 5,
      `${protective}/5 protective factors → ${cvPts}/5`);

  const total = clamp(checks.reduce((s, c) => s + c.points, 0), 0, PARAM_MAX.clinical_correlation);
  return { score: round2(total), max: PARAM_MAX.clinical_correlation, checks };
}

// ── 5) DOCUMENTATION QUALITY (max 10) ────────────────────────────────────────
// This is where Yes/No-vs-remarks contradictions land.
function scoreDocumentationQuality(d) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic });

  // Completeness — 4 pts (do conditions have duration + medication + reading?)
  const conds = d.conditions || [];
  let comp = 4;
  if (conds.length > 0) {
    let full = 0;
    for (const c of conds) {
      const hasDur = c.duration_years != null;
      const hasMed = !!(c.medication && String(c.medication).trim());
      const hasRead = !!(c.systolic || c.fbs || c.hba1c);
      if (hasDur && hasMed && hasRead) full++;
    }
    comp = round2(4 * (full / conds.length));
  }
  add('Completeness', comp, 4, `${conds.length} condition(s) fully described → ${comp}/4`);

  // Examiner detail + reports — 3 pts
  let det = 0;
  if (d.examiner && d.examiner.name) det += 1.5;
  if (d.examiner && d.examiner.reg_no) det += 0.5;
  if (d.reports_available) det += 1;
  det = clamp(det, 0, 3);
  add('Examiner & Reports', det, 3, `examiner+reports → ${det}/3`);

  // Form consistency — 3 pts (contradiction count between remarks and Yes/No boxes)
  const contradictions = detectContradictions(d);
  let cons;
  if (contradictions.length === 0)      cons = 3;
  else if (contradictions.length === 1) cons = 2;
  else if (contradictions.length === 2) cons = 1;
  else                                  cons = 0;
  add('Form Consistency', cons, 3,
      `${contradictions.length} contradiction(s) → ${cons}/3`);

  const total = clamp(checks.reduce((s, c) => s + c.points, 0), 0, PARAM_MAX.documentation_quality);
  return { score: round2(total), max: PARAM_MAX.documentation_quality, checks, contradictions };
}

// ── Contradiction detector (remarks say condition, but box says No) ──────────
function detectContradictions(d) {
  const r = lc(d.remarks);
  const a = d.answers || {};
  const found = [];
  const has = (...kw) => kw.some(k => r.includes(k));

  if (has('htn', 'hypertension', 'coversyl', 'blood pressure') && a.q12 === false)
    found.push('HTN in remarks but Q12 (HTN) = No');
  if (has('dm', 'diabet', 'janumet', 'sugar') && a.q13 === false)
    found.push('DM in remarks but Q13 (Diabetes) = No');
  if (has('dm', 'diabet', 'thyroid', 'janumet') && a.q26 === false)
    found.push('DM/endocrine in remarks but Q26 (Endocrine) = No');
  if ((d.conditions || []).some(c => c.medication) && a.q4 === false)
    found.push('On active medication but Q4 (treated in 5 yrs) = No');
  return found;
}

const maxReading = (conds, field) => {
  let m = 0;
  for (const c of (conds || [])) {
    const v = parseFloat(c[field]);
    if (!isNaN(v) && v > m) m = v;
  }
  return m;
};

// ── Decision band ────────────────────────────────────────────────────────────
function resolveBand(score) {
  if (score >= 80) return { label: 'Standard Accept', loading: '0%' };
  if (score >= 65) return { label: 'Mild Load', loading: '5-15%' };
  if (score >= 50) return { label: 'Moderate Load', loading: '15-30%' };
  if (score >= 35) return { label: 'Heavy Load', loading: '30-50%' };
  return { label: 'Refer / Decline', loading: 'N/A' };
}

// ── MAIN ENTRY POINT ─────────────────────────────────────────────────────────
function scoreTeleMER(d) {
  const p1 = scoreMedicalParameters(d);
  const p2 = scoreMedicalHistory(d);
  const p3 = scoreLifestyle(d);
  const p4 = scoreClinicalCorrelation(d);
  const p5 = scoreDocumentationQuality(d);

  const total = round2(p1.score + p2.score + p3.score + p4.score + p5.score);
  const band = resolveBand(total);

  return {
    applicant: d.name || d.applicant_name || 'Applicant',
    total_score: total,
    max_score: 100,
    interpretation: 'Higher score = healthier / lower-risk',
    decision_band: band.label,
    indicative_loading: band.loading,
    parameters: {
      medical_parameters:    p1,
      medical_history:       p2,
      lifestyle_risk:        p3,
      clinical_correlation:  p4,
      documentation_quality: p5
    },
    review_notes: p5.contradictions,   // remark-vs-box mismatches surfaced for UW
    decision_basis: 'Clinical scoring driven by free-text remarks; Yes/No contradictions affect Documentation Quality only.',
    scored_at: new Date().toISOString()
  };
}

// ── Grade from a 0-100 score ─────────────────────────────────────────────────
function gradeFor(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B+';
  if (score >= 60) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

// ── Frontend adapter ─────────────────────────────────────────────────────────
// Converts the model output into the exact shape index.html's "calculations"
// view expects: analysis.component_analysis.<param>.{score,max,percentage,breakdown}
// where each breakdown entry = { score, max, status, logic }, plus
// analysis.risk_score.{normalized,grade}.
function toFrontendShape(result) {
  const pct = (s, m) => m ? Math.round((s / m) * 100) : 0;

  // Derive a compact status label from a check's points ratio
  const statusFor = (pts, max) => {
    const r = max ? pts / max : 0;
    if (r >= 0.8) return 'good';
    if (r >= 0.5) return 'moderate';
    return 'adverse';
  };

  const buildBreakdown = (param) => {
    const out = {};
    for (const c of param.checks) {
      const key = c.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      out[key] = {
        score: c.points,
        max: c.max,
        status: statusFor(c.points, c.max),
        logic: c.logic
      };
    }
    return out;
  };

  const component_analysis = {};
  for (const [name, param] of Object.entries(result.parameters)) {
    component_analysis[name] = {
      score: param.score,
      max: param.max,
      percentage: pct(param.score, param.max),
      breakdown: buildBreakdown(param)
    };
  }

  return {
    component_analysis,
    risk_score: {
      normalized: result.total_score,
      grade: gradeFor(result.total_score),
      total: result.total_score,
      max: 100
    },
    decision_band: result.decision_band,
    indicative_loading: result.indicative_loading,
    review_notes: result.review_notes,
    decision_basis: result.decision_basis
  };
}

// ── Extractor → model input mapper ───────────────────────────────────────────
// Converts the claude-extractor `telemer_data` shape into scoreTeleMER() input.
// The extractor gives structured fields (no flat remarks string, no Q-answers map,
// no numeric BP/glucose), so we reconstruct what we can and degrade gracefully.
function fromExtractorData(telemer_data, opts = {}) {
  const td = telemer_data || {};
  const proposer = td.proposer_info || {};
  const mh = td.medical_history || {};
  const ls = td.lifestyle || {};
  const fam = mh.family_history || {};

  // Conditions: map extractor's pre_existing_conditions → model conditions
  const conditions = (mh.pre_existing_conditions || []).map(c => {
    const status = String(c.current_status || 'active').toLowerCase();
    const rd = c.readings || {};
    return {
      name: c.condition || '',
      duration_years: c.since_year ? Math.max(0, (new Date().getFullYear() - c.since_year)) : null,
      medication: Array.isArray(c.medication) ? c.medication.join(', ') : String(c.medication || ''),
      status: status === 'resolved' ? 'controlled' : status,  // model knows controlled/uncontrolled/untreated
      // numeric readings now come from the extractor (opts.readings still wins if supplied)
      systolic: (opts.readings && opts.readings.systolic) || rd.systolic || null,
      diastolic: (opts.readings && opts.readings.diastolic) || rd.diastolic || null,
      fbs: (opts.readings && opts.readings.fbs) || rd.fbs || null,
      hba1c: (opts.readings && opts.readings.hba1c) || rd.hba1c || null
    };
  });

  // Family history: booleans → array of condition names
  const family_history = [];
  if (fam.cancer) family_history.push('cancer');
  if (fam.stroke) family_history.push('stroke');
  if (fam.cardiac) family_history.push('cardiac');
  if (fam.diabetes) family_history.push('diabetes');
  if (fam.hypertension) family_history.push('hypertension');

  // Reconstruct a remarks string from structured fields + any raw remark passed in opts
  const remarkParts = [];
  for (const c of (mh.pre_existing_conditions || [])) {
    remarkParts.push(`${c.condition || ''}${c.since_year ? ' since ' + c.since_year : ''}${c.medication ? ' on ' + c.medication : ''} (${c.current_status || 'active'})`);
  }
  const remarks = opts.raw_remarks || td.examiner_remarks_verbatim || td.remarks || remarkParts.join('. ');

  // Lifestyle: encode into remarks keywords the model scans for
  let lifestyleRemark = '';
  if (ls.smoking && ls.smoking.status === 'current') lifestyleRemark += ' smoker';
  if (ls.tobacco_chewing && ls.tobacco_chewing.status === 'current') lifestyleRemark += ' tobacco';
  if (ls.alcohol && (ls.alcohol.status === 'regular' || ls.alcohol.status === 'heavy')) lifestyleRemark += ' alcohol';

  // BMI: from opts (the engine elsewhere derives it from height/weight) or proposer
  const bmi = opts.bmi || proposer.bmi || 0;

  return {
    name: proposer.name || 'Applicant',
    age: proposer.age || 0,
    gender: proposer.gender || '',
    bmi,
    answers: opts.answers || td.question_answers || {},   // Q-answers map from extractor or caller
    remarks: (remarks + lifestyleRemark).trim(),
    conditions,
    family_history,
    reports_available: opts.reports_available != null ? opts.reports_available : true,
    examiner: opts.examiner || {}
  };
}

module.exports = {
  scoreTeleMER,
  toFrontendShape,
  fromExtractorData,
  gradeFor,
  scoreMedicalParameters,
  scoreMedicalHistory,
  scoreLifestyle,
  scoreClinicalCorrelation,
  scoreDocumentationQuality,
  detectContradictions,
  PARAM_MAX
};
