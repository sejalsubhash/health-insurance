/**
 * Historical UW Data Engine
 * Ingests past UW decisions, builds profile vectors, performs similarity matching,
 * and calculates PPHC skip confidence for STP decisioning.
 */

let historicalCorpus = [];
let profileIndex = {}; // Keyed by profile hash for fast lookup
let corpusStats = { total: 0, approval_rate: 0, avg_loading: 0, claim_rate: 0, last_updated: null };

const AGE_BANDS = [
  { min: 18, max: 35, label: '18-35' }, { min: 36, max: 45, label: '36-45' },
  { min: 46, max: 50, label: '46-50' }, { min: 51, max: 55, label: '51-55' },
  { min: 56, max: 60, label: '56-60' }, { min: 61, max: 65, label: '61-65' },
  { min: 66, max: 999, label: '66+' }
];

const SA_BANDS = [
  { max: 2500000, label: 'up_to_25L' }, { max: 10000000, label: '25L_1Cr' },
  { max: 50000000, label: '1Cr_5Cr' }, { max: 999999999, label: 'above_5Cr' }
];

const CONDITION_FIELDS = ['diabetes', 'hypertension', 'cardiac', 'cancer', 'asthma', 'thyroid', 'kidney', 'liver'];

function getAgeBand(age) {
  const band = AGE_BANDS.find(b => age >= b.min && age <= b.max);
  return band ? band.label : '36-45';
}

function getSABand(sa) {
  const band = SA_BANDS.find(b => sa <= b.max);
  return band ? band.label : 'above_5Cr';
}

function getBMIBand(bmi) {
  if (!bmi) return 'unknown';
  if (bmi < 18.5) return 'underweight';
  if (bmi < 25) return 'normal';
  if (bmi < 30) return 'overweight';
  if (bmi < 35) return 'obese_1';
  if (bmi < 40) return 'obese_2';
  return 'obese_3';
}

function normalizeSmokingStatus(val) {
  if (!val) return 'unknown';
  const v = String(val).toLowerCase().trim();
  if (['yes', 'current', 'true', '1', 'smoker'].includes(v)) return 'current';
  if (['former', 'ex', 'past', 'quit'].includes(v)) return 'former';
  if (['no', 'never', 'false', '0', 'non-smoker', 'none'].includes(v)) return 'never';
  return 'unknown';
}

function normalizeDecision(val) {
  if (!val) return 'unknown';
  const v = String(val).toLowerCase().trim();
  if (['approve', 'approved', 'accept', 'accept_standard', 'auto_approved', 'uw_approved', 'stp_auto_issue'].includes(v)) return 'approve';
  if (['reject', 'rejected', 'decline', 'declined', 'auto_rejected', 'uw_rejected'].includes(v)) return 'reject';
  if (['counter', 'counter_offer', 'counter-offer', 'counter_offered', 'accept_with_loading'].includes(v)) return 'counter_offer';
  if (['refer', 'referred', 'manual_review'].includes(v)) return 'refer';
  return 'unknown';
}

function normalizeBool(val) {
  if (val === true || val === 1) return true;
  if (val === false || val === 0) return false;
  if (!val) return false;
  const v = String(val).toLowerCase().trim();
  return ['yes', 'true', '1', 'y'].includes(v);
}

/**
 * Create a profile vector from a record (historical or live proposal)
 */
function createProfileVector(record) {
  const conditionCount = CONDITION_FIELDS.filter(c => normalizeBool(record[c])).length;
  return {
    age_band: getAgeBand(parseInt(record.age) || 35),
    gender: (record.gender || '').toLowerCase().startsWith('f') ? 'female' : 'male',
    smoker: normalizeSmokingStatus(record.smoker || record.smoking),
    alcohol: (record.alcohol || 'none').toLowerCase(),
    bmi_band: getBMIBand(parseFloat(record.bmi) || null),
    conditions: CONDITION_FIELDS.reduce((obj, c) => { obj[c] = normalizeBool(record[c]); return obj; }, {}),
    condition_count: conditionCount,
    sa_band: getSABand(parseFloat(record.sum_assured) || 500000),
    product_category: (record.product_type || record.product_category || 'health').toLowerCase()
  };
}

/**
 * Calculate similarity score between two profile vectors
 * Returns 0-100 score
 */
