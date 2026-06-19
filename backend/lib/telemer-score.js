/**
 * telemer-score.js — Config-driven TeleMER scoring model (v2)
 * ------------------------------------------------------------
 * Reads ALL thresholds from catScoringConfig['tele_mer'] (Masters Config →
 * Per-CAT Scoring → Tele MER tab).  Falls back to DEFAULTS only if the DB
 * config hasn't been seeded yet (first boot).
 *
 * HIGH score = healthier / lower-risk.
 *
 * Parameters (sums to 100):
 *   1) Medical Parameters    40  (BMI, BP, FBS, HbA1c, Age — from remarks)
 *   2) Medical History       20  (PEC burden, control, family history)
 *   3) Lifestyle Risk        15  (tobacco, alcohol, weight change, BMI proxy)
 *   4) Clinical Correlation  15  (drug-match, multi-system, CV proxy)
 *   5) Documentation Quality 10  (completeness, examiner, form consistency)
 */

'use strict';

const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v  => Math.round(v  * 100) / 100;
const lc     = s  => (s  || '').toString().toLowerCase();
const num    = v  => { const n = parseFloat(v); return isNaN(n) ? null : n; };

// ─── HARDCODED DEFAULTS (used only when DB config is absent) ─────────────────
// These mirror the bands in buildDefaultCatScoring() → tele_mer section.
// Any edit in Masters Config overwrites these at runtime.
const DEFAULTS = {
  param_max: {
    medical_parameters:    40,
    medical_history:       20,
    lifestyle_risk:        15,
    clinical_correlation:  15,
    documentation_quality: 10
  },
  medical_parameters: {
    bmi: {
      max: 8,
      bands: [
        { max_val: 0,    pts: 4,  label: 'BMI unknown'         },
        { max_val: 18.4, pts: 5,  label: 'Underweight'         },
        { max_val: 24.9, pts: 8,  label: 'Normal'              },
        { max_val: 29.9, pts: 5,  label: 'Overweight'          },
        { max_val: 34.9, pts: 3,  label: 'Obese I'             },
        { max_val: 999,  pts: 1,  label: 'Obese II+'           }
      ]
    },
    blood_pressure: {
      max: 10,
      bands: [
        { max_val: 0,   pts: 5,  label: 'No reading'                    },
        { max_val: 119, pts: 10, label: 'Optimal (<120)'                },
        { max_val: 129, pts: 9,  label: 'Normal (120-129)'              },
        { max_val: 139, pts: 7,  label: 'High-normal / controlled'      },
        { max_val: 159, pts: 4,  label: 'Stage 1 (140-159)'             },
        { max_val: 999, pts: 1,  label: 'Stage 2 (≥160)'                }
      ]
    },
    fasting_glucose: {
      max: 10,
      bands: [
        { max_val: 0,   pts: 5,  label: 'No reading'                    },
        { max_val: 99,  pts: 10, label: 'Normal (<100)'                 },
        { max_val: 110, pts: 8,  label: 'Well-controlled (100-110)'     },
        { max_val: 125, pts: 6,  label: 'Impaired / controlled (111-125)'},
        { max_val: 180, pts: 3,  label: 'Elevated (126-180)'            },
        { max_val: 999, pts: 1,  label: 'Poor (>180)'                   }
      ]
    },
    hba1c: {
      max: 6,
      bands: [
        { max_val: 0,   pts: 4,  label: 'Not available (neutral)'       },
        { max_val: 5.6, pts: 6,  label: 'Normal (<5.7%)'                },
        { max_val: 6.4, pts: 4,  label: 'Pre-diabetic (5.7-6.4%)'       },
        { max_val: 7.4, pts: 3,  label: 'Controlled DM (6.5-7.4%)'      },
        { max_val: 999, pts: 1,  label: 'Uncontrolled (≥7.5%)'          }
      ]
    },
    age_band: {
      max: 6,
      bands: [
        { max_val: 0,  pts: 3,  label: 'Age unknown'                    },
        { max_val: 34, pts: 6,  label: 'Under 35'                       },
        { max_val: 44, pts: 5,  label: '35-44'                          },
        { max_val: 54, pts: 4,  label: '45-54'                          },
        { max_val: 64, pts: 3,  label: '55-64'                          },
        { max_val: 999,pts: 2,  label: '65+'                            }
      ]
    }
  },
  medical_history: {
    deductions: { controlled: 2, uncontrolled: 5, untreated: 1, active: 2 },
    pec_max: 12,
    control_max: 4,
    control_deduction_per_uncontrolled: 2,
    family_history: {
      none: 4, minor: 2, serious: 1,
      serious_conditions: ['cancer','stroke','cardiac','heart']
    }
  },
  lifestyle_risk: {
    tobacco_alcohol_max: 7,
    tobacco_deduction: 4,
    alcohol_deduction: 3,
    weight_stable_pts: 4, weight_change_pts: 1, weight_max: 4,
    bmi_proxy: {
      max: 4,
      bands: [
        { max_val: 0,   pts: 2 },
        { max_val: 24.9,pts: 4 },
        { max_val: 29.9,pts: 3 },
        { max_val: 34.9,pts: 2 },
        { max_val: 999, pts: 1 }
      ]
    }
  },
  clinical_correlation: {
    drug_match: { all_match: 5, partial: 3, none: 1, no_conditions: 5, max: 5 },
    multi_system: {
      max: 5,
      bands: [
        { systems: 0, pts: 5 }, { systems: 1, pts: 4 },
        { systems: 2, pts: 3 }, { systems: 3, pts: 2 }, { systems: 999, pts: 1 }
      ]
    },
    cv_proxy: { max: 5, min: 1 }
  },
  documentation_quality: {
    completeness_max: 4,
    examiner_max: 3,
    examiner_name_pts: 1.5, examiner_reg_pts: 0.5, reports_pts: 1,
    consistency_max: 3,
    consistency_bands: [
      { contradictions: 0, pts: 3 },
      { contradictions: 1, pts: 2 },
      { contradictions: 2, pts: 1 },
      { contradictions: 999, pts: 0 }
    ]
  },
  decision_bands: [
    { min_score: 80, label: 'Standard Accept',  loading: '0%'     },
    { min_score: 65, label: 'Mild Load',        loading: '5-15%'  },
    { min_score: 50, label: 'Moderate Load',    loading: '15-30%' },
    { min_score: 35, label: 'Heavy Load',       loading: '30-50%' },
    { min_score: 0,  label: 'Refer / Decline',  loading: 'N/A'    }
  ]
};

