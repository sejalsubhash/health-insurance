/**
 * STP classifier smoke test — exercises all routing paths.
 * Run: node test-stp.js
 */
const fs = require('fs');
const path = require('path');
const stp = require('./lib/stp-classifier');
const riskEngine = require('./lib/medical-risk-engine');

const riskParams = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'risk-params.json'), 'utf8'));
const uwGuidelines = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'uw-guidelines.json'), 'utf8'));
const stpRules = riskParams.stp_eligibility_rules;

// Mimic POL-001 Arogya Sanjeevani STP-enabled
const stpEnabledPolicy = { stp_eligible: true, stp_max_age: 45, stp_max_sa: 500000 };
// Mimic POL-003 Critical Illness STP-disabled
const stpDisabledPolicy = { stp_eligible: false };

const cases = [
  {
    name: 'CLEAN — 30yo non-smoker, SA 3L, normal BMI',
    proposal: { proposer_name: 'Clean Kumar', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never', alcohol: 'never', tobacco_chewing: 'never', occupation_hazard: 'none', exercise: 'regular' }, medical_history: { pre_existing_conditions: [], family_history: 'none', hospitalizations: 0, surgery_types: [] } },
    policy: stpEnabledPolicy,
    expected: 'stp_auto_issue'
  },
  {
    name: 'CLEAN but policy not STP-enabled',
    proposal: { proposer_name: 'Wrong Product', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Critical Illness', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never', alcohol: 'never', tobacco_chewing: 'never', occupation_hazard: 'none' }, medical_history: { pre_existing_conditions: [], family_history: 'none' } },
    policy: stpDisabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'BLOCKED — current smoker',
    proposal: { proposer_name: 'Smoker Rao', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'current', alcohol: 'never', tobacco_chewing: 'never', occupation_hazard: 'none' }, medical_history: { pre_existing_conditions: [], family_history: 'none' } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'BLOCKED — age 50 > max 45',
    proposal: { proposer_name: 'Older Singh', age: 50, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never' }, medical_history: { pre_existing_conditions: [] } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'BLOCKED — SA 10L > STP cap 5L',
    proposal: { proposer_name: 'Big SA', age: 30, gender: 'male', sum_assured: 1000000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never' }, medical_history: { pre_existing_conditions: [] } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'BLOCKED — declared diabetes',
    proposal: { proposer_name: 'Diabetic Patel', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never' }, medical_history: { pre_existing_conditions: ['diabetes'], family_history: 'none' } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'BLOCKED — BMI 34',
    proposal: { proposer_name: 'Obese Sharma', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 165, weight_kg: 93, lifestyle: { smoking: 'never' }, medical_history: { pre_existing_conditions: [] } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'SOFT FLAG — age 47, clean otherwise → telemer',
    proposal: { proposer_name: 'Borderline Age', age: 47, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never', alcohol: 'never', tobacco_chewing: 'never', occupation_hazard: 'none' }, medical_history: { pre_existing_conditions: [], family_history: 'none' } },
    policy: { stp_eligible: true, stp_max_age: 50, stp_max_sa: 500000 }, // raised age cap so we hit soft flag not hard block
    expected: 'nstp_telemer'
  },
  {
    name: 'BLOCKED — family history cardiac',
    proposal: { proposer_name: 'Family Cardiac', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never' }, medical_history: { pre_existing_conditions: [], family_history: 'cardiac' } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'BLOCKED — heavy alcohol',
    proposal: { proposer_name: 'Heavy Drinker', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never', alcohol: 'heavy' }, medical_history: { pre_existing_conditions: [] } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  },
  {
    name: 'BLOCKED — prior hospitalization',
    proposal: { proposer_name: 'Hospital History', age: 30, gender: 'male', sum_assured: 300000, product_name: 'Arogya Sanjeevani', height_cm: 172, weight_kg: 68, lifestyle: { smoking: 'never' }, medical_history: { pre_existing_conditions: [], hospitalizations: 2 } },
    policy: stpEnabledPolicy,
    expected: 'nstp_full_pphc'
  }
];

let pass = 0, fail = 0;
for (const tc of cases) {
  const evaluation = stp.evaluateSTPEligibility(tc.proposal, tc.policy, stpRules);
  const ok = evaluation.route === tc.expected;
  if (ok) pass++; else fail++;
  const label = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${label}  ${tc.name}`);
  console.log(`         route=${evaluation.route} eligible=${evaluation.eligible}`);
  if (!ok) {
    console.log(`         expected=${tc.expected}`);
    console.log(`         reason=${evaluation.reason}`);
    console.log(`         blocking=${JSON.stringify(evaluation.blocking_factors.map(b => b.code))}`);
    console.log(`         soft=${JSON.stringify(evaluation.soft_flags.map(b => b.code))}`);
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);

// Also exercise runDeclaredDataAnalysis on the clean case
console.log('\n--- Declared-only analysis on CLEAN case ---');
const clean = cases[0];
const lightAnalysis = stp.runDeclaredDataAnalysis(clean.proposal, riskParams, uwGuidelines, [], riskEngine);
console.log(`Score: ${lightAnalysis.risk_score?.normalized}/100 (${lightAnalysis.risk_score?.grade})`);
console.log(`Violations: ${lightAnalysis.guidelines_compliance?.violations?.length}`);
console.log(`Warnings: ${lightAnalysis.guidelines_compliance?.warnings?.length}`);
console.log(`Decision: ${lightAnalysis.decision?.recommendation}`);

process.exit(fail > 0 ? 1 : 0);