function calculateSimilarity(vectorA, vectorB) {
  let score = 0;
  const maxScore = 100;

  // Age band match (20 points)
  if (vectorA.age_band === vectorB.age_band) score += 20;
  else {
    const bandsA = AGE_BANDS.findIndex(b => b.label === vectorA.age_band);
    const bandsB = AGE_BANDS.findIndex(b => b.label === vectorB.age_band);
    if (Math.abs(bandsA - bandsB) === 1) score += 10; // Adjacent band = partial match
  }

  // Gender match (5 points)
  if (vectorA.gender === vectorB.gender) score += 5;

  // Condition flags match (40 points total — 5 per condition)
  for (const c of CONDITION_FIELDS) {
    if (vectorA.conditions[c] === vectorB.conditions[c]) score += 5;
  }

  // Condition count similarity (5 points)
  if (vectorA.condition_count === vectorB.condition_count) score += 5;
  else if (Math.abs(vectorA.condition_count - vectorB.condition_count) === 1) score += 2;

  // Smoker match (10 points)
  if (vectorA.smoker === vectorB.smoker) score += 10;
  else if ((vectorA.smoker === 'former' && vectorB.smoker === 'current') || (vectorA.smoker === 'current' && vectorB.smoker === 'former')) score += 4;

  // SA band match (10 points)
  if (vectorA.sa_band === vectorB.sa_band) score += 10;
  else {
    const tiersA = SA_BANDS.findIndex(b => b.label === vectorA.sa_band);
    const tiersB = SA_BANDS.findIndex(b => b.label === vectorB.sa_band);
    if (Math.abs(tiersA - tiersB) === 1) score += 5;
  }

  // Product category match (10 points)
  if (vectorA.product_category === vectorB.product_category) score += 10;

  return Math.round(score / maxScore * 100);
}

/**
 * Ingest historical records from parsed CSV/JSON data
 * mode: 'replace' or 'append'
 */
function ingestHistoricalData(records, mode = 'append', source = 'csv_upload') {
  const processed = records.map((r, i) => {
    const vector = createProfileVector(r);
    return {
      _id: `HIST-${Date.now()}-${i}`,
      raw: {
        age: parseInt(r.age) || null,
        gender: r.gender || null,
        smoker: r.smoker || r.smoking || null,
        alcohol: r.alcohol || null,
        bmi: parseFloat(r.bmi) || null,
        sum_assured: parseFloat(r.sum_assured) || null,
        product_type: r.product_type || r.product_category || null,
        pphc_done: normalizeBool(r.pphc_done),
        decision: r.decision || null,
        loading_applied: parseFloat(r.loading_applied || r.loading) || 0,
        claim_within_24_months: normalizeBool(r.claim_within_24_months || r.claim),
        claim_amount: parseFloat(r.claim_amount) || 0,
        hospitalizations: parseInt(r.hospitalizations) || 0,
        family_history: normalizeBool(r.family_history)
      },
      conditions_declared: CONDITION_FIELDS.filter(c => normalizeBool(r[c])),
      vector,
      decision_normalized: normalizeDecision(r.decision),
      source,
      ingested_at: new Date().toISOString()
    };
  }).filter(r => r.raw.age && r.decision_normalized !== 'unknown'); // Filter out invalid records

  if (mode === 'replace') {
    historicalCorpus = processed;
  } else {
    historicalCorpus = historicalCorpus.concat(processed);
  }

  // Rebuild index and stats
  rebuildIndex();
  recalculateStats();

  return {
    ingested: processed.length,
    rejected: records.length - processed.length,
    total_corpus: historicalCorpus.length,
    stats: corpusStats
  };
}

function rebuildIndex() {
  profileIndex = {};
  for (const record of historicalCorpus) {
    const key = `${record.vector.age_band}_${record.vector.gender}_${record.vector.condition_count}`;
    if (!profileIndex[key]) profileIndex[key] = [];
    profileIndex[key].push(record);
  }
}