// ─── CONFIG RESOLVER ─────────────────────────────────────────────────────────
// The live catScoringConfig is passed in at call time from server.js.
// cfg(key) returns the live config sub-object, or the matching DEFAULTS entry.
function makeResolver(catCfg) {
  // catCfg = catScoringConfig['tele_mer'] (may be undefined on first boot)
  const comp = catCfg?.components || {};
  const th   = catCfg?.thresholds || {};

  function getBands(paramKey, factorId) {
    // Walk components → find component with matching key or _key → find factor by id
    for (const [ck, cv] of Object.entries(comp)) {
      if (!cv?.factors) continue;
      // match component by key or label prefix
      const compMatch = ck === paramKey || ck.startsWith(paramKey.split('_')[0]);
      if (!compMatch) continue;
      const factor = cv.factors.find(f => f.id === factorId);
      if (factor?.bands?.length) return { bands: factor.bands, max: factor.max };
    }
    return null; // fall to defaults
  }

  return { comp, th, getBands };
}

// ─── REMARKS PARSER ──────────────────────────────────────────────────────────
// Extracts numeric readings directly from the combined remarks string.
// Used as fallback when the extractor's structured readings fields are zero/null.
function parseReadingsFromRemarks(remarks) {
  const r = remarks || '';
  const out = { systolic: null, diastolic: null, fbs: null, hba1c: null };

  // BP: "130/86" or "130 / 86"
  const bpMatch = r.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (bpMatch) {
    const s = parseInt(bpMatch[1]), d = parseInt(bpMatch[2]);
    if (s > 70 && s < 250 && d > 40 && d < 150) {
      out.systolic = s; out.diastolic = d;
    }
  }

  // Fasting glucose: "fasting 101" or "fasting-101" or "fbs 101"
  const fbsMatch = r.match(/fasting[\s\-]*(?:glucose|sugar|blood sugar)?[\s\-:]*(\d{2,3})\s*(?:mg|mgdl|mg\/dl)?/i)
                || r.match(/fbs[\s\-:]*(\d{2,3})\s*(?:mg|mgdl)?/i);
  if (fbsMatch) { const v = parseInt(fbsMatch[1]); if (v > 50 && v < 600) out.fbs = v; }

  // HbA1c: "hba1c 7.2" or "a1c 6.5%"
  const a1cMatch = r.match(/hba1c[\s\-:]*(\d+\.?\d*)\s*%?/i) || r.match(/a1c[\s\-:]*(\d+\.?\d*)\s*%?/i);
  if (a1cMatch) { const v = parseFloat(a1cMatch[1]); if (v > 3 && v < 20) out.hba1c = v; }

  return out;
}

