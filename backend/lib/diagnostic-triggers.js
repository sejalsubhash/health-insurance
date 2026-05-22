/**
 * Diagnostic Trigger Engine
 * Generates personalized medical test panels and tele-MER questionnaires
 * based on proposer risk profile (age, gender, BMI, conditions, SA, product)
 */

// Trigger rules — each evaluates against proposer data and adds tests/questions
const DIAGNOSTIC_TRIGGERS = [
  // Age-based
  { id: 'AGE_45M_ECG', condition: (d) => d.age > 45 && d.gender_m, tests: ['ecg'], reason: 'Age >45 (male) — cardiac screening', category: 'age' },
  { id: 'AGE_50F_ECG', condition: (d) => d.age > 50 && !d.gender_m, tests: ['ecg'], reason: 'Age >50 (female) — cardiac screening', category: 'age' },
  { id: 'AGE_55_TMT', condition: (d) => d.age > 55 && d.sa > 2500000, tests: ['tmt', 'ecg'], reason: 'Age >55 with SA >₹25L — stress test recommended', category: 'age' },
  { id: 'AGE_50M_PSA', condition: (d) => d.age > 50 && d.gender_m, tests: ['psa'], reason: 'Male >50 — prostate screening', category: 'age' },

  // BMI-based
  { id: 'BMI_30_METABOLIC', condition: (d) => d.bmi >= 30, tests: ['fasting_glucose', 'hba1c', 'lipid_profile', 'liver_function'], reason: 'BMI ≥30 (obese) — metabolic syndrome screening', category: 'bmi' },
  { id: 'BMI_35_EXTENDED', condition: (d) => d.bmi >= 35, tests: ['thyroid_panel', 'fasting_glucose', 'hba1c', 'lipid_profile', 'liver_function', 'kidney_function'], reason: 'BMI ≥35 — extended metabolic workup', category: 'bmi' },

  // Condition-based — diabetes
  { id: 'DIABETES_PANEL', condition: (d) => d.has_diabetes, tests: ['fasting_glucose', 'post_prandial_glucose', 'hba1c', 'urine_microalbumin', 'serum_creatinine', 'lipid_profile'], reason: 'Declared diabetes — complete diabetic panel', category: 'condition' },
  // Condition-based — hypertension
  { id: 'HYPERTENSION_PANEL', condition: (d) => d.has_hypertension, tests: ['ecg', 'serum_creatinine', 'urine_microalbumin', 'lipid_profile'], reason: 'Declared hypertension — end-organ damage screening', category: 'condition' },
  // Condition-based — cardiac
  { id: 'CARDIAC_PANEL', condition: (d) => d.has_cardiac, tests: ['ecg', '2d_echo', 'lipid_profile', 'tmt'], reason: 'Declared cardiac history — full cardiac workup', category: 'condition' },
  // Condition-based — thyroid
  { id: 'THYROID_PANEL', condition: (d) => d.has_thyroid, tests: ['thyroid_panel', 'tsh'], reason: 'Declared thyroid condition', category: 'condition' },

  // Family history
  { id: 'FAMILY_CARDIAC', condition: (d) => d.family_cardiac, tests: ['ecg', 'lipid_profile'], reason: 'Family history — cardiac death before 65', category: 'family' },
  { id: 'FAMILY_DIABETES', condition: (d) => d.family_diabetes, tests: ['fasting_glucose', 'hba1c'], reason: 'Family history — diabetes', category: 'family' },

  // Smoking
  { id: 'SMOKER_PANEL', condition: (d) => d.is_smoker && d.age > 40, tests: ['chest_xray', 'pulmonary_function', 'ecg'], reason: 'Smoker >40 — pulmonary and cardiac screening', category: 'lifestyle' },

  // SA-based
  { id: 'SA_25L_FULL', condition: (d) => d.sa > 2500000, tests: ['lipid_profile', 'liver_function', 'kidney_function'], reason: 'SA >₹25L — enhanced biochemistry panel', category: 'sa' },
  { id: 'SA_1CR_COMPREHENSIVE', condition: (d) => d.sa > 10000000, tests: ['lipid_profile', 'liver_function', 'kidney_function', 'ecg', '2d_echo', 'chest_xray', 'urine_analysis'], reason: 'SA >₹1Cr — comprehensive medical examination', category: 'sa' },

  // Combination triggers
  { id: 'DIABETIC_OBESE', condition: (d) => d.has_diabetes && d.bmi >= 28, tests: ['kidney_function', 'liver_function', 'urine_microalbumin'], reason: 'Diabetic + BMI ≥28 — NAFLD and nephropathy screening', category: 'combination' },
];

