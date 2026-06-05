/**
 * Vendor API Simulator — Dummy PPHC Vendor APIs
 * Simulates empanelled PPHC vendor endpoints for:
 *   - Report submission via API
 *   - Status tracking
 *   - Face-scan / finger-scan based PPMC
 *   - Report retrieval with structured data
 *
 * 3 simulated vendors: MedCheck India, HealthAssure, DigiMedic
 */
const { v4: uuidv4 } = require('uuid');

// ─── Vendor Registry ───
// CAT assignment: CAT1→VEND-001, CAT2→VEND-002, CAT3→VEND-004, CAT4→VEND-005, TeleMER→VEND-003
const VENDORS = {
  'VEND-001': {
    id: 'VEND-001', name: 'MedCheck India', code: 'MCI',
    type: 'full_pphc', cat_level: 'CAT_1',
    regions: ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Hyderabad', 'Pune', 'Ghaziabad', 'Noida'],
    sla_hours: 48, api_version: 'v2', status: 'active',
    capabilities: ['blood_work', 'urine_analysis', 'physical_exam', 'hematology', 'esr', 'sgpt', 'hba1c', 'serum_creatinine', 'total_cholesterol'],
    avg_tat_hours: 36, compliance_rate: 97.2,
    description: 'CAT 1 specialist — MER, CBC, ESR, SGPT, HbA1c, Serum Creatinine, Total Cholesterol, Urine Routine'
  },
  'VEND-002': {
    id: 'VEND-002', name: 'HealthAssure', code: 'HA',
    type: 'full_pphc', cat_level: 'CAT_2',
    regions: ['Mumbai', 'Delhi', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Pune', 'Surat'],
    sla_hours: 72, api_version: 'v1', status: 'active',
    capabilities: ['blood_work', 'ecg', 'urine_analysis', 'physical_exam', 'hematology', 'esr', 'sgpt', 'hba1c', 'serum_creatinine', 'total_cholesterol', 'serum_triglycerides', 'urine_microalbumin', 'blood_chemistry'],
    avg_tat_hours: 52, compliance_rate: 94.8,
    description: 'CAT 2 specialist — All CAT 1 tests + ECG, Total Cholesterol, Serum Triglycerides, Urine Microalbumin'
  },
  'VEND-003': {
    id: 'VEND-003', name: 'DigiMedic', code: 'DM',
    type: 'tele_pphc', cat_level: 'tele_mer',
    regions: ['Pan India'],
    sla_hours: 24, api_version: 'v2', status: 'active',
    capabilities: ['tele_mer', 'video_mer', 'face_scan', 'finger_scan', 'chatbot_assessment'],
    avg_tat_hours: 8, compliance_rate: 99.1,
    description: 'Tele MER specialist — Phone/video medical interview, questionnaire, examiner assessment'
  },
  'VEND-004': {
    id: 'VEND-004', name: 'ClinAssure Diagnostics', code: 'CAD',
    type: 'full_pphc', cat_level: 'CAT_3',
    regions: ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Pune', 'Kolkata'],
    sla_hours: 96, api_version: 'v2', status: 'active',
    capabilities: ['blood_work', 'ecg', 'urine_analysis', 'physical_exam', 'hematology', 'esr', 'sgpt', 'hba1c', 'serum_creatinine', 'total_cholesterol', 'serum_triglycerides', 'urine_microalbumin', 'lipid_profile', 'lft', 'kft', 'blood_chemistry', 'cardiac_echo', 'tmt'],
    avg_tat_hours: 72, compliance_rate: 96.4,
    description: 'CAT 3 specialist — All CAT 2 tests + Lipid Profile (HDL/LDL/VLDL), LFT, KFT, 2D Echo, TMT'
  },
  'VEND-005': {
    id: 'VEND-005', name: 'MedElite Advanced Diagnostics', code: 'MEAD',
    type: 'full_pphc', cat_level: 'CAT_4',
    regions: ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai'],
    sla_hours: 120, api_version: 'v2', status: 'active',
    capabilities: ['blood_work', 'ecg', 'urine_analysis', 'physical_exam', 'hematology', 'esr', 'sgpt', 'hba1c', 'serum_creatinine', 'total_cholesterol', 'serum_triglycerides', 'urine_microalbumin', 'lipid_profile', 'lft', 'kft', 'blood_chemistry', 'cardiac_echo', 'tmt', 'chest_xray', 'psa', 'pap_smear', 'thyroid_panel', 'extended_kidney'],
    avg_tat_hours: 96, compliance_rate: 98.7,
    description: 'CAT 4 specialist — All CAT 3 tests + Chest X-Ray, PSA (Male), PAP Smear (Female), Thyroid Panel, Extended Kidney Function'
  }
};

// ─── Simulated Report Data Generators ───

function generatePhysicalExam(age, gender) {
  const isMale = gender === 'male';
  const bmiBase = 18.5 + Math.random() * 12;
  const heightCm = isMale ? 160 + Math.random() * 25 : 150 + Math.random() * 20;
  const weightKg = bmiBase * ((heightCm / 100) ** 2);
  const systolic = 110 + Math.floor(Math.random() * 40) + (age > 50 ? 10 : 0);
  const diastolic = 70 + Math.floor(Math.random() * 20);

  return {
    height_cm: Math.round(heightCm * 10) / 10,
    weight_kg: Math.round(weightKg * 10) / 10,
    bmi: { value: Math.round(bmiBase * 10) / 10, ref_range: '18.5-24.9', flag: bmiBase > 30 ? 'high' : bmiBase < 18.5 ? 'low' : 'normal' },
    bmi_category: bmiBase < 18.5 ? 'underweight' : bmiBase < 25 ? 'normal' : bmiBase < 30 ? 'overweight' : 'obese_class1',
    blood_pressure: {
      systolic: { value: systolic, unit: 'mmHg', ref_range: '<120', flag: systolic > 140 ? 'high' : 'normal' },
      diastolic: { value: diastolic, unit: 'mmHg', ref_range: '<80', flag: diastolic > 90 ? 'high' : 'normal' },
      classification: systolic < 120 ? 'normal' : systolic < 130 ? 'elevated' : systolic < 140 ? 'stage1_hypertension' : 'stage2_hypertension'
    },
    pulse: { value: 68 + Math.floor(Math.random() * 20), unit: 'bpm', ref_range: '60-100', flag: 'normal' },
    respiratory_rate: { value: 16 + Math.floor(Math.random() * 4), unit: '/min', ref_range: '12-20', flag: 'normal' },
    spo2: { value: 97 + Math.floor(Math.random() * 3), unit: '%', ref_range: '95-100', flag: 'normal' },
    build: bmiBase < 18.5 ? 'thin' : bmiBase < 25 ? 'average' : 'obese',
    general_appearance: 'Normal, healthy appearance',
    chest_examination: 'normal', chest_findings: 'Clear lung fields bilaterally',
    abdomen_examination: 'normal', abdomen_findings: 'Soft, non-tender, no organomegaly',
    cns_examination: 'normal', cns_findings: 'Oriented, no focal deficits',
    musculoskeletal: 'normal', musculoskeletal_findings: 'Full ROM, no deformities',
    skin: 'normal', skin_findings: 'No rash, lesions or pigmentation',
    lymph_nodes: 'normal', lymph_node_findings: 'No palpable lymphadenopathy',
    vision: { right: '6/6', left: '6/6', corrected: false },
    hearing: 'normal', dental: 'good',
    abnormal_count: (systolic > 140 ? 1 : 0) + (bmiBase > 30 ? 1 : 0),
    physician_remarks: 'General health satisfactory. Vitals within acceptable limits.'
  };
}

function generateBloodChemistry(age) {
  const glucoseBase = 80 + Math.random() * 40 + (age > 50 ? 10 : 0);
  const hba1cBase = 4.8 + Math.random() * 1.8;
  const cholBase = 150 + Math.random() * 60;
  const hdlBase = 35 + Math.random() * 25;

  return {
    fasting_glucose: { value: Math.round(glucoseBase), unit: 'mg/dL', ref_range: '70-100', flag: glucoseBase > 126 ? 'high' : glucoseBase > 100 ? 'borderline' : 'normal' },
    post_prandial_glucose: { value: Math.round(glucoseBase * 1.4), unit: 'mg/dL', ref_range: '70-140', flag: 'normal' },
    hba1c: { value: Math.round(hba1cBase * 10) / 10, unit: '%', ref_range: '4.0-5.6', flag: hba1cBase > 6.5 ? 'high' : hba1cBase > 5.7 ? 'borderline' : 'normal' },
    total_cholesterol: { value: Math.round(cholBase), unit: 'mg/dL', ref_range: '<200', flag: cholBase > 240 ? 'high' : 'normal' },
    hdl: { value: Math.round(hdlBase), unit: 'mg/dL', ref_range: '>40', flag: hdlBase < 40 ? 'low' : 'normal' },
    ldl: { value: Math.round(cholBase * 0.6), unit: 'mg/dL', ref_range: '<100', flag: 'normal' },
    triglycerides: { value: Math.round(100 + Math.random() * 80), unit: 'mg/dL', ref_range: '<150', flag: 'normal' },
    vldl: { value: Math.round(15 + Math.random() * 15), unit: 'mg/dL', ref_range: '<30', flag: 'normal' },
    tc_hdl_ratio: { value: Math.round((cholBase / hdlBase) * 10) / 10, unit: 'ratio', ref_range: '<4.5', flag: (cholBase / hdlBase) > 5.5 ? 'high' : 'normal' },
    sgot_ast: { value: Math.round(20 + Math.random() * 20), unit: 'U/L', ref_range: '8-40', flag: 'normal' },
    sgpt_alt: { value: Math.round(18 + Math.random() * 25), unit: 'U/L', ref_range: '7-56', flag: 'normal' },
    alkaline_phosphatase: { value: Math.round(60 + Math.random() * 50), unit: 'U/L', ref_range: '44-147', flag: 'normal' },
    ggt: { value: Math.round(15 + Math.random() * 25), unit: 'U/L', ref_range: '9-48', flag: 'normal' },
    total_bilirubin: { value: Math.round((0.3 + Math.random() * 0.7) * 10) / 10, unit: 'mg/dL', ref_range: '0.1-1.2', flag: 'normal' },
    direct_bilirubin: { value: Math.round((0.05 + Math.random() * 0.2) * 100) / 100, unit: 'mg/dL', ref_range: '0.0-0.3', flag: 'normal' },
    total_protein: { value: Math.round((6.5 + Math.random() * 1.5) * 10) / 10, unit: 'g/dL', ref_range: '6.0-8.3', flag: 'normal' },
    albumin: { value: Math.round((3.8 + Math.random() * 1.2) * 10) / 10, unit: 'g/dL', ref_range: '3.5-5.5', flag: 'normal' },
    globulin: { value: Math.round((2.2 + Math.random() * 1.0) * 10) / 10, unit: 'g/dL', ref_range: '2.0-3.5', flag: 'normal' },
    ag_ratio: { value: Math.round((1.2 + Math.random() * 0.6) * 10) / 10, unit: 'ratio', ref_range: '1.0-2.2', flag: 'normal' },
    blood_urea: { value: Math.round(10 + Math.random() * 10), unit: 'mg/dL', ref_range: '7-20', flag: 'normal' },
    serum_creatinine: { value: Math.round((0.7 + Math.random() * 0.5) * 10) / 10, unit: 'mg/dL', ref_range: '0.7-1.3', flag: 'normal' },
    egfr: { value: Math.round(80 + Math.random() * 30), unit: 'mL/min/1.73m2', ref_range: '>90', flag: 'normal' },
    uric_acid: { value: Math.round((3.5 + Math.random() * 3) * 10) / 10, unit: 'mg/dL', ref_range: '3.4-7.0', flag: 'normal' },
    sodium: { value: Math.round(137 + Math.random() * 6), unit: 'mEq/L', ref_range: '136-145', flag: 'normal' },
    potassium: { value: Math.round((3.8 + Math.random() * 1.0) * 10) / 10, unit: 'mEq/L', ref_range: '3.5-5.0', flag: 'normal' },
    chloride: { value: Math.round(99 + Math.random() * 6), unit: 'mEq/L', ref_range: '98-106', flag: 'normal' },
    calcium: { value: Math.round((8.8 + Math.random() * 1.4) * 10) / 10, unit: 'mg/dL', ref_range: '8.5-10.5', flag: 'normal' },
    phosphorus: { value: Math.round((2.8 + Math.random() * 1.4) * 10) / 10, unit: 'mg/dL', ref_range: '2.5-4.5', flag: 'normal' },
    tsh: { value: Math.round((1.0 + Math.random() * 2.5) * 100) / 100, unit: 'mIU/L', ref_range: '0.4-4.0', flag: 'normal' },
    t3: { value: null, unit: 'ng/dL', ref_range: '80-200', flag: 'not_tested' },
    t4: { value: null, unit: 'mcg/dL', ref_range: '5.1-14.1', flag: 'not_tested' },
    psa: { value: null, unit: 'ng/mL', ref_range: '<4.0', flag: 'not_tested' },
    hiv: { value: 'non_reactive', unit: '', ref_range: 'non_reactive', flag: 'normal' },
    hbsag: { value: 'non_reactive', unit: '', ref_range: 'non_reactive', flag: 'normal' },
    hcv: { value: 'non_reactive', unit: '', ref_range: 'non_reactive', flag: 'normal' },
    vdrl: { value: 'non_reactive', unit: '', ref_range: 'non_reactive', flag: 'normal' },
    cotinine: { value: Math.random() > 0.8 ? Math.round(50 + Math.random() * 150) : Math.round(Math.random() * 8), unit: 'ng/mL', ref_range: '<10', flag: 'normal' },
    abnormal_count: 0, critical_count: 0
  };
}

function generateHematology() {
  return {
    hemoglobin: { value: Math.round((12 + Math.random() * 4) * 10) / 10, unit: 'g/dL', ref_range: '13.0-17.0', flag: 'normal' },
    rbc_count: { value: Math.round((4.2 + Math.random() * 1.2) * 100) / 100, unit: 'million/cumm', ref_range: '4.5-5.5', flag: 'normal' },
    wbc_count: { value: Math.round(5000 + Math.random() * 5000), unit: '/cumm', ref_range: '4000-11000', flag: 'normal' },
    platelet_count: { value: Math.round(180000 + Math.random() * 180000), unit: '/cumm', ref_range: '150000-400000', flag: 'normal' },
    pcv_hematocrit: { value: Math.round((38 + Math.random() * 10) * 10) / 10, unit: '%', ref_range: '40-50', flag: 'normal' },
    mcv: { value: Math.round((82 + Math.random() * 14) * 10) / 10, unit: 'fL', ref_range: '80-100', flag: 'normal' },
    mch: { value: Math.round((27 + Math.random() * 5) * 10) / 10, unit: 'pg', ref_range: '27-32', flag: 'normal' },
    mchc: { value: Math.round((32 + Math.random() * 3) * 10) / 10, unit: 'g/dL', ref_range: '32-36', flag: 'normal' },
    rdw: { value: Math.round((12 + Math.random() * 2) * 10) / 10, unit: '%', ref_range: '11.5-14.5', flag: 'normal' },
    neutrophils: { value: Math.round(50 + Math.random() * 15), unit: '%', ref_range: '40-70', flag: 'normal' },
    lymphocytes: { value: Math.round(25 + Math.random() * 15), unit: '%', ref_range: '20-45', flag: 'normal' },
    monocytes: { value: Math.round(3 + Math.random() * 5), unit: '%', ref_range: '2-10', flag: 'normal' },
    eosinophils: { value: Math.round(1 + Math.random() * 4), unit: '%', ref_range: '1-6', flag: 'normal' },
    basophils: { value: Math.round(Math.random()), unit: '%', ref_range: '0-1', flag: 'normal' },
    esr: { value: Math.round(5 + Math.random() * 12), unit: 'mm/hr', ref_range: '0-20', flag: 'normal' },
    pt: { value: null, unit: 'seconds', ref_range: '11-13.5', flag: 'not_tested' },
    inr: { value: null, unit: 'ratio', ref_range: '0.8-1.2', flag: 'not_tested' },
    aptt: { value: null, unit: 'seconds', ref_range: '25-35', flag: 'not_tested' },
    abnormal_count: 0, critical_count: 0
  };
}

function generateUrineAnalysis() {
  return {
    color: 'Pale Yellow', appearance: 'Clear',
    specific_gravity: { value: Math.round((1.010 + Math.random() * 0.015) * 1000) / 1000, ref_range: '1.005-1.030', flag: 'normal' },
    ph: { value: Math.round((5.5 + Math.random() * 2) * 10) / 10, ref_range: '4.5-8.0', flag: 'normal' },
    protein: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    glucose: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    ketones: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    blood: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    bilirubin: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    urobilinogen: { value: 'normal', ref_range: 'normal', flag: 'normal' },
    nitrite: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    leukocyte_esterase: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    rbc_microscopy: { value: '0-1', unit: '/hpf', ref_range: '0-2', flag: 'normal' },
    wbc_microscopy: { value: '1-2', unit: '/hpf', ref_range: '0-5', flag: 'normal' },
    epithelial_cells: { value: '0-1', unit: '/hpf', ref_range: '0-5', flag: 'normal' },
    casts: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    crystals: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    bacteria: { value: 'nil', ref_range: 'nil', flag: 'normal' },
    microalbumin: { value: Math.round(5 + Math.random() * 10), unit: 'mg/L', ref_range: '<20', flag: 'normal' },
    acr: { value: Math.round(8 + Math.random() * 15), unit: 'mg/g', ref_range: '<30', flag: 'normal' },
    abnormal_count: 0, critical_count: 0
  };
}

function generateCardiac(age) {
  const hr = 65 + Math.floor(Math.random() * 20);
  return {
    ecg: {
      heart_rate: { value: hr, unit: 'bpm', ref_range: '60-100', flag: 'normal' },
      rhythm: 'sinus', axis: 'normal',
      pr_interval: { value: Math.round(140 + Math.random() * 40), unit: 'ms', ref_range: '120-200', flag: 'normal' },
      qrs_duration: { value: Math.round(82 + Math.random() * 30), unit: 'ms', ref_range: '80-120', flag: 'normal' },
      qt_interval: { value: Math.round(360 + Math.random() * 60), unit: 'ms', ref_range: '350-450', flag: 'normal' },
      qtc: { value: Math.round(380 + Math.random() * 40), unit: 'ms', ref_range: '350-450', flag: 'normal' },
      st_segment: 'normal', t_wave: 'normal',
      pathological_q_waves: false, lvh_criteria: false, rvh_criteria: false,
      bundle_branch_block: 'none', arrhythmias: [],
      overall_interpretation: Math.random() > 0.85 ? 'borderline' : 'normal',
      findings: 'Normal sinus rhythm. No significant ST-T changes.'
    },
    echo: {
      lvef: { value: Math.round(55 + Math.random() * 12), unit: '%', ref_range: '55-70', flag: 'normal' },
      lv_dimension_diastole: { value: Math.round(40 + Math.random() * 10), unit: 'mm', ref_range: '35-56', flag: 'normal' },
      lv_dimension_systole: { value: Math.round(25 + Math.random() * 10), unit: 'mm', ref_range: '20-40', flag: 'normal' },
      ivs_thickness: { value: Math.round(7 + Math.random() * 3), unit: 'mm', ref_range: '6-11', flag: 'normal' },
      pw_thickness: { value: Math.round(7 + Math.random() * 3), unit: 'mm', ref_range: '6-11', flag: 'normal' },
      la_dimension: { value: Math.round(28 + Math.random() * 8), unit: 'mm', ref_range: '19-40', flag: 'normal' },
      aortic_root: { value: Math.round(25 + Math.random() * 8), unit: 'mm', ref_range: '20-37', flag: 'normal' },
      rv_dimension: { value: Math.round(15 + Math.random() * 8), unit: 'mm', ref_range: '9-26', flag: 'normal' },
      mitral_valve: 'normal', aortic_valve: 'normal', tricuspid_valve: 'normal', pulmonary_valve: 'normal',
      pericardial_effusion: 'none', rwma: false, diastolic_dysfunction: 'none',
      overall_interpretation: 'normal', findings: 'Normal cardiac structure and function. LVEF preserved.'
    },
    tmt: { performed: age > 40, result: 'negative', mets_achieved: Math.round(8 + Math.random() * 4), max_heart_rate_achieved: Math.round(140 + Math.random() * 30), target_heart_rate_percent: Math.round(80 + Math.random() * 15), st_changes: 'None', symptoms_during_test: 'None', findings: 'Negative for inducible ischemia.' },
    abnormal_count: 0, critical_count: 0
  };
}

function generateImaging() {
  return {
    chest_xray: {
      performed: true, heart_size: 'normal', cardiothoracic_ratio: Math.round((0.42 + Math.random() * 0.08) * 100) / 100,
      lung_fields: 'clear', lung_findings: 'Clear lung fields bilaterally. No active infiltrates.',
      mediastinum: 'normal', costophrenic_angles: 'clear', bony_thorax: 'normal',
      overall_impression: 'normal', findings: 'Normal chest radiograph.'
    },
    usg_abdomen: {
      performed: true,
      liver: { size: 'normal', echotexture: 'normal', focal_lesions: 'none', findings: 'Normal size and echotexture.' },
      gallbladder: { status: 'normal', findings: 'Normal, no calculi.' },
      kidneys: { right_size: '10.2 cm', left_size: '10.5 cm', cortical_echogenicity: 'normal', calculi: 'none', hydronephrosis: 'none', findings: 'B/L kidneys normal in size and echogenicity.' },
      spleen: { size: 'normal', findings: 'Normal.' },
      pancreas: { status: 'normal', findings: 'Normal.' },
      aorta: { status: 'normal', findings: 'Normal caliber.' },
      free_fluid: 'none',
      overall_impression: 'normal', findings: 'Normal abdominal sonography. No organomegaly.'
    },
    other_imaging: [], abnormal_count: 0, critical_count: 0
  };
}

// ─── Vendor Request Store (in-memory for demo) ───
const vendorRequests = new Map();

function submitPPHCRequest(vendorId, proposalData) {
  const vendor = VENDORS[vendorId];
  if (!vendor) throw new Error(`Vendor ${vendorId} not found`);

  const requestId = `${vendor.code}-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
  const request = {
    request_id: requestId,
    vendor_id: vendorId,
    vendor_name: vendor.name,
    proposal_id: proposalData.proposal_id,
    proposer_name: proposalData.proposer_name,
    age: proposalData.age || 35,
    gender: proposalData.gender || 'male',
    sum_assured: proposalData.sum_assured || 0,
    tests_requested: proposalData.tests_requested || vendor.capabilities,
    status: 'scheduled',
    submitted_at: new Date().toISOString(),
    scheduled_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    expected_completion: new Date(Date.now() + vendor.sla_hours * 60 * 60 * 1000).toISOString(),
    report: null,
    status_history: [
      { status: 'submitted', timestamp: new Date().toISOString(), note: 'Request received by vendor' },
      { status: 'scheduled', timestamp: new Date(Date.now() + 1000).toISOString(), note: `Appointment scheduled at ${vendor.regions[0]} center` }
    ]
  };

  vendorRequests.set(requestId, request);

  // Simulate auto-completion after short delay (for demo)
  setTimeout(() => completeVendorRequest(requestId), 3000);

  return request;
}

function completeVendorRequest(requestId) {
  const request = vendorRequests.get(requestId);
  if (!request) return;

  request.status = 'report_ready';
  request.completed_at = new Date().toISOString();
  request.status_history.push(
    { status: 'in_progress', timestamp: new Date(Date.now() - 2000).toISOString(), note: 'Health check-up in progress' },
    { status: 'report_ready', timestamp: new Date().toISOString(), note: 'All reports generated and verified' }
  );

  const age = request.age || 35;
  const gender = request.gender || 'male';

  request.report = {
    report_id: `RPT-${requestId}`,
    generated_at: new Date().toISOString(),
    vendor_reference: requestId,
    physical_exam: generatePhysicalExam(age, gender),
    blood_chemistry: generateBloodChemistry(age),
    hematology: generateHematology(),
    urine_analysis: generateUrineAnalysis(),
    cardiac: generateCardiac(age),
    imaging: generateImaging(),
    physician_summary: {
      overall_impression: 'Proposer appears in general good health. All major organ systems assessed.',
      significant_findings: [],
      recommendations: [],
      fitness_for_insurance: 'Fit for consideration'
    }
  };

  vendorRequests.set(requestId, request);
}

function getVendorRequestStatus(requestId) {
  return vendorRequests.get(requestId) || null;
}

function getVendorReport(requestId) {
  const request = vendorRequests.get(requestId);
  if (!request || !request.report) return null;
  return request.report;
}

function listVendors() {
  return Object.values(VENDORS);
}

function getVendor(vendorId) {
  return VENDORS[vendorId] || null;
}

function listVendorRequests(filters = {}) {
  let requests = Array.from(vendorRequests.values());
  if (filters.vendor_id) requests = requests.filter(r => r.vendor_id === filters.vendor_id);
  if (filters.status) requests = requests.filter(r => r.status === filters.status);
  if (filters.proposal_id) requests = requests.filter(r => r.proposal_id === filters.proposal_id);
  return requests.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
}

module.exports = {
  submitPPHCRequest,
  getVendorRequestStatus,
  getVendorReport,
  completeVendorRequest,
  listVendors,
  getVendor,
  listVendorRequests,
  VENDORS
};