// ─── DOB → AGE ───────────────────────────────────────────────────────────────
function ageFromDOB(dob) {
  if (!dob) return null;
  try {
    // Handle DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD
    let d;
    const dmyMatch = dob.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (dmyMatch) d = new Date(`${dmyMatch[3]}-${dmyMatch[2].padStart(2,'0')}-${dmyMatch[1].padStart(2,'0')}`);
    else d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - d.getFullYear();
    const m = today.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
    return age > 0 && age < 120 ? age : null;
  } catch { return null; }
}

// ─── BAND LOOKUP ─────────────────────────────────────────────────────────────
// Bands are sorted ascending by max_val.
// Bands with max_val === 0 are "unknown/no reading" sentinels — only match when value is 0/null.
// For real values (>0), skip the sentinel and find the first band where value <= max_val.
function lookupBand(value, bands) {
  // Defensive: never return undefined, even when bands is empty/misconfigured.
  // Several factors under tele_mer's "medical" component carry weight=0 and have
  // historically had no bands configured in Masters Config at all (nobody needed
  // them since they don't contribute to the score) — but telemer-score.js still
  // calls lookupBand() for bmi/blood_pressure/fasting_glucose/hba1c/age_band
  // regardless, and an empty bands array previously caused bands[0] / realBands[-1]
  // to evaluate to undefined, crashing every caller that reads .points/.label off
  // the result. Confirmed live: TypeError: Cannot read properties of undefined
  // (reading 'points') when bmiCfg.bands was empty.
  const SAFE_FALLBACK = { points: 0, pts: 0, label: 'Not configured', max_val: 0 };
  if (!Array.isArray(bands) || bands.length === 0) return SAFE_FALLBACK;

  if (!value || value === 0) {
    // Return sentinel band (max_val=0) if it exists, else first band
    return bands.find(b => b.max_val === 0) || bands[0] || SAFE_FALLBACK;
  }
  // Skip sentinel bands (max_val=0) for real values
  const realBands = bands.filter(b => b.max_val > 0);
  for (const b of realBands) {
    if (value <= b.max_val) return b;
  }
  return realBands[realBands.length - 1] || SAFE_FALLBACK; // fallback to last real band, or safe default
}