function recalculateStats() {
  const total = historicalCorpus.length;
  if (total === 0) { corpusStats = { total: 0, approval_rate: 0, avg_loading: 0, claim_rate: 0, last_updated: new Date().toISOString() }; return; }

  const approved = historicalCorpus.filter(r => r.decision_normalized === 'approve').length;
  const withLoading = historicalCorpus.filter(r => r.raw.loading_applied > 0);
  const avgLoading = withLoading.length > 0 ? Math.round(withLoading.reduce((s, r) => s + r.raw.loading_applied, 0) / withLoading.length) : 0;
  const withClaims = historicalCorpus.filter(r => r.raw.claim_within_24_months).length;
  const pphcDone = historicalCorpus.filter(r => r.raw.pphc_done).length;

  corpusStats = {
    total,
    approval_rate: Math.round(approved / total * 100 * 10) / 10,
    rejection_rate: Math.round(historicalCorpus.filter(r => r.decision_normalized === 'reject').length / total * 100 * 10) / 10,
    counter_offer_rate: Math.round(historicalCorpus.filter(r => r.decision_normalized === 'counter_offer').length / total * 100 * 10) / 10,
    avg_loading: avgLoading,
    claim_rate: total > 0 ? Math.round(withClaims / total * 100 * 10) / 10 : 0,
    pphc_done_rate: Math.round(pphcDone / total * 100 * 10) / 10,
    records_with_claim_data: historicalCorpus.filter(r => r.raw.claim_within_24_months !== undefined).length,
    last_updated: new Date().toISOString(),
    profile_types: Object.keys(profileIndex).length,
    top_profiles: Object.entries(profileIndex)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([key, records]) => ({
        profile: key,
        count: records.length,
        approval_rate: Math.round(records.filter(r => r.decision_normalized === 'approve').length / records.length * 100)
      }))
  };
}

/**
 * Find similar historical records for a live proposal
 * Returns match analysis with PPHC skip confidence
 */