// Tele-MER questionnaire sections — generated based on triggered categories
const TELEMER_QUESTIONS = {
  general: [
    { id: 'GEN_01', q: 'Are you currently under any medical treatment or taking any medications?', type: 'yesno', followup: 'Please list each medication, dosage, and how long you have been taking it.', priority: 'high' },
    { id: 'GEN_02', q: 'Have you visited any doctor or specialist in the last 12 months?', type: 'yesno', followup: 'Please provide details — which doctor, reason for visit, diagnosis if any.', priority: 'medium' },
    { id: 'GEN_03', q: 'Have you ever been hospitalized or had any surgical procedures?', type: 'yesno', followup: 'Please provide details — when, where, reason, duration of stay.', priority: 'high' },
    { id: 'GEN_04', q: 'Have you been advised any medical test or investigation that you have not yet undergone?', type: 'yesno', followup: 'What test was advised and by which doctor?', priority: 'medium' },
    { id: 'GEN_05', q: 'Do you have any physical disability or impairment?', type: 'yesno', priority: 'medium' },
  ],
  cardiac: [
    { id: 'CARD_01', q: 'Do you experience chest pain, tightness, or discomfort during physical activity or stress?', type: 'yesno', priority: 'high' },
    { id: 'CARD_02', q: 'Do you experience breathlessness while climbing stairs, walking, or at rest?', type: 'yesno', priority: 'high' },
    { id: 'CARD_03', q: 'Have you ever been told you have a heart murmur, irregular heartbeat, or heart valve problem?', type: 'yesno', priority: 'high' },
    { id: 'CARD_04', q: 'Are you currently taking any blood pressure or heart medication?', type: 'yesno', followup: 'Name of medication and dosage?', priority: 'high' },
    { id: 'CARD_05', q: 'Has any blood relative (parent, sibling) had a heart attack, bypass surgery, or died of heart disease before age 65?', type: 'yesno', followup: 'Who and at what age?', priority: 'medium' },
  ],
  metabolic: [
    { id: 'META_01', q: 'Have you been diagnosed with diabetes or pre-diabetes?', type: 'yesno', followup: 'When was it diagnosed? What treatment — oral medication or insulin?', priority: 'high' },
    { id: 'META_02', q: 'Do you experience excessive thirst, frequent urination, or unexplained weight loss?', type: 'yesno', priority: 'medium' },
    { id: 'META_03', q: 'What is your current fasting blood sugar level (if known)?', type: 'text', priority: 'medium' },
    { id: 'META_04', q: 'Do you have any thyroid condition?', type: 'yesno', followup: 'Hypo or hyper thyroid? On medication?', priority: 'medium' },
    { id: 'META_05', q: 'Has anyone in your family been diagnosed with diabetes?', type: 'yesno', followup: 'Which family member and at what age?', priority: 'low' },
  ],
  respiratory: [
    { id: 'RESP_01', q: 'Do you smoke or have you ever smoked?', type: 'yesno', followup: 'How many cigarettes/bidis per day? For how many years? If quit, when?', priority: 'high' },
    { id: 'RESP_02', q: 'Do you use any tobacco products (gutka, pan, chewing tobacco)?', type: 'yesno', followup: 'Type and frequency?', priority: 'high' },
    { id: 'RESP_03', q: 'Do you experience persistent cough, wheezing, or difficulty breathing?', type: 'yesno', priority: 'medium' },
    { id: 'RESP_04', q: 'Have you been diagnosed with asthma, COPD, or any lung condition?', type: 'yesno', followup: 'Treatment details?', priority: 'medium' },
  ],
  renal: [
    { id: 'REN_01', q: 'Have you been told you have any kidney problem or elevated creatinine levels?', type: 'yesno', priority: 'high' },
    { id: 'REN_02', q: 'Do you experience swelling in your feet, ankles, or around your eyes?', type: 'yesno', priority: 'medium' },
    { id: 'REN_03', q: 'Have you noticed any change in the color or frequency of urination?', type: 'yesno', priority: 'medium' },
  ],
  lifestyle: [
    { id: 'LIFE_01', q: 'How often do you consume alcohol?', type: 'choice', options: ['Never', 'Occasionally (social)', 'Weekly', 'Daily'], priority: 'medium' },
    { id: 'LIFE_02', q: 'What is your typical daily physical activity level?', type: 'choice', options: ['Sedentary (desk job)', 'Light (walking)', 'Moderate (exercise 3-4x/week)', 'Active (daily exercise)'], priority: 'low' },
    { id: 'LIFE_03', q: 'What is your occupation and does it involve any hazardous work?', type: 'text', priority: 'medium' },
    { id: 'LIFE_04', q: 'How many hours do you sleep on average?', type: 'text', priority: 'low' },
  ],
  verification: [
    { id: 'VER_01', q: 'Can you confirm your height and weight?', type: 'text', priority: 'high' },
    { id: 'VER_02', q: 'Are all the conditions declared on your proposal form accurate and complete?', type: 'yesno', followup: 'If anything was missed, please declare now.', priority: 'high' },
    { id: 'VER_03', q: 'Is there any health condition or treatment you wish to disclose that was not mentioned earlier?', type: 'yesno', followup: 'Please provide details.', priority: 'high' },
  ]
};