// ─── 1) MEDICAL PARAMETERS ───────────────────────────────────────────────────
function scoreMedicalParameters(d, resolver) {
  const checks = [];
  const add = (label, pts, max, logic, value) =>
    checks.push({ label, points: round2(pts), max, logic, value: value ?? null });

  const D  = DEFAULTS.medical_parameters;
  const gb = (id) => resolver.getBands('medical', id);

  // BMI
  const bmi = num(d.bmi) || 0;
  const bmiCfg = gb('bmi');
  let bmiPts, bmiLabel;
  if (bmiCfg) {
    const b = lookupBand(bmi, bmiCfg.bands);
    bmiPts = b.points; bmiLabel = b.label;
  } else {
    const b = lookupBand(bmi, D.bmi.bands);
    bmiPts = b.pts; bmiLabel = b.label;
  }
  add('BMI', bmiPts, bmiCfg?.max || D.bmi.max,
    `BMI ${bmi || 'unknown'} — ${bmiLabel} → ${bmiPts}`, bmi || null);

  // Blood Pressure (systolic from conditions, fallback to remarks parse)
  const remarkReadings = parseReadingsFromRemarks(d.remarks);
  const sys = maxReading(d.conditions, 'systolic') || remarkReadings.systolic || 0;
  const bpCfg = gb('blood_pressure');
  let bpPts, bpLabel;
  if (bpCfg) {
    const b = lookupBand(sys, bpCfg.bands);
    bpPts = b.points; bpLabel = b.label;
  } else {
    const b = lookupBand(sys, D.blood_pressure.bands);
    bpPts = b.pts; bpLabel = b.label;
  }
  add('Blood Pressure', bpPts, bpCfg?.max || D.blood_pressure.max,
    `${sys ? sys + ' mmHg systolic' : 'No BP reading'} — ${bpLabel} → ${bpPts}`,
    sys ? `${sys}/${maxReading(d.conditions,'diastolic')||remarkReadings.diastolic||'?'} mmHg` : null);

  // Fasting Glucose
  const fbs = maxReading(d.conditions, 'fbs') || remarkReadings.fbs || 0;
  const fbsCfg = gb('fasting_glucose');
  let fbsPts, fbsLabel;
  if (fbsCfg) {
    const b = lookupBand(fbs, fbsCfg.bands);
    fbsPts = b.points; fbsLabel = b.label;
  } else {
    const b = lookupBand(fbs, D.fasting_glucose.bands);
    fbsPts = b.pts; fbsLabel = b.label;
  }
  add('Fasting Glucose', fbsPts, fbsCfg?.max || D.fasting_glucose.max,
    `${fbs ? fbs + ' mg/dl' : 'No reading'} — ${fbsLabel} → ${fbsPts}`,
    fbs ? `${fbs} mg/dl` : null);

  // HbA1c
  const hba1c = maxReading(d.conditions, 'hba1c') || remarkReadings.hba1c || 0;
  const a1cCfg = gb('hba1c');
  let a1cPts, a1cLabel;
  if (a1cCfg) {
    const b = lookupBand(hba1c, a1cCfg.bands);
    a1cPts = b.points; a1cLabel = b.label;
  } else {
    const b = lookupBand(hba1c, D.hba1c.bands);
    a1cPts = b.pts; a1cLabel = b.label;
  }
  add('HbA1c', a1cPts, a1cCfg?.max || D.hba1c.max,
    `${hba1c ? hba1c + '%' : 'Not available'} — ${a1cLabel} → ${a1cPts}`,
    hba1c ? `${hba1c}%` : null);

  // Age Band (prefer DOB-derived age)
  const age = d.age || 0;
  const ageCfg = gb('age_band');
  let agePts, ageLabel;
  if (ageCfg) {
    const b = lookupBand(age, ageCfg.bands);
    agePts = b.points; ageLabel = b.label;
  } else {
    const b = lookupBand(age, D.age_band.bands);
    agePts = b.pts; ageLabel = b.label;
  }
  add('Age Band', agePts, ageCfg?.max || D.age_band.max,
    `Age ${age || 'unknown'} — ${ageLabel} → ${agePts}`,
    age ? `${age} yrs` : null);

  const maxPts = (ageCfg?.max||D.age_band.max) + (bmiCfg?.max||D.bmi.max) +
                 (bpCfg?.max||D.blood_pressure.max) + (fbsCfg?.max||D.fasting_glucose.max) +
                 (a1cCfg?.max||D.hba1c.max);
  const total = clamp(checks.reduce((s,c) => s + c.points, 0), 0, maxPts);
  return { score: round2(total), max: maxPts, checks };
}