function findSimilarCases(proposalData, minSimilarity = 60) {
  if (historicalCorpus.length === 0) {
    return { match_count: 0, confidence: 'INSUFFICIENT', message: 'No historical data available. Upload past UW decisions in Masters Config → Historical UW Data.' };
  }

  const proposalVector = createProfileVector(proposalData);

  // Fast pre-filter using index — check matching age_band+gender+condition_count and adjacent buckets
  const candidateKeys = [];
  for (const key of Object.keys(profileIndex)) {
    const [ageBand, gender] = key.split('_');
    if (ageBand === proposalVector.age_band || AGE_BANDS.findIndex(b => b.label === ageBand) - AGE_BANDS.findIndex(b => b.label === proposalVector.age_band) <= 1) {
      candidateKeys.push(key);
    }
  }
  const candidates = candidateKeys.flatMap(k => profileIndex[k] || []);

  // Calculate similarity for all candidates
  const matches = candidates
    .map(record => ({ record, similarity: calculateSimilarity(proposalVector, record.vector) }))
    .filter(m => m.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity);

  if (matches.length === 0) {
    return { match_count: 0, confidence: 'INSUFFICIENT', message: `No similar profiles found in ${historicalCorpus.length} historical records.`, proposal_vector: proposalVector };
  }

  // Aggregate statistics from matches
  const matchCount = matches.length;
  const approved = matches.filter(m => m.record.decision_normalized === 'approve');
  const rejected = matches.filter(m => m.record.decision_normalized === 'reject');
  const counterOffered = matches.filter(m => m.record.decision_normalized === 'counter_offer');
  const referred = matches.filter(m => m.record.decision_normalized === 'refer');
  const approvalRate = Math.round(approved.length / matchCount * 100 * 10) / 10;
  const withClaims = matches.filter(m => m.record.raw.claim_within_24_months);
  const claimRate = approved.length > 0 ? Math.round(withClaims.length / approved.length * 100 * 10) / 10 : 0;
  const pphcDone = matches.filter(m => m.record.raw.pphc_done);
  const pphcRate = Math.round(pphcDone.length / matchCount * 100 * 10) / 10;
  const avgLoading = counterOffered.length > 0 ? Math.round(counterOffered.reduce((s, m) => s + m.record.raw.loading_applied, 0) / counterOffered.length) : 0;
  const avgSimilarity = Math.round(matches.reduce((s, m) => s + m.similarity, 0) / matchCount);

  // Calculate PPHC skip confidence
  let pphcSkipScore = 0;
  if (matchCount >= 50) pphcSkipScore += 25;
  else if (matchCount >= 20) pphcSkipScore += 15;
  else if (matchCount >= 10) pphcSkipScore += 5;
  if (matchCount >= 100) pphcSkipScore += 10;

  if (approvalRate >= 90) pphcSkipScore += 25;
  else if (approvalRate >= 80) pphcSkipScore += 15;
  else if (approvalRate >= 70) pphcSkipScore += 5;

  if (claimRate <= 2) pphcSkipScore += 25;
  else if (claimRate <= 5) pphcSkipScore += 15;
  else if (claimRate <= 10) pphcSkipScore += 5;

  if (!proposalVector.conditions.cardiac && !proposalVector.conditions.cancer) pphcSkipScore += 10;
  if (proposalVector.age_band === '18-35' || proposalVector.age_band === '36-45') pphcSkipScore += 5;

  let confidence;
  if (pphcSkipScore >= 80) confidence = 'HIGH';
  else if (pphcSkipScore >= 60) confidence = 'MEDIUM';
  else if (pphcSkipScore >= 40) confidence = 'LOW';
  else confidence = 'INSUFFICIENT';

  // Determine historical recommendation
  let historicalRecommendation;
  if (approvalRate >= 85 && claimRate <= 3) historicalRecommendation = 'approve';
  else if (approvalRate >= 70) historicalRecommendation = 'counter_offer';
  else if (approvalRate >= 50) historicalRecommendation = 'refer';
  else historicalRecommendation = 'decline';

  // PPHC requirement recommendation
  let pphcRecommendation;
  if (confidence === 'HIGH') pphcRecommendation = 'skip_pphc';
  else if (confidence === 'MEDIUM') pphcRecommendation = 'telemer_only';
  else pphcRecommendation = 'full_pphc';

  return {
    match_count: matchCount,
    avg_similarity: avgSimilarity,
    confidence,
    pphc_skip_score: pphcSkipScore,
    decision_distribution: {
      approve: approved.length,
      reject: rejected.length,
      counter_offer: counterOffered.length,
      refer: referred.length,
      approval_rate: approvalRate,
      rejection_rate: Math.round(rejected.length / matchCount * 100 * 10) / 10,
      counter_offer_rate: Math.round(counterOffered.length / matchCount * 100 * 10) / 10
    },
    avg_loading: avgLoading,
    claim_analysis: {
      claim_rate: claimRate,
      claims_found: withClaims.length,
      approved_count: approved.length,
      avg_claim_amount: withClaims.length > 0 ? Math.round(withClaims.reduce((s, m) => s + (m.record.raw.claim_amount || 0), 0) / withClaims.length) : 0
    },
    pphc_analysis: {
      pphc_done_rate: pphcRate,
      pphc_recommendation: pphcRecommendation,
      pphc_skip_rationale: confidence === 'HIGH'
        ? `${matchCount} similar profiles found with ${approvalRate}% approval rate and ${claimRate}% claim rate. Historical data strongly supports skipping PPHC for this profile.`
        : confidence === 'MEDIUM'
        ? `${matchCount} similar profiles found. ${approvalRate}% approved, ${claimRate}% claim rate. Consider tele-MER instead of full PPHC.`
        : `Insufficient historical confidence to skip PPHC. ${matchCount < 20 ? 'Too few matching records.' : `Approval rate ${approvalRate}% or claim rate ${claimRate}% outside safe thresholds.`}`
    },
    historical_recommendation: historicalRecommendation,
    proposal_vector: proposalVector,
    top_matches: matches.slice(0, 5).map(m => ({
      similarity: m.similarity,
      age: m.record.raw.age,
      gender: m.record.vector.gender,
      conditions: m.record.conditions_declared,
      decision: m.record.decision_normalized,
      loading: m.record.raw.loading_applied,
      pphc_done: m.record.raw.pphc_done,
      claim: m.record.raw.claim_within_24_months
    }))
  };
}

/**
 * Add a live workflow decision to the corpus (feedback loop)
 */
function addLiveDecision(workflow) {
  if (!workflow || !workflow.proposer_name || !workflow.age) return;

  const record = {
    age: workflow.age,
    gender: workflow.gender,
    smoker: workflow.lifestyle?.smoking || 'unknown',
    alcohol: workflow.lifestyle?.alcohol || 'unknown',
    bmi: workflow.extracted_data?.physical_exam?.bmi?.value || null,
    sum_assured: workflow.sum_assured,
    product_type: workflow.product_name || 'health',
    pphc_done: workflow.documents?.length > 0,
    decision: workflow.ai_analysis?.recommendation || workflow.state,
    loading_applied: workflow.ai_analysis?.loading_percentage || 0,
    claim_within_24_months: false, // Unknown at decision time — updated later if claim data arrives
    claim_amount: 0
  };

  // Add condition flags from medical history
  const mh = workflow.medical_history || {};
  const conditions = mh.pre_existing_conditions || [];
  CONDITION_FIELDS.forEach(c => { record[c] = conditions.includes(c); });

  const result = ingestHistoricalData([record], 'append', 'live_decision');
  return result;
}

