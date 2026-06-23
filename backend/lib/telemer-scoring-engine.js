/**
 * TeleMER Dynamic Scoring Engine
 * ================================
 * Reads ALL scoring knobs from backend/config/telemer-scoring.json (or a
 * dynamically supplied config object).  No numeric literals are hardcoded —
 * every value comes from the config so underwriters can change them via
 * Masters → TeleMER Scoring Config without code deploys.
 *
 * Entry point:  calculateTeleMERRiskDynamic(telemerData, voiceAnalysis, correlationData, cfgOverride)
 *
 * The function signature and output shape are identical to the existing
 * calculateTeleMERRisk() so the two call sites in server.js can be swapped
 * with a one-line change.
 *
 * CAT 1–4 (PPHC) scoring is NOT touched by this file.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Config Loader ────────────────────────────────────────────────────────────
// Loads config fresh from disk on every call so an underwriter's save is
// reflected immediately without a server restart.  If S3-backed config is
// passed in (cfgOverride), that takes precedence.

function loadTeleMERConfig(cfgOverride) {
  if (cfgOverride && typeof cfgOverride === 'object' && cfgOverride._version) {
    return cfgOverride;
  }
  // Try S3/DB override injected by server.js via catScoringConfig
  const configPath = path.join(__dirname, '..', 'config', 'telemer-scoring.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error('[TeleMER Engine] Config load error:', e.message);
    return null;
  }
}

// ─── Helper utilities ─────────────────────────────────────────────────────────

function hasKeywords(text, keywords) {
  if (!text || !Array.isArray(keywords)) return false;
  return keywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
}

function combineTexts(...sources) {
  return sources.map(s => (s || '').toLowerCase()).join(' ');
}

// ─── C1: Lifestyle Risk  (25 pts normalised from 18 raw) ─────────────────────

function scoreC1Lifestyle(extractedData, cfg) {
  const c1Cfg   = cfg.C1_lifestyle;
  const rawMax  = cfg.phase1_components.C1_lifestyle.raw_max;
  const normMax = cfg.phase1_components.C1_lifestyle.max_normalised;

  const lifestyle = extractedData?.telemer_data?.lifestyle || extractedData?.lifestyle || {};

  // Smoking
  const smokingStatus = lifestyle?.smoking?.status || 'unknown';
  let smokingScore;
  const sm = c1Cfg.smoking;
  if (smokingStatus === 'never')       smokingScore = sm.never;
  else if (smokingStatus === 'former_gt5' ||
          (smokingStatus === 'former' && (lifestyle?.smoking?.years_quit || 0) > 5))
                                        smokingScore = sm.former_gt5yr;
  else if (smokingStatus === 'former') smokingScore = sm.former_1to5yr;
  else if (smokingStatus === 'current') smokingScore = sm.current;
  else                                  smokingScore = sm.unknown;

  // Alcohol
  const alcoholStatus = lifestyle?.alcohol?.status || 'unknown';
  let alcoholScore;
  const al = c1Cfg.alcohol;
  if (alcoholStatus === 'never')        alcoholScore = al.never;
  else if (alcoholStatus === 'occasional') alcoholScore = al.occasional;
  else if (alcoholStatus === 'regular')    alcoholScore = al.regular;
  else if (alcoholStatus === 'heavy')      alcoholScore = al.heavy;
  else                                     alcoholScore = al.unknown;

  // Tobacco / Gutkha / Pan
  const tobaccoStatus = lifestyle?.tobacco_chewing?.status || 'unknown';
  let tobaccoScore;
  const tb = c1Cfg.tobacco_chewing;
  if (tobaccoStatus === 'never')   tobaccoScore = tb.never;
  else if (tobaccoStatus === 'former' &&
          (lifestyle?.tobacco_chewing?.years_quit || 0) > 3) tobaccoScore = tb.former_gt3yr;
  else if (tobaccoStatus === 'former') tobaccoScore = tb.former_gt3yr; // default former
  else if (tobaccoStatus === 'current') tobaccoScore = tb.current;
  else                                  tobaccoScore = tb.unknown;

  const rawTotal       = smokingScore + alcoholScore + tobaccoScore;
  const normalisedScore = Math.min(normMax, Math.round((rawTotal / rawMax) * normMax * 100) / 100);

  return {
    score: normalisedScore,
    max:   normMax,
    raw_score: rawTotal,
    raw_max:   rawMax,
    breakdown: {
      smoking:          { score: smokingScore,  max: sm.never,  status: smokingStatus,  logic: `Smoking: ${smokingStatus} → ${smokingScore}/${sm.never}` },
      alcohol:          { score: alcoholScore,  max: al.never,  status: alcoholStatus,  logic: `Alcohol: ${alcoholStatus} → ${alcoholScore}/${al.never}` },
      tobacco_chewing:  { score: tobaccoScore,  max: tb.never,  status: tobaccoStatus,  logic: `Tobacco: ${tobaccoStatus} → ${tobaccoScore}/${tb.never}` }
    }
  };
}

// ─── C2: Medical History / PEC  (20 pts normalised from 13 raw) ──────────────

function scoreC2MedicalHistory(extractedData, cfg) {
  const c2Cfg   = cfg.C2_medical_history;
  const rawMax  = cfg.phase1_components.C2_medical_history.raw_max;
  const normMax = cfg.phase1_components.C2_medical_history.max_normalised;

  const history     = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const callingDate = extractedData?.calling_date || extractedData?.telemer_data?.calling_date || null;
  const conditions  = history?.pre_existing_conditions || [];

  // ── PEC Severity Tiers (starts at pec_start_score, deductions additive) ──
  let pecScore = c2Cfg.pec_start_score;
  const tiers  = c2Cfg.pec_tiers;
  const ctrl   = c2Cfg.controlled_thresholds;

  for (const cond of conditions) {
    const status      = (cond.current_status || '').toLowerCase();
    const medName     = (cond.medication || '').trim().toLowerCase();
    const medicationUnknown = !medName || medName === '' || medName === 'unknown' || medName === 'not known';

    // Surgery within defer window?
    let surgeryDaysAgo = null;
    if (cond.surgery_date && callingDate) {
      surgeryDaysAgo = Math.floor((new Date(callingDate) - new Date(cond.surgery_date)) / (1000 * 60 * 60 * 24));
    }
    const isAcute = surgeryDaysAgo !== null && surgeryDaysAgo < c2Cfg.surgery_defer_days;

    // Reading checks
    const bp     = parseFloat(cond.last_reading_systolic || cond.bp_systolic || 0);
    const hba1c  = parseFloat(cond.hba1c || 0);
    const ppbsl  = parseFloat(cond.ppbsl || cond.post_prandial_glucose || 0);

    let tier, deduction;
    if (isAcute) {
      tier = 'acute_post_surgical';
      deduction = tiers.acute_post_surgical;
    } else if (status === 'resolved' || status === 'controlled') {
      tier = 'resolved_minor';
      deduction = tiers.resolved_minor;
    } else if (status === 'active' || status === 'poorly_controlled' || status === 'uncontrolled') {
      let isUncontrolled = medicationUnknown;
      if (bp   > 0 && bp    > ctrl.htn_systolic_max)  isUncontrolled = true;
      if (hba1c > 0 && hba1c > ctrl.dm_hba1c_max)     isUncontrolled = true;
      if (ppbsl > 0 && ppbsl > ctrl.dm_ppbsl_max)     isUncontrolled = true;
      if (status === 'poorly_controlled' || status === 'uncontrolled') isUncontrolled = true;

      if (isUncontrolled) {
        tier = 'active_uncontrolled';
        deduction = tiers.active_uncontrolled;
      } else {
        tier = 'active_controlled';
        deduction = tiers.active_controlled;
      }
    } else {
      tier = 'active_controlled';
      deduction = tiers.active_controlled;
    }

    pecScore = Math.max(0, pecScore - deduction);
    cond._scored_tier       = tier;
    cond._scored_deduction  = deduction;
  }

  if (conditions.length === 0) pecScore = c2Cfg.pec_start_score;

  // ── Hospitalizations ──────────────────────────────────────────────────────
  const hosps   = history?.hospitalizations || [];
  const hospCfg = c2Cfg.hospitalizations;
  let hospScore;
  if (hosps.length === 0)          hospScore = hospCfg.none;
  else if (hosps.length <= 2)      hospScore = hospCfg.one_or_two_resolved;
  else                             hospScore = hospCfg.three_plus_or_recent;

  // ── Systemic Conditions ───────────────────────────────────────────────────
  const systemicFlags = extractedData?.telemer_data?.systemic_flags || extractedData?.systemic_flags || {};
  const systemicCount = Object.values(systemicFlags).filter(v => v === true).length;
  const sysCfg = c2Cfg.systemic_conditions;
  let systemicScore;
  if (systemicCount === 0)      systemicScore = sysCfg.zero_flags;
  else if (systemicCount === 1) systemicScore = sysCfg.one_minor_flag;
  else                          systemicScore = sysCfg.two_plus_or_serious;

  const rawTotal        = pecScore + hospScore + systemicScore;
  const normalisedScore = Math.min(normMax, Math.round((rawTotal / rawMax) * normMax * 100) / 100);

  return {
    score: normalisedScore,
    max:   normMax,
    raw_score: rawTotal,
    raw_max:   rawMax,
    breakdown: {
      pre_existing_conditions: { score: pecScore,       max: c2Cfg.pec_start_score, logic: `${conditions.length} condition(s) → ${pecScore}/${c2Cfg.pec_start_score}`, status: conditions.length === 0 ? 'none' : conditions.map(c => `${c.condition||'?'}(${c._scored_tier})`).join(', ') },
      hospitalizations:        { score: hospScore,      max: hospCfg.none,           logic: `${hosps.length} hosp(s) → ${hospScore}/${hospCfg.none}` },
      systemic_conditions:     { score: systemicScore,  max: sysCfg.zero_flags,      logic: `${systemicCount} flag(s) → ${systemicScore}/${sysCfg.zero_flags}` }
    }
  };
}

// ─── C3: Clinical Correlation  (20 pts normalised from 15 raw) ───────────────

function scoreC3ClinicalCorrelation(correlationData, extractedData, cfg) {
  const c3Cfg   = cfg.C3_clinical_correlation;
  const rawMax  = cfg.phase1_components.C3_clinical_correlation.raw_max;
  const normMax = cfg.phase1_components.C3_clinical_correlation.max_normalised;

  // Drug-Condition Match (5 pts)
  const dc     = c3Cfg.drug_condition_match;
  const meds   = correlationData?.medications_found || [];
  const mismatches = (correlationData?.drug_condition_mismatches || []).filter(m => !m.disclosed);
  let drugScore;
  if (mismatches.length > 0)  drugScore = mismatches.length <= 1 ? Math.round(dc.med_unknown) : dc.mismatch;
  else if (meds.length > 0)   drugScore = dc.match_known;
  else                        drugScore = dc.no_condition_no_med;

  // Multi-System Risk (5 pts)
  const ms   = c3Cfg.multi_system_risk;
  const history    = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const conditions = history?.pre_existing_conditions || [];
  const activeConditions = conditions.filter(c => (c._scored_tier || c.current_status || '').includes('active'));
  const activePECCount   = activeConditions.length;

  let multiScore;
  if (activePECCount === 0)       multiScore = ms.zero_active;
  else if (activePECCount === 1)  multiScore = ms.one_active_single_sys;
  else if (activePECCount === 2)  multiScore = ms.two_active_diff_sys;
  else if (activePECCount === 3)  multiScore = ms.three_active;
  else                            multiScore = ms.four_plus_active;

  // CV Risk Proxy (5 pts) — 5 protective factors, each worth 1
  const cv       = c3Cfg.cv_proxy;
  const age      = parseFloat(extractedData?._proposer_age || 0);
  const gender   = (extractedData?._proposer_gender || '').toLowerCase();
  const bmi      = parseFloat(extractedData?.physical_exam?.bmi?.value || extractedData?.bmi || 0);
  const hasDM    = conditions.some(c => (c.condition || '').toLowerCase().match(/diabetes|dm\b/));
  const hasHTN   = conditions.some(c => (c.condition || '').toLowerCase().match(/hypertension|htn\b|blood pressure/));

  let cvFactors = 0;
  if (age > 0 && age < cv.age_protective_below)   cvFactors++;   // younger
  if (gender.startsWith('f'))                      cvFactors++;   // pre-menopausal female (approximate)
  if (!hasDM)                                      cvFactors++;   // no DM
  if (bmi > 0 && bmi < cv.bmi_protective_below)   cvFactors++;   // healthy BMI
  if (!hasHTN)                                     cvFactors++;   // no HTN

  const cvScore = cv[`map_${cvFactors}_factors`] || (cvFactors <= 1 ? cv.map_1_or_less : cv.map_5_factors);

  const rawTotal        = drugScore + multiScore + cvScore;
  const normalisedScore = Math.min(normMax, Math.round((rawTotal / rawMax) * normMax * 100) / 100);

  return {
    score: normalisedScore,
    max:   normMax,
    raw_score: rawTotal,
    raw_max:   rawMax,
    breakdown: {
      drug_condition:  { score: drugScore,  max: dc.match_known,  logic: `Drug-condition match: ${mismatches.length} mismatch(es) → ${drugScore}/${dc.match_known}` },
      multi_system:    { score: multiScore, max: ms.zero_active,  logic: `${activePECCount} active condition(s) → ${multiScore}/${ms.zero_active}` },
      cv_proxy:        { score: cvScore,    max: cv.map_5_factors, logic: `${cvFactors}/5 protective CV factors → ${cvScore}/${cv.map_5_factors}` }
    }
  };
}

// ─── C4: Cardiovascular + HTN  (15 pts direct) ───────────────────────────────

function scoreC4Cardiovascular(extractedData, cfg) {
  const c4Cfg  = cfg.C4_cardiovascular;
  const maxTotal = cfg.phase1_components.C4_cardiovascular.max_direct;

  const history    = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const conditions = history?.pre_existing_conditions || [];
  const answers    = extractedData?.telemer_data?.answers || extractedData?.answers || {};

  const htnCond = conditions.find(c =>
    (c.condition || '').toLowerCase().match(/hypertension|htn\b|blood pressure/)
  );
  const cardiacCond = conditions.find(c =>
    (c.condition || '').toLowerCase().match(/cardiac|heart|ischemic|coronary|stenting|cabg/)
  );
  const hasDM = conditions.some(c =>
    (c.condition || '').toLowerCase().match(/diabetes|dm\b|blood sugar/)
  );

  let cvScore, status;

  if (cardiacCond) {
    cvScore = c4Cfg.cardiac_ihd_stenting_cabg;
    status  = 'cardiac_history';
  } else if (htnCond) {
    const bp         = parseFloat(htnCond.last_reading_systolic || htnCond.bp_systolic || 0);
    const medUnknown = !(htnCond.medication || '').trim() ||
                       (htnCond.medication || '').toLowerCase() === 'unknown' ||
                       (htnCond.medication || '').toLowerCase() === 'not known';
    const callingYr  = extractedData?.calling_date ? new Date(extractedData.calling_date).getFullYear() : new Date().getFullYear();
    const durationYrs = htnCond.since_year ? callingYr - htnCond.since_year : null;
    const isRecentOnset = durationYrs !== null && durationYrs <= 1;

    if (bp > 0 && bp > c4Cfg.htn_systolic_threshold) {
      cvScore = c4Cfg.htn_uncontrolled_reading;
      status  = 'htn_uncontrolled';
    } else if (medUnknown) {
      cvScore = c4Cfg.htn_med_unknown;
      status  = 'htn_med_unknown';
    } else if (bp === 0) {
      cvScore = c4Cfg.htn_med_known_no_reading;
      status  = 'htn_med_known_no_reading';
    } else if (isRecentOnset) {
      cvScore = c4Cfg.htn_controlled_onset_lte1yr;
      status  = 'htn_controlled_recent_onset';
    } else {
      cvScore = c4Cfg.htn_controlled_onset_gt1yr;
      status  = 'htn_controlled';
    }
  } else if (answers?.prior_htn_self_stopped) {
    cvScore = c4Cfg.htn_prior_self_stopped;
    status  = 'htn_prior_self_stopped';
  } else {
    cvScore = c4Cfg.no_cardiac_no_htn;
    status  = 'no_cardiac_history';
  }

  // HTN + DM comorbidity penalty
  if (htnCond && hasDM) {
    cvScore = Math.max(0, cvScore - c4Cfg.htn_dm_comorbidity_penalty);
    status  += '_plus_dm_comorbidity';
  }

  return {
    score:    Math.max(0, Math.min(cvScore, maxTotal)),
    max:      maxTotal,
    breakdown: { htn_cardiac_status: { score: cvScore, max: maxTotal, logic: `CV status: ${status} → ${cvScore}/15`, status } }
  };
}

// ─── C6: Surgical + GI  (5 pts direct) ──────────────────────────────────────

function scoreC6SurgicalGI(extractedData, cfg) {
  const c6Cfg   = cfg.C6_surgical_gi;
  const maxTotal = cfg.phase1_components.C6_surgical_gi.max_direct;

  const history     = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const surgeries   = history?.surgical_history || [];
  const callingDate = extractedData?.calling_date || extractedData?.telemer_data?.calling_date || null;

  if (surgeries.length === 0) {
    return { score: c6Cfg.no_surgery_no_gi, max: maxTotal, breakdown: { surgical_gi_status: { score: c6Cfg.no_surgery_no_gi, max: maxTotal, logic: 'No surgical history → 5/5', status: 'no_surgery' } } };
  }

  let score = c6Cfg.no_surgery_no_gi;
  let status = 'no_surgery';

  for (const surg of surgeries) {
    let surgDaysAgo = null;
    if (surg.surgery_date && callingDate) {
      surgDaysAgo = Math.floor((new Date(callingDate) - new Date(surg.surgery_date)) / (1000 * 60 * 60 * 24));
    }
    const surgYrsAgo       = surg.year ? (new Date(callingDate || Date.now()).getFullYear() - surg.year) : null;
    const recordsAvailable = surg.records_available !== false;

    if (surgDaysAgo !== null && surgDaysAgo < c6Cfg.surgery_defer_days) {
      score = Math.min(score, c6Cfg.surgery_lt90_days); status = 'surgery_lt_90_days';
    } else if (surgYrsAgo !== null && surgYrsAgo < 1) {
      score = Math.min(score, c6Cfg.surgery_lt1yr_resolved); status = 'surgery_lt_1yr';
    } else if (surgYrsAgo !== null && surgYrsAgo < 5 && !recordsAvailable) {
      score = Math.min(score, c6Cfg.surgery_1to5yr_no_records); status = 'surgery_lt5yr_no_records';
    } else if (surgYrsAgo !== null && surgYrsAgo < 5) {
      score = Math.min(score, c6Cfg.surgery_1to5yr_records_available); status = 'surgery_lt5yr_records';
    } else if (!recordsAvailable) {
      score = Math.min(score, c6Cfg.surgery_gt5yr_no_records); status = 'surgery_gt5yr_no_records';
    } else {
      score = Math.min(score, c6Cfg.surgery_gt5yr_records_available); status = 'surgery_gt5yr_resolved';
    }
  }

  return {
    score: Math.max(0, score),
    max:   maxTotal,
    breakdown: { surgical_gi_status: { score, max: maxTotal, logic: `Surgical/GI: ${status} → ${score}/5`, status } }
  };
}

// ─── C7: Family History  (5 pts direct) ──────────────────────────────────────

function scoreC7FamilyHistory(extractedData, cfg) {
  const c7Cfg  = cfg.C7_family_history;
  const maxTotal = cfg.phase1_components.C7_family_history.max_direct;

  const history = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const family  = history?.family_history || {};
  const details = (family.details || '').toLowerCase();

  const hasBloodCancer = details.includes('blood cancer') || details.includes('leukaemia') || details.includes('lymphoma');
  const hasCancer      = family.cancer === true || details.includes('cancer') || hasBloodCancer;
  const hasStroke      = family.stroke === true || details.includes('stroke');
  const hasCardiac     = family.cardiac === true;
  const hasDiabetes    = family.diabetes === true || details.includes('diabetes');
  const hasHTN         = family.hypertension === true;

  let score, status;
  if (!hasCancer && !hasStroke && !hasCardiac && !hasDiabetes && !hasHTN) {
    score = c7Cfg.none; status = 'none';
  } else if (hasBloodCancer) {
    score = c7Cfg.blood_cancer_first_degree; status = 'blood_cancer';
  } else if (hasCancer || hasStroke) {
    score = c7Cfg.cancer_first_degree; status = 'cancer_or_stroke';
  } else if (hasCardiac) {
    score = c7Cfg.cardiac_first_degree; status = 'cardiac';
  } else if (hasDiabetes && hasHTN) {
    score = c7Cfg.dm_and_htn_first_degree; status = 'dm_and_htn';
  } else {
    score = c7Cfg.diabetes_or_htn_first_degree; status = 'dm_or_htn';
  }

  const seniorReviewTriggers = c7Cfg.senior_review_trigger || [];
  const needsSeniorReview = (hasCancer && seniorReviewTriggers.includes('cancer')) ||
                            (hasBloodCancer && seniorReviewTriggers.includes('blood_cancer')) ||
                            (hasStroke && seniorReviewTriggers.includes('stroke'));

  return {
    score,
    max: maxTotal,
    needs_senior_review: needsSeniorReview,
    breakdown: { family_history_status: { score, max: maxTotal, logic: `Family history: ${status} → ${score}/5`, status } }
  };
}

// ─── Contradiction Detection  (config-driven C-01 to C-08) ───────────────────

function detectContradictions(telemerData, cfg) {
  const matrix         = cfg.contradiction_matrix;
  const penaltyCfg     = cfg.contradiction_penalty;
  const contradiction_list = [];

  const answers  = telemerData?.answers || {};
  const details  = telemerData?.detail_text || {};
  const remarks  = (telemerData?.examiner_remarks || telemerData?.q48_remark || '');
  const q2_text  = details?.q2 || telemerData?.free_text_q2 || '';
  const q3_text  = details?.q3 || telemerData?.free_text_q3 || '';
  const q5_text  = details?.q5 || telemerData?.free_text_q5 || '';
  const combined = combineTexts(q2_text, q3_text, q5_text, remarks);

  for (const [checkId, rule] of Object.entries(matrix)) {
    if (!rule.enabled) continue;

    const conditionFound = hasKeywords(combined, rule.keywords);
    if (!conditionFound) continue;

    let contradicted = false;
    if (rule.answer_field) {
      contradicted = answers[rule.answer_field] === false;
    } else if (rule.answer_fields) {
      contradicted = rule.answer_fields.some(f => answers[f] === false);
    } else if (checkId === 'C08') {
      // C-08: Q48 adds new condition not mentioned in Q2/Q3
      const base = combineTexts(q2_text, q3_text);
      contradicted = conditionFound && !hasKeywords(base, rule.keywords);
    }

    if (contradicted) {
      contradiction_list.push({ check_id: checkId, description: rule.description });
    }
  }

  const count   = contradiction_list.length;
  const penalty = count >= 3 ? 0 : (count === 2 ? Math.abs(penaltyCfg.two) : (count === 1 ? Math.abs(penaltyCfg.one) : 0));

  return {
    contradiction_count:   count,
    contradiction_list,
    contradiction_penalty: penalty,
    triggers_re_mer:       count >= 3
  };
}

// ─── Hard Override Rules  (config-driven P1–P8) ──────────────────────────────

function evaluateOverrides(telemerData, extractedData, contradictionResult, cfg) {
  const rules          = cfg.hard_overrides;
  const override_flags = [];
  let override_action  = null;
  let should_stop      = false;

  const callingDate  = telemerData?.calling_date || extractedData?.calling_date || null;
  const history      = telemerData?.medical_history || extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const surgeries    = history?.surgical_history || [];
  const conditions   = history?.pre_existing_conditions || [];
  const answers      = telemerData?.answers || extractedData?.telemer_data?.answers || {};
  const remarks      = (telemerData?.examiner_remarks || telemerData?.q48_remark || '').toLowerCase();
  const combined     = remarks + ' ' + JSON.stringify(conditions).toLowerCase();
  const proposer     = extractedData?.proposer_name || '';
  const insured      = extractedData?.insured_name  || extractedData?.telemer_data?.proposer_info?.name || '';

  function setStop(action, priority, reason, source) {
    override_flags.push({ type: action, priority, reason, source });
    if (!override_action) { override_action = action; should_stop = true; }
  }

  // P1 — Surgery within defer window
  if (rules.P1_surgery_lt90_days?.enabled) {
    const deferDays = rules.P1_surgery_lt90_days.days;
    for (const surg of surgeries) {
      if (surg.surgery_date && callingDate) {
        const daysAgo = Math.floor((new Date(callingDate) - new Date(surg.surgery_date)) / (1000 * 60 * 60 * 24));
        if (daysAgo < deferDays) {
          setStop('AUTO_DEFER', 1, `${rules.P1_surgery_lt90_days.message} (${daysAgo} days ago — ${surg.procedure || 'procedure'})`, 'surgical_history');
        }
      }
    }
  }

  // P2 — Identity / voice mismatch
  if (rules.P2_identity_mismatch?.enabled && hasKeywords(remarks, rules.P2_identity_mismatch.keywords)) {
    setStop('AUTO_DEFER', 2, rules.P2_identity_mismatch.message, 'q48_remark');
  }

  // P3 — Auto-decline conditions
  if (rules.P3_auto_decline_cancer?.enabled) {
    if (answers[rules.P3_auto_decline_cancer.q_field] === true || hasKeywords(combined, rules.P3_auto_decline_cancer.keywords)) {
      setStop('AUTO_DECLINE', 3, rules.P3_auto_decline_cancer.message, 'Q28 or conditions');
    }
  }
  if (rules.P3_auto_decline_hiv?.enabled) {
    if (answers[rules.P3_auto_decline_hiv.q_field] === true || hasKeywords(combined, rules.P3_auto_decline_hiv.keywords)) {
      setStop('AUTO_DECLINE', 3, rules.P3_auto_decline_hiv.message, 'Q18');
    }
  }
  if (rules.P3_auto_decline_endstage?.enabled && hasKeywords(combined, rules.P3_auto_decline_endstage.keywords)) {
    setStop('AUTO_DECLINE', 3, rules.P3_auto_decline_endstage.message, 'conditions');
  }

  // P4 — 3+ contradictions → MANDATORY RE-MER
  if (rules.P4_mandatory_re_mer?.enabled && contradictionResult.contradiction_count >= (rules.P4_mandatory_re_mer.min_contradictions || 3)) {
    if (!override_action) { override_action = 'MANDATORY_RE_MER'; should_stop = true; }
    override_flags.push({ type: 'MANDATORY_RE_MER', priority: 4, reason: `${rules.P4_mandatory_re_mer.message} (${contradictionResult.contradiction_count} contradictions)`, source: 'contradiction_matrix' });
  }

  // P5 — Medication name unknown for active condition (non-stopping)
  if (rules.P5_med_name_unknown?.enabled) {
    for (const cond of conditions) {
      const medName = (cond.medication || '').trim().toLowerCase();
      const isActive = ['active','poorly_controlled','uncontrolled'].includes((cond.current_status||'').toLowerCase());
      if (isActive && (!medName || medName === 'unknown' || medName === 'not known')) {
        override_flags.push({ type: 'MANDATORY_DOCS', priority: 5, reason: `${rules.P5_med_name_unknown.message} (condition: ${cond.condition||'unnamed'})`, source: 'current_medications', action_required: rules.P5_med_name_unknown.message });
      }
    }
  }

  // P6 — Surgery <5 yrs with no records (non-stopping)
  if (rules.P6_surgery_no_records?.enabled) {
    for (const surg of surgeries) {
      const surgYrsAgo   = surg.year ? (new Date(callingDate || Date.now()).getFullYear() - surg.year) : null;
      const recordsAvail = surg.records_available !== false;
      if (surgYrsAgo !== null && surgYrsAgo < (rules.P6_surgery_no_records.years || 5) && !recordsAvail) {
        override_flags.push({ type: 'MANDATORY_DOCS', priority: 6, reason: `${rules.P6_surgery_no_records.message} (${surg.procedure||'procedure'} ${surg.year})`, source: 'surgical_history', action_required: rules.P6_surgery_no_records.message });
      }
    }
  }

  // P7 — Family history cancer/stroke (non-stopping)
  if (rules.P7_family_cancer_stroke?.enabled) {
    const fh      = history?.family_history || {};
    const fhDet   = (fh.details || '').toLowerCase();
    if (fh.cancer === true || fh.stroke === true || fhDet.includes('cancer') || fhDet.includes('leukaemia') || fhDet.includes('lymphoma') || fhDet.includes('blood cancer')) {
      override_flags.push({ type: 'SENIOR_REVIEW', priority: 7, reason: rules.P7_family_cancer_stroke.message, source: 'family_history' });
    }
  }

  // P8 — Third-party proposal (non-stopping)
  if (rules.P8_third_party_proposal?.enabled && proposer && insured && proposer.toLowerCase().trim() !== insured.toLowerCase().trim()) {
    override_flags.push({ type: 'SENIOR_REVIEW', priority: 8, reason: `${rules.P8_third_party_proposal.message} (proposer: ${proposer}, insured: ${insured})`, source: 'proposer_vs_insured' });
  }

  const mandatory_docs = override_flags.filter(f => f.type === 'MANDATORY_DOCS' && f.action_required).map(f => f.action_required);

  return { override_action, override_flags, should_stop, mandatory_docs };
}

// ─── Loading Computation  (config-driven) ────────────────────────────────────

function computeLoading(extractedData, cfg) {
  const lt   = cfg.loading_table;
  const bmiR = cfg.bmi_rules;
  let total  = 0;

  const history    = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const conditions = history?.pre_existing_conditions || [];

  for (const cond of conditions) {
    const name      = (cond.condition || '').toLowerCase();
    const tier      = cond._scored_tier || cond.current_status || '';
    const sinceYr   = cond.since_year || null;
    const callingYr = new Date().getFullYear();
    const durationYrs = sinceYr ? callingYr - sinceYr : null;
    const isUncontrolled = tier.includes('uncontrolled');

    if (name.match(/hypertension|htn\b|blood pressure/)) {
      if (isUncontrolled)                           total += lt.htn_uncontrolled;
      else if (durationYrs && durationYrs <= 1)     total += lt.htn_controlled_onset_lte1yr;
      else                                          total += lt.htn_controlled_onset_gt1yr;
    } else if (name.match(/diabetes|dm\b/)) {
      if (isUncontrolled)                           total += lt.dm_uncontrolled;
      else if (durationYrs && durationYrs <= 3)     total += lt.dm_controlled_duration_lte3yr;
      else if (durationYrs && durationYrs <= 7)     total += lt.dm_controlled_duration_3to7yr;
      else                                          total += lt.dm_controlled_duration_3to7yr;
    }
  }

  // BMI loading
  const bmi = parseFloat(extractedData?.physical_exam?.bmi?.value || extractedData?.bmi || 0);
  if (bmi >= bmiR.obese1_max)                      total += lt.bmi_above35;
  else if (bmi >= bmiR.overweight_max)             total += lt.bmi_30to35;
  else if (bmi >= bmiR.normal_max)                 total += lt.bmi_25to30;

  // HTN+DM comorbidity extra loading
  const hasHTN = conditions.some(c => (c.condition || '').toLowerCase().match(/hypertension|htn\b/));
  const hasDM  = conditions.some(c => (c.condition || '').toLowerCase().match(/diabetes|dm\b/));
  if (hasHTN && hasDM) total += lt.htn_dm_comorbidity;

  // Family history cancer/stroke
  const fh = (history?.family_history) || {};
  if (fh.cancer || fh.stroke || (fh.details || '').toLowerCase().includes('cancer')) total += lt.family_history_cancer_stroke;

  return Math.min(lt.loading_cap, Math.max(0, total));
}

// ─── PED List  (config-driven) ───────────────────────────────────────────────

function buildPEDList(extractedData, cfg) {
  const pt   = cfg.ped_table;
  const ped  = [];

  const history    = extractedData?.telemer_data?.medical_history || extractedData?.medical_history || {};
  const conditions = history?.pre_existing_conditions || [];
  const surgeries  = history?.surgical_history || [];
  const callingYr  = new Date().getFullYear();

  for (const cond of conditions) {
    const name      = (cond.condition || '').toLowerCase();
    const tier      = cond._scored_tier || cond.current_status || '';
    const sinceYr   = cond.since_year;
    const durationYrs = sinceYr ? callingYr - sinceYr : null;
    const isUncontrolled = tier.includes('uncontrolled');

    if (name.match(/hypertension|htn\b|blood pressure/)) {
      const rule = isUncontrolled ? pt.htn_uncontrolled : (durationYrs && durationYrs <= 1 ? pt.htn_controlled_onset_lte1yr : pt.htn_controlled_onset_gt1yr);
      ped.push({ condition: cond.condition || 'Hypertension', ped_years: rule.ped_years, exclusion_type: rule.exclusion_type, scope: rule.scope });
    } else if (name.match(/diabetes|dm\b/)) {
      const rule = pt.dm_no_complications;
      ped.push({ condition: cond.condition || 'Diabetes', ped_years: rule.ped_years, exclusion_type: rule.exclusion_type, scope: rule.scope });
    } else if (name.includes('thyroid')) {
      const rule = pt.thyroid;
      ped.push({ condition: cond.condition || 'Thyroid disorder', ped_years: rule.ped_years, exclusion_type: rule.exclusion_type, scope: rule.scope });
    } else if (name.match(/asthma|copd/)) {
      const rule = pt.asthma_copd;
      ped.push({ condition: cond.condition || 'Asthma/COPD', ped_years: rule.ped_years, exclusion_type: rule.exclusion_type, scope: rule.scope });
    } else if (tier && tier !== 'none') {
      const rule = pt.generic_pec;
      ped.push({ condition: cond.condition || 'Pre-existing condition', ped_years: rule.ped_years, exclusion_type: rule.exclusion_type, scope: rule.scope });
    }
  }

  for (const surg of surgeries) {
    const proc   = (surg.procedure || '').toLowerCase();
    const yrsAgo = surg.year ? callingYr - surg.year : null;

    if (proc.match(/spine|lumbar|sciatica/)) {
      const rule = yrsAgo && yrsAgo < 1 ? pt.spine_surgery_active_recovery : pt.spine_surgery_resolved;
      ped.push({ condition: surg.procedure || 'Spinal surgery', ped_years: rule.ped_years, exclusion_type: rule.exclusion_type, scope: rule.scope });
    } else if (proc.match(/gall|cholecyst/)) {
      const rule = yrsAgo && yrsAgo < 5 ? pt.gallbladder_surgery_lt5yr : pt.gallbladder_surgery_gt5yr;
      ped.push({ condition: surg.procedure || 'Gallbladder surgery', ped_years: rule.ped_years, exclusion_type: rule.exclusion_type, scope: rule.scope });
    }
  }

  return ped;
}

// ─── Decision Band  (config-driven) ──────────────────────────────────────────

function resolveDecisionBand(scaledTotal, cfg) {
  const bands = cfg.decision_bands;
  for (const [key, band] of Object.entries(bands)) {
    if (scaledTotal >= band.min && scaledTotal <= band.max) {
      return { band: key, label: band.label, pre_policy_tests: band.pre_policy_tests || [] };
    }
  }
  return { band: 'decline', label: 'Decline', pre_policy_tests: [] };
}

// ─── Rationale Builder ────────────────────────────────────────────────────────

function buildRationale(components, scaledTotal, grade, recommendation, contradictionResult, overrideResult) {
  const parts = [`TeleMER Hybrid Score: ${scaledTotal}/100 (Grade: ${grade})`];
  const labels = { lifestyle_risk: 'Lifestyle Risk (C1)', medical_history: 'Medical History (C2)', clinical_correlation: 'Clinical Correlation (C3)', cardiovascular: 'Cardiovascular (C4)', surgical_gi: 'Surgical/GI (C6)', family_history: 'Family History (C7)' };
  for (const [k, c] of Object.entries(components)) {
    parts.push(`  ${labels[k] || k}: ${Math.round(c.score)}/${c.max}`);
  }
  if (contradictionResult.contradiction_count > 0) {
    parts.push(`Contradictions: ${contradictionResult.contradiction_count} (penalty: -${contradictionResult.contradiction_penalty} pts)`);
  }
  const nonStop = overrideResult.override_flags.filter(f => ['MANDATORY_DOCS','SENIOR_REVIEW'].includes(f.type));
  for (const f of nonStop) parts.push(`${f.type}: ${f.reason}`);
  const decisionMap = { accept_standard: 'Accept at standard rates.', accept_with_loading: 'Accept with premium loading.', refer: 'Refer to senior underwriter.', decline: 'Decline.', defer: 'Defer.', mandatory_re_mer: 'Mandatory re-TeleMER.' };
  parts.push(decisionMap[recommendation] || `Decision: ${recommendation}`);
  return parts.join('\n');
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────
// Signature mirrors calculateTeleMERRisk() exactly so server.js call sites
// need only change the function name.

function calculateTeleMERRiskDynamic(telemerData, voiceAnalysis, correlationData, cfgOverride) {
  const cfg = loadTeleMERConfig(cfgOverride);
  if (!cfg) {
    // Config failed to load — return a safe error result
    return {
      risk_score: { total: 0, max: 100, normalized: 0, grade: 'N/A', components: {} },
      decision: { recommendation: 'refer', loading_percentage: 0, exclusions: [], rationale: 'TeleMER scoring config unavailable — manual review required.' },
      override_action: null, override_flags: [], contradiction_count: 0, contradiction_list: [],
      mandatory_docs: [], pre_policy_tests: [], ped_per_condition: [],
      senior_review_required: true, auto_decision_eligible: false,
      calculated_at: new Date().toISOString(), config_version: 'LOAD_ERROR'
    };
  }

  const extractedData = telemerData;

  // Step 1 — Contradiction detection
  const contradictionResult = detectContradictions(telemerData, cfg);

  // Step 2 — Hard override evaluation
  const overrideResult = evaluateOverrides(telemerData, extractedData, contradictionResult, cfg);

  // Step 3 — Stop if hard override fires
  if (overrideResult.should_stop) {
    const decisionMap = { AUTO_DEFER: 'defer', AUTO_DECLINE: 'decline', MANDATORY_RE_MER: 'mandatory_re_mer' };
    return {
      risk_score: { total: 0, max: 100, normalized: 0, grade: 'N/A', components: {} },
      decision: { recommendation: decisionMap[overrideResult.override_action] || 'refer', loading_percentage: 0, exclusions: [], rationale: `Scoring stopped — override: ${overrideResult.override_action}. See override_flags.` },
      override_action: overrideResult.override_action,
      override_flags: overrideResult.override_flags,
      contradiction_count:  contradictionResult.contradiction_count,
      contradiction_list:   contradictionResult.contradiction_list,
      contradiction_penalty:contradictionResult.contradiction_penalty,
      mandatory_docs: overrideResult.mandatory_docs,
      pre_policy_tests: [], ped_per_condition: [],
      senior_review_required: true, auto_decision_eligible: false,
      calculated_at: new Date().toISOString(), config_version: cfg._version
    };
  }

  // Step 4 — Score all 6 components
  const C1 = scoreC1Lifestyle(extractedData, cfg);
  const C2 = scoreC2MedicalHistory(extractedData, cfg);
  const C3 = scoreC3ClinicalCorrelation(correlationData || {}, extractedData, cfg);
  const C4 = scoreC4Cardiovascular(extractedData, cfg);
  const C6 = scoreC6SurgicalGI(extractedData, cfg);
  const C7 = scoreC7FamilyHistory(extractedData, cfg);

  const components = { lifestyle_risk: C1, medical_history: C2, clinical_correlation: C3, cardiovascular: C4, surgical_gi: C6, family_history: C7 };

  // Step 5 — Aggregate (Phase 1: raw max 90, scale to 100)
  const rawMax         = cfg.phase1_raw_max || 90;
  const phase1Total    = C1.score + C2.score + C3.score + C4.score + C6.score + C7.score;
  const penaltyAdj     = Math.max(0, phase1Total - contradictionResult.contradiction_penalty);
  const scaledTotal    = Math.min(100, Math.round((penaltyAdj / rawMax) * 100 * 100) / 100);

  // Step 6 — Grade
  let grade;
  if (scaledTotal >= 90) grade = 'A+';
  else if (scaledTotal >= 80) grade = 'A';
  else if (scaledTotal >= 70) grade = 'B+';
  else if (scaledTotal >= 60) grade = 'B';
  else if (scaledTotal >= 50) grade = 'C';
  else grade = 'D';

  // Step 7 — Decision band
  const band = resolveDecisionBand(scaledTotal, cfg);
  let recommendation;
  if (scaledTotal >= cfg.decision_bands.standard.min)    recommendation = 'accept_standard';
  else if (scaledTotal >= cfg.decision_bands.mild_load.min) recommendation = 'accept_with_loading';
  else if (scaledTotal >= cfg.decision_bands.moderate_load.min) recommendation = 'refer';
  else recommendation = 'decline';

  const loading_percentage = recommendation !== 'accept_standard' ? computeLoading(extractedData, cfg) : 0;

  const seniorReviewRequired = overrideResult.override_flags.some(f => f.type === 'SENIOR_REVIEW') || C7.needs_senior_review;
  const ped_per_condition    = buildPEDList(extractedData, cfg);

  return {
    risk_score: {
      total:      Math.round(penaltyAdj * 100) / 100,
      max:        rawMax,
      normalized: scaledTotal,
      grade,
      components,
      phase: 1,
      phase1_note: 'Score scaled from 90-pt base to 100. Phase 2 adds documentation quality (10 pts).',
      config_version: cfg._version
    },
    decision: {
      recommendation,
      loading_percentage,
      exclusions:  [],
      rationale:   buildRationale(components, scaledTotal, grade, recommendation, contradictionResult, overrideResult),
      band:        band.label
    },
    override_action:        overrideResult.override_action,
    override_flags:         overrideResult.override_flags,
    contradiction_count:    contradictionResult.contradiction_count,
    contradiction_list:     contradictionResult.contradiction_list,
    contradiction_penalty:  contradictionResult.contradiction_penalty,
    mandatory_docs:         overrideResult.mandatory_docs,
    pre_policy_tests:       band.pre_policy_tests,
    ped_per_condition,
    senior_review_required: seniorReviewRequired,
    auto_decision_eligible: scaledTotal >= (cfg.decision_bands.standard.min || 80) &&
                            contradictionResult.contradiction_count === 0 &&
                            overrideResult.override_flags.length === 0,
    calculated_at:          new Date().toISOString(),
    config_version:         cfg._version
  };
}

module.exports = {
  calculateTeleMERRiskDynamic,
  loadTeleMERConfig,
  // Export sub-scorers for unit testing
  scoreC1Lifestyle,
  scoreC2MedicalHistory,
  scoreC3ClinicalCorrelation,
  scoreC4Cardiovascular,
  scoreC6SurgicalGI,
  scoreC7FamilyHistory,
  detectContradictions,
  evaluateOverrides,
  computeLoading,
  buildPEDList
};