// ─── 2) MEDICAL HISTORY ──────────────────────────────────────────────────────
function scoreMedicalHistory(d, resolver) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic, value: null });
  const D = DEFAULTS.medical_history;
  const th = resolver.th;
  const conds = d.conditions || [];

  // PEC burden
  const pecMax = th.pec_max ?? D.pec_max;
  const deds   = th.deductions || D.deductions;
  let pecScore = pecMax;
  const notes  = [];
  for (const c of conds) {
    const status = lc(c.status);
    const ded = deds[status] ?? deds.active ?? 2;
    pecScore -= ded;
    notes.push(`${c.name}(${status}) -${ded}`);
  }
  pecScore = clamp(pecScore, 0, pecMax);
  add('Pre-existing Conditions', pecScore, pecMax,
    conds.length ? `${conds.length} condition(s): ${notes.join(', ')} → ${pecScore}/${pecMax}` : `none → ${pecMax}/${pecMax}`);

  // Condition control
  const ctrlMax = th.control_max ?? D.control_max;
  const ctrlDed = th.control_deduction_per_uncontrolled ?? D.control_deduction_per_uncontrolled;
  let chronPts  = ctrlMax;
  for (const c of conds) { if (lc(c.status) === 'uncontrolled') chronPts -= ctrlDed; }
  chronPts = clamp(chronPts, 0, ctrlMax);
  add('Condition Control', chronPts, ctrlMax, `control adjustment → ${chronPts}/${ctrlMax}`);

  // Family history
  const fhCfg  = th.family_history || D.family_history;
  const fam    = d.family_history || [];
  const serious = fam.some(f => (fhCfg.serious_conditions || D.family_history.serious_conditions)
    .some(s => lc(f).includes(s)));
  const famPts = fam.length === 0 ? (fhCfg.none ?? 4) : (serious ? (fhCfg.serious ?? 1) : (fhCfg.minor ?? 2));
  add('Family History', famPts, fhCfg.none ?? 4,
    fam.length === 0 ? `no family history → ${famPts}` : `${fam.join(', ')} → ${famPts}`);

  const maxTotal = pecMax + ctrlMax + (fhCfg.none ?? 4);
  const total = clamp(checks.reduce((s,c) => s + c.points, 0), 0, maxTotal);
  return { score: round2(total), max: maxTotal, checks };
}

// ─── 3) LIFESTYLE RISK ───────────────────────────────────────────────────────
function scoreLifestyle(d, resolver) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic, value: null });
  const D  = DEFAULTS.lifestyle_risk;
  const th = resolver.th;
  const r  = lc(d.remarks);

  // Tobacco / Alcohol
  const taMax  = th.tobacco_alcohol_max ?? D.tobacco_alcohol_max;
  const taDed  = th.tobacco_deduction   ?? D.tobacco_deduction;
  const alDed  = th.alcohol_deduction   ?? D.alcohol_deduction;
  const hasTob = /smok|cigarette|beedi|gutkha|pan\b|tobacco|khaini/.test(r);
  const hasAlc = /alcohol|drink|whisky|beer|wine/.test(r) && !/no alcohol|nil alcohol/.test(r);
  let taPts = taMax;
  if (hasTob) taPts -= taDed;
  if (hasAlc) taPts -= alDed;
  taPts = clamp(taPts, 0, taMax);
  add('Tobacco / Alcohol', taPts, taMax,
    `tobacco:${hasTob} alcohol:${hasAlc} → ${taPts}/${taMax}`);

  // Weight stability
  const wStable = th.weight_stable_pts ?? D.weight_stable_pts;
  const wChange = th.weight_change_pts ?? D.weight_change_pts;
  const wMax    = th.weight_max        ?? D.weight_max;
  const changed = d.answers?.q6 === true;
  add('Weight Stability', changed ? wChange : wStable, wMax,
    changed ? `recent weight change → ${wChange}/${wMax}` : `stable weight → ${wStable}/${wMax}`);

  // BMI proxy
  const bmiD = th.bmi_proxy || D.bmi_proxy;
  const bmi  = num(d.bmi) || 0;
  const bmiB = lookupBand(bmi, bmiD.bands);
  add('BMI (lifestyle proxy)', bmiB.pts ?? bmiB.points, bmiD.max,
    `BMI ${bmi || 'unknown'} → ${bmiB.pts ?? bmiB.points}/${bmiD.max}`);

  const maxTotal = taMax + wMax + bmiD.max;
  const total = clamp(checks.reduce((s,c) => s + c.points, 0), 0, maxTotal);
  return { score: round2(total), max: maxTotal, checks };
}