/**
 * Get corpus for S3 persistence
 */
function getCorpus() {
  return { records: historicalCorpus, stats: corpusStats, last_updated: new Date().toISOString() };
}

/**
 * Load corpus from S3
 */
function loadCorpus(data) {
  if (!data || !data.records) return;
  historicalCorpus = data.records;
  rebuildIndex();
  recalculateStats();
}

function getStats() { return corpusStats; }
function getCorpusSize() { return historicalCorpus.length; }

// ─── Layer 2: Calibration Offsets ───
// Tracks AI-vs-UW decision differences and calculates correction offsets per profile type

let calibrationOffsets = {};
// Structure: { "36-45_male_0": { sample_size: 23, loading_adjustment: -15, decision_override_rate: 0.35, dominant_override: 'approve', avg_ai_loading: 75, avg_uw_loading: 60, last_calculated: "..." }, ... }

/**
 * Generate a profile key for calibration grouping
 * Uses age_band + gender + condition_count for coarse grouping
 */
function getCalibrationKey(workflow) {
  const ageBand = getAgeBand(parseInt(workflow.age) || 35);
  const gender = (workflow.gender || '').toLowerCase().startsWith('f') ? 'female' : 'male';
  const conditions = (workflow.medical_history?.pre_existing_conditions || []).length;
  const condBucket = conditions >= 3 ? '3plus' : String(conditions);
  return `${ageBand}_${gender}_${condBucket}`;
}

/**
 * Calculate calibration offsets from all workflows where UW overrode the AI
 * @param {Array} allWorkflows - all completed workflows from the workflow engine
 * @returns {Object} calibration results
 */
function calculateCalibrationOffsets(allWorkflows) {
  // Find workflows where AI made a recommendation AND UW made a different decision
  const overrides = [];

  for (const wf of allWorkflows) {
    if (!wf.ai_analysis?.recommendation) continue;

    const aiRec = wf.ai_analysis.recommendation;
    const aiLoading = wf.ai_analysis.loading_percentage || 0;

    // Determine final UW decision from state
    let uwDecision = null;
    if (['uw_approved', 'auto_approved'].includes(wf.state)) uwDecision = 'accept_standard';
    else if (wf.state === 'uw_rejected') uwDecision = 'decline';
    else if (wf.state === 'counter_offered') uwDecision = 'accept_with_loading';
    else continue; // Skip non-terminal states

    // Check for manual UW review (not auto-decision)
    const uwReview = (wf.state_history || []).find(s => s.state === 'uw_approved' || s.state === 'uw_rejected');

    // Only count as override if UW manually changed the AI recommendation
    const isOverride = (aiRec === 'decline' && uwDecision !== 'decline') ||
                       (aiRec === 'accept_standard' && uwDecision !== 'accept_standard') ||
                       (aiRec === 'accept_with_loading' && uwDecision === 'accept_standard') ||
                       (aiRec === 'accept_with_loading' && uwDecision === 'decline') ||
                       (aiRec === 'refer' && uwDecision !== 'refer');

    const key = getCalibrationKey(wf);

    overrides.push({
      key,
      ai_recommendation: aiRec,
      uw_decision: uwDecision,
      ai_loading: aiLoading,
      uw_loading: wf.decision?.loading_percentage || aiLoading, // If UW modified loading
      is_override: isOverride,
      workflow_id: wf.id,
      product: wf.product_name
    });
  }

  // Group by profile key and calculate offsets
  const grouped = {};
  for (const o of overrides) {
    if (!grouped[o.key]) grouped[o.key] = [];
    grouped[o.key].push(o);
  }

  const newOffsets = {};
  for (const [key, records] of Object.entries(grouped)) {
    const overrideRecords = records.filter(r => r.is_override);
    if (records.length < 3) continue; // Need minimum sample size

    const overrideRate = overrideRecords.length / records.length;
    const avgAiLoading = Math.round(records.reduce((s, r) => s + r.ai_loading, 0) / records.length);
    const avgUwLoading = Math.round(records.reduce((s, r) => s + r.uw_loading, 0) / records.length);
    const loadingAdjustment = avgUwLoading - avgAiLoading; // Negative means UW reduces loading

    // Find the most common UW override direction
    const overrideDirections = {};
    for (const o of overrideRecords) {
      overrideDirections[o.uw_decision] = (overrideDirections[o.uw_decision] || 0) + 1;
    }
    const dominantOverride = Object.entries(overrideDirections).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Calculate score adjustment: if UWs consistently approve what AI refers, score should be nudged up
    let scoreAdjustment = 0;
    if (overrideRate >= 0.3 && overrideRecords.length >= 3) { // Significant override pattern
      if (dominantOverride === 'accept_standard' || dominantOverride === 'accept_with_loading') {
        scoreAdjustment = Math.min(Math.round(overrideRate * 10), 8); // Nudge score up, max +8
      } else if (dominantOverride === 'decline') {
        scoreAdjustment = -Math.min(Math.round(overrideRate * 10), 8); // Nudge score down, max -8
      }
    }

    newOffsets[key] = {
      sample_size: records.length,
      override_count: overrideRecords.length,
      override_rate: Math.round(overrideRate * 100),
      loading_adjustment: loadingAdjustment,
      score_adjustment: scoreAdjustment,
      dominant_override: dominantOverride,
      avg_ai_loading: avgAiLoading,
      avg_uw_loading: avgUwLoading,
      last_calculated: new Date().toISOString()
    };
  }

  calibrationOffsets = newOffsets;

  return {
    total_workflows_analyzed: allWorkflows.length,
    total_with_decisions: overrides.length,
    total_overrides: overrides.filter(r => r.is_override).length,
    profile_types_with_offsets: Object.keys(newOffsets).length,
    offsets: newOffsets
  };
}