/**
 * Evaluate diagnostic triggers for a proposer
 */
function evaluateTriggers(proposerData) {
  const d = {
    age: parseInt(proposerData.age) || 35,
    gender_m: (proposerData.gender || '').toLowerCase() !== 'female',
    bmi: parseFloat(proposerData.bmi || proposerData.declared_bmi) || 0,
    sa: parseInt(proposerData.sum_assured) || 500000,
    is_smoker: (proposerData.smoking || proposerData.lifestyle?.smoking) === 'current',
    has_diabetes: false, has_hypertension: false, has_cardiac: false, has_thyroid: false,
    family_cardiac: false, family_diabetes: false
  };

  // Parse conditions
  const conditions = proposerData.medical_history?.pre_existing_conditions || proposerData.conditions || [];
  for (const c of conditions) {
    const cl = (typeof c === 'string' ? c : c.name || '').toLowerCase();
    if (cl.includes('diabet')) d.has_diabetes = true;
    if (cl.includes('hypertens') || cl.includes('blood pressure') || cl.includes('bp')) d.has_hypertension = true;
    if (cl.includes('cardiac') || cl.includes('heart') || cl.includes('coronary')) d.has_cardiac = true;
    if (cl.includes('thyroid')) d.has_thyroid = true;
  }

  const familyHx = proposerData.medical_history?.family_history || proposerData.family_history || {};
  if (familyHx.cardiac || familyHx.heart) d.family_cardiac = true;
  if (familyHx.diabetes) d.family_diabetes = true;

  // Evaluate all triggers
  const triggered = [];
  const allTests = new Set();
  const categories = new Set();

  for (const trigger of DIAGNOSTIC_TRIGGERS) {
    try {
      if (trigger.condition(d)) {
        triggered.push({ id: trigger.id, reason: trigger.reason, tests: trigger.tests, category: trigger.category });
        trigger.tests.forEach(t => allTests.add(t));
        categories.add(trigger.category);
      }
    } catch(e) { /* skip bad trigger */ }
  }

  return {
    triggered_rules: triggered,
    recommended_tests: Array.from(allTests),
    categories: Array.from(categories),
    proposer_profile: d,
    total_triggers: triggered.length,
    evaluated_at: new Date().toISOString()
  };
}

/**
 * Generate tele-MER questionnaire based on triggered categories
 */
function generateQuestionnaire(proposerData, triggeredCategories) {
  const sections = [];

  // Always include general and verification
  sections.push({ section: 'General Health', questions: TELEMER_QUESTIONS.general });

  // Add category-specific questions
  if (triggeredCategories.includes('age') || triggeredCategories.includes('condition') || triggeredCategories.includes('family')) {
    if (proposerData.age > 45 || triggeredCategories.some(c => ['condition', 'family'].includes(c))) {
      sections.push({ section: 'Cardiovascular Health', questions: TELEMER_QUESTIONS.cardiac });
    }
  }

  const conditions = (proposerData.medical_history?.pre_existing_conditions || proposerData.conditions || []).map(c => (typeof c === 'string' ? c : c.name || '').toLowerCase());
  if (triggeredCategories.includes('bmi') || conditions.some(c => c.includes('diabet'))) {
    sections.push({ section: 'Metabolic / Diabetic', questions: TELEMER_QUESTIONS.metabolic });
  }

  if (triggeredCategories.includes('lifestyle') || (proposerData.lifestyle?.smoking === 'current')) {
    sections.push({ section: 'Respiratory & Smoking', questions: TELEMER_QUESTIONS.respiratory });
  }

  if (conditions.some(c => c.includes('kidney') || c.includes('renal'))) {
    sections.push({ section: 'Kidney Health', questions: TELEMER_QUESTIONS.renal });
  }

  // Always include lifestyle and verification
  sections.push({ section: 'Lifestyle', questions: TELEMER_QUESTIONS.lifestyle });
  sections.push({ section: 'Verification & Disclosure', questions: TELEMER_QUESTIONS.verification });

  const totalQuestions = sections.reduce((s, sec) => s + sec.questions.length, 0);

  return {
    sections,
    total_questions: totalQuestions,
    estimated_duration_minutes: Math.max(10, Math.ceil(totalQuestions * 1.5)),
    generated_at: new Date().toISOString()
  };
}

module.exports = { evaluateTriggers, generateQuestionnaire, DIAGNOSTIC_TRIGGERS, TELEMER_QUESTIONS };