// ─── 4) CLINICAL CORRELATION ─────────────────────────────────────────────────
function scoreClinicalCorrelation(d, resolver) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic, value: null });
  const D    = DEFAULTS.clinical_correlation;
  const th   = resolver.th;
  const conds = d.conditions || [];

  // Drug-condition match
  const dmCfg  = th.drug_match || D.drug_match;
  let matched  = 0;
  for (const c of conds) {
    const med = Array.isArray(c.medication) ? c.medication.join(', ') : String(c.medication || '');
    if (med.trim() && med.trim().toLowerCase() !== 'unknown') matched++;
  }
  let drugPts;
  if (conds.length === 0)              drugPts = dmCfg.no_conditions ?? 5;
  else if (matched === conds.length)   drugPts = dmCfg.all_match     ?? 5;
  else if (matched > 0)               drugPts = dmCfg.partial        ?? 3;
  else                                 drugPts = dmCfg.none           ?? 1;
  add('Drug-Condition Match', drugPts, dmCfg.max ?? 5,
    conds.length === 0 ? `no conditions → ${drugPts}` : `${matched}/${conds.length} medicated → ${drugPts}`);

  // Multi-system load
  const msCfg  = th.multi_system || D.multi_system;
  const systems = new Set();
  for (const c of conds) {
    const n = lc(c.name);
    if (/diabet|dm|sugar|thyroid|endocrine/.test(n)) systems.add('endocrine');
    else if (/hypertension|htn|cardiac|heart|bp/.test(n)) systems.add('cardiovascular');
    else if (/varicose|vein|vascular/.test(n)) systems.add('vascular');
    else if (/kidney|renal|liver|gi|gall/.test(n)) systems.add('gi_renal');
    else systems.add('other');
  }
  const sc = systems.size;
  let sysPts = msCfg.max ?? 5;
  for (const b of (msCfg.bands || [])) { if (sc <= b.systems) { sysPts = b.pts; break; } }
  if (!(msCfg.bands?.length)) {
    // defaults
    sysPts = sc === 0 ? 5 : sc === 1 ? 4 : sc === 2 ? 3 : sc === 3 ? 2 : 1;
  }
  add('Multi-System Load', sysPts, msCfg.max ?? 5,
    `${sc} system(s): ${[...systems].join(', ') || 'none'} → ${sysPts}`);

  // CV proxy
  const cvCfg = th.cv_proxy || D.cv_proxy;
  const age   = d.age || 0;
  const bmi   = num(d.bmi) || 0;
  const sys   = maxReading(conds, 'systolic') || parseReadingsFromRemarks(d.remarks).systolic || 0;
  const hasDM = conds.some(c => /diabet|dm|sugar/.test(lc(c.name)));
  let prot = 0;
  if (age && age < 55) prot++;
  if (bmi && bmi < 30) prot++;
  if (!sys || sys < 140) prot++;
  if (!hasDM) prot++;
  if (conds.length < 3) prot++;
  const cvPts = clamp(prot, cvCfg.min ?? 1, cvCfg.max ?? 5);
  add('Cardiovascular Proxy', cvPts, cvCfg.max ?? 5,
    `${prot}/5 protective factors → ${cvPts}`);

  const maxTotal = (dmCfg.max??5) + (msCfg.max??5) + (cvCfg.max??5);
  const total = clamp(checks.reduce((s,c) => s + c.points, 0), 0, maxTotal);
  return { score: round2(total), max: maxTotal, checks };
}

// ─── 5) DOCUMENTATION QUALITY ────────────────────────────────────────────────
function scoreDocumentationQuality(d, resolver) {
  const checks = [];
  const add = (label, pts, max, logic) => checks.push({ label, points: round2(pts), max, logic, value: null });
  const D  = DEFAULTS.documentation_quality;
  const th = resolver.th;

  // Completeness
  const compMax = th.completeness_max ?? D.completeness_max;
  const conds   = d.conditions || [];
  let comp = compMax;
  if (conds.length > 0) {
    let full = 0;
    for (const c of conds) {
      const hasDur  = c.duration_years != null;
      const hasMed  = !!(c.medication && String(c.medication).trim());
      const hasRead = !!(c.systolic || c.fbs || c.hba1c);
      if (hasDur && hasMed && hasRead) full++;
    }
    comp = round2(compMax * (full / conds.length));
  }
  add('Completeness', comp, compMax,
    `${conds.length} condition(s) fully described → ${comp}/${compMax}`);

  // Examiner & reports
  const exMax   = th.examiner_max      ?? D.examiner_max;
  const exName  = th.examiner_name_pts ?? D.examiner_name_pts;
  const exReg   = th.examiner_reg_pts  ?? D.examiner_reg_pts;
  const repPts  = th.reports_pts       ?? D.reports_pts;
  let det = 0;
  if (d.examiner?.name)   det += exName;
  if (d.examiner?.reg_no) det += exReg;
  if (d.reports_available) det += repPts;
  det = clamp(det, 0, exMax);
  add('Examiner & Reports', det, exMax, `examiner+reports → ${det}/${exMax}`);

  // Form consistency
  const conBands = th.consistency_bands || D.consistency_bands;
  const conMax   = conBands[0]?.pts ?? D.consistency_max;
  const contras  = detectContradictions(d);
  let cons = 0;
  for (const b of conBands) { if (contras.length <= b.contradictions) { cons = b.pts; break; } }
  add('Form Consistency', cons, conMax,
    `${contras.length} contradiction(s) → ${cons}/${conMax}`);

  const maxTotal = compMax + exMax + conMax;
  const total = clamp(checks.reduce((s,c) => s + c.points, 0), 0, maxTotal);
  return { score: round2(total), max: maxTotal, checks, contradictions: contras };
}