/**
 * Apply calibration offset to a scoring result
 * Called from runAIAnalysis after the initial score is calculated
 */
function applyCalibrationOffset(workflow, score, loading, recommendation) {
  const key = getCalibrationKey(workflow);
  const offset = calibrationOffsets[key];

  if (!offset || offset.sample_size < 5 || offset.override_rate < 25) {
    return { adjusted: false, score, loading, recommendation, calibration: null };
  }

  let adjustedScore = score + offset.score_adjustment;
  adjustedScore = Math.max(0, Math.min(100, adjustedScore)); // Clamp 0-100

  let adjustedLoading = loading + offset.loading_adjustment;
  adjustedLoading = Math.max(0, adjustedLoading); // Loading can't go negative

  // Determine if recommendation should change based on adjusted score
  let adjustedRecommendation = recommendation;
  // Only adjust if the override pattern is strong (>40% override rate, >5 samples)
  if (offset.override_rate >= 40 && offset.override_count >= 5 && offset.dominant_override) {
    if (recommendation === 'refer' && offset.dominant_override === 'accept_standard' && adjustedScore >= 75) {
      adjustedRecommendation = 'accept_with_loading';
    } else if (recommendation === 'refer' && offset.dominant_override === 'decline' && adjustedScore < 55) {
      adjustedRecommendation = 'decline';
    }
    // Never auto-change a decline to approve — too risky
    // Never auto-change an approve to decline — business loss
  }

  return {
    adjusted: true,
    score: adjustedScore,
    loading: adjustedLoading,
    recommendation: adjustedRecommendation,
    original_score: score,
    original_loading: loading,
    original_recommendation: recommendation,
    calibration: {
      profile_key: key,
      score_adjustment: offset.score_adjustment,
      loading_adjustment: offset.loading_adjustment,
      override_rate: offset.override_rate + '%',
      sample_size: offset.sample_size,
      dominant_override: offset.dominant_override,
      note: `Based on ${offset.sample_size} similar profiles, UWs override AI ${offset.override_rate}% of the time${offset.loading_adjustment !== 0 ? '. Loading adjusted by ' + offset.loading_adjustment + '%' : ''}${offset.score_adjustment !== 0 ? '. Score adjusted by ' + (offset.score_adjustment > 0 ? '+' : '') + offset.score_adjustment : ''}.`
    }
  };
}

function getCalibrationOffsets() { return calibrationOffsets; }
function loadCalibrationOffsets(data) { if (data) calibrationOffsets = data; }

module.exports = {
  ingestHistoricalData,
  findSimilarCases,
  addLiveDecision,
  createProfileVector,
  getCorpus,
  loadCorpus,
  getStats,
  getCorpusSize,
  calculateCalibrationOffsets,
  applyCalibrationOffset,
  getCalibrationOffsets,
  loadCalibrationOffsets,
  getCalibrationKey
};