// ─── CONTRADICTION DETECTOR ──────────────────────────────────────────────────
function detectContradictions(d) {
  const r = lc(d.remarks);
  const a = d.answers || {};
  const found = [];
  const has = (...kw) => kw.some(k => r.includes(k));

  if (has('htn','hypertension','coversyl','blood pressure') && a.q12 === false)
    found.push('HTN in remarks but Q12 (HTN) = No');
  if (has('dm','diabet','janumet','sugar') && a.q13 === false)
    found.push('DM in remarks but Q13 (Diabetes) = No');
  if (has('dm','diabet','thyroid','janumet') && a.q26 === false)
    found.push('DM/endocrine in remarks but Q26 (Endocrine) = No');
  if ((d.conditions||[]).some(c => c.medication) && a.q4 === false)
    found.push('On active medication but Q4 (treated in 5 yrs) = No');
  return found;
}

const maxReading = (conds, field) => {
  let m = 0;
  for (const c of (conds||[])) { const v = parseFloat(c[field]); if (!isNaN(v) && v > m) m = v; }
  return m;
};

// ─── DECISION BAND ───────────────────────────────────────────────────────────
function resolveBand(score, resolver) {
  const bands = resolver.th?.decision_bands || DEFAULTS.decision_bands;
  for (const b of bands) { if (score >= b.min_score) return b; }
  return bands[bands.length - 1];
}

// ─── GRADE ───────────────────────────────────────────────────────────────────
function gradeFor(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B+';
  if (score >= 60) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────
// catCfg = catScoringConfig['tele_mer'] passed in from server.js
function scoreTeleMER(d, catCfg) {
  const resolver = makeResolver(catCfg);

  const p1 = scoreMedicalParameters(d,    resolver);
  const p2 = scoreMedicalHistory(d,       resolver);
  const p3 = scoreLifestyle(d,            resolver);
  const p4 = scoreClinicalCorrelation(d,  resolver);
  const p5 = scoreDocumentationQuality(d, resolver);

  const total = round2(p1.score + p2.score + p3.score + p4.score + p5.score);
  const band  = resolveBand(total, resolver);

  return {
    applicant:          d.name || d.applicant_name || 'Applicant',
    total_score:        total,
    max_score:          100,
    interpretation:     'Higher score = healthier / lower-risk',
    decision_band:      band.label,
    indicative_loading: band.loading,
    parameters: {
      medical_parameters:    p1,
      medical_history:       p2,
      lifestyle_risk:        p3,
      clinical_correlation:  p4,
      documentation_quality: p5
    },
    review_notes:   p5.contradictions,
    decision_basis: 'Remarks-driven scoring. Contradictions affect Documentation Quality only.',
    scored_at:      new Date().toISOString()
  };
}

// ─── FRONTEND ADAPTER ────────────────────────────────────────────────────────
function toFrontendShape(result) {
  const pct = (s, m) => m ? Math.round((s / m) * 100) : 0;
  const statusFor = (pts, max) => {
    const r = max ? pts / max : 0;
    return r >= 0.8 ? 'good' : r >= 0.5 ? 'moderate' : 'adverse';
  };
  const buildBreakdown = (param) => {
    const out = {};
    for (const c of param.checks) {
      const key = c.label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
      out[key] = {
        score:  c.points,
        max:    c.max,
        status: statusFor(c.points, c.max),
        logic:  c.logic,
        value:  c.value ?? null    // ← actual reading (e.g. "130/86 mmHg") for Value column
      };
    }
    return out;
  };

  const component_analysis = {};
  for (const [name, param] of Object.entries(result.parameters)) {
    component_analysis[name] = {
      score:      param.score,
      max:        param.max,
      percentage: pct(param.score, param.max),
      breakdown:  buildBreakdown(param)
    };
  }

  return {
    component_analysis,
    risk_score: {
      normalized: result.total_score,
      grade:      gradeFor(result.total_score),
      total:      result.total_score,
      max:        100
    },
    decision_band:      result.decision_band,
    indicative_loading: result.indicative_loading,
    review_notes:       result.review_notes,
    decision_basis:     result.decision_basis
  };
}

// ─── EXTRACTOR → MODEL MAPPER ────────────────────────────────────────────────
function fromExtractorData(telemer_data, opts = {}) {
  const td      = telemer_data || {};
  const proposer = td.proposer_info || {};
  const mh      = td.medical_history || {};
  const ls      = td.lifestyle || {};
  const fam     = mh.family_history || {};

  // Age: DOB first, then proposer.age, then wf.age from opts
  const dobAge  = ageFromDOB(proposer.date_of_birth || proposer.dob || opts.dob);
  const age     = dobAge || num(proposer.age) || num(opts.age) || 0;

  // Conditions
  const conditions = (mh.pre_existing_conditions || []).map(c => {
    const status = String(c.current_status || 'active').toLowerCase();
    const rd     = c.readings || {};
    return {
      name:          c.condition || '',
      duration_years:c.since_year ? Math.max(0, new Date().getFullYear() - c.since_year) : null,
      medication:    Array.isArray(c.medication) ? c.medication.join(', ') : String(c.medication || ''),
      status:        status === 'resolved' ? 'controlled' : status,
      systolic:      (opts.readings?.systolic)  || num(rd.systolic)  || null,
      diastolic:     (opts.readings?.diastolic) || num(rd.diastolic) || null,
      fbs:           (opts.readings?.fbs)       || num(rd.fbs)       || null,
      hba1c:         (opts.readings?.hba1c)     || num(rd.hba1c)     || null
    };
  });

  // Family history booleans → array
  const family_history = [];
  if (fam.cancer)       family_history.push('cancer');
  if (fam.stroke)       family_history.push('stroke');
  if (fam.cardiac)      family_history.push('cardiac');
  if (fam.diabetes)     family_history.push('diabetes');
  if (fam.hypertension) family_history.push('hypertension');

  // Remarks
  const detail = td.detail_text || {};
  const remarkParts = (mh.pre_existing_conditions || []).map(c =>
    `${c.condition||''}${c.since_year?' since '+c.since_year:''}${c.medication?' on '+c.medication:''} (${c.current_status||'active'})`
  );
  const remarks = opts.raw_remarks
    || td.examiner_remarks_verbatim
    || td.remarks
    || remarkParts.join('. ');

  // Lifestyle keywords
  let lifestyleRemark = '';
  if (ls.smoking?.status === 'current')  lifestyleRemark += ' smoker';
  if (ls.tobacco_chewing?.status === 'current') lifestyleRemark += ' tobacco';
  if (ls.alcohol?.status === 'regular' || ls.alcohol?.status === 'heavy') lifestyleRemark += ' alcohol';

  const bmi = num(opts.bmi) || num(proposer.bmi) || num(opts.declared_bmi) || 0;

  return {
    name:              proposer.name || 'Applicant',
    age,
    dob:               proposer.date_of_birth || proposer.dob || null,
    gender:            proposer.gender || '',
    bmi,
    answers:           opts.answers || td.question_answers || {},
    remarks:           (remarks + lifestyleRemark).trim(),
    conditions,
    family_history,
    reports_available: opts.reports_available ?? true,
    examiner:          opts.examiner || td.examiner || {}
  };
}

module.exports = {
  scoreTeleMER,
  toFrontendShape,
  fromExtractorData,
  gradeFor,
  parseReadingsFromRemarks,
  ageFromDOB,
  detectContradictions,
  DEFAULTS
};
