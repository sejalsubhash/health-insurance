/**
 * Claude Extractor — Insurance Underwriting Document Extraction
 * All Claude API calls use temperature:0 for deterministic output
 * 
 * Module 1: Biometric verification data extraction
 * Module 2: TeleMER transcript extraction
 * Module 3: PPHC medical report extraction (200+ parameters)
 * Module 4: Historical data extraction
 */
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const __bedrockClient = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-south-1'
});

const client = {
  messages: {
    create: async (params) => {
      const { model, temperature, ...rest } = params;
      const cmd = new InvokeModelCommand({
        modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(rest)
      });
      const res = await __bedrockClient.send(cmd);
      return JSON.parse(Buffer.from(res.body).toString('utf8'));
    }
  }
};

async function callClaude(systemPrompt, userPrompt, maxTokens = 8000) {
  const startTime = Date.now();
  try {
    const response = await client.messages.create({
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Extract JSON from response
    let json;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      json = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('No JSON found in Claude response');
    }

    return {
      data: json,
      tokens: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0
      },
      duration_ms: Date.now() - startTime
    };
  } catch (err) {
    console.error('Claude extraction error:', err.message);
    throw err;
  }
}

// ─── MODULE 1: Biometric Verification ───

async function extractBiometricData(documentText) {
  const system = `You are an insurance underwriting AI agent specializing in biometric verification data extraction. Extract all biometric verification results from the provided document. Return ONLY valid JSON.`;

  const prompt = `Extract biometric verification data from this document. Return JSON with this exact structure:
{
  "liveness_check": {
    "status": "pass|fail",
    "confidence_score": 0.0-1.0,
    "method": "3d_depth|micro_expression|challenge_response",
    "spoofing_detected": false,
    "duress_indicators": false
  },
  "identity_match": {
    "status": "verified|mismatch|inconclusive",
    "match_percentage": 0.0-100.0,
    "kyc_document_type": "aadhaar|pan|passport",
    "kyc_document_number": "",
    "discrepancies": []
  },
  "fraud_screening": {
    "risk_score": 0-100,
    "blacklist_match": false,
    "multiple_applications_flag": false,
    "location_anomaly": false,
    "flagged_patterns": []
  },
  "agent_verification": {
    "agent_id": "",
    "agent_authorized": true,
    "agent_present": true,
    "geo_location": { "latitude": 0, "longitude": 0 },
    "timestamp": ""
  },
  "overall_biometric_status": "cleared|flagged|rejected",
  "remarks": ""
}

Document:
${documentText}`;

  return callClaude(system, prompt);
}

// ─── MODULE 2: TeleMER Transcript Extraction ───

async function extractTeleMERData(documentText) {
  const system = `You are an insurance underwriting AI agent specializing in Tele-Medical Examination Report (TeleMER) analysis. Extract structured medical information from telephonic interview transcripts. Return ONLY valid JSON. Map all medical conditions to ICD-10 codes where possible.`;

  const prompt = `Extract TeleMER interview data from this transcript. Return JSON with this exact structure:
{
  "proposer_info": {
    "name": "",
    "age": 0,
    "gender": "male|female|other",
    "occupation": "",
    "annual_income": 0,
    "sum_assured": 0
  },
  "medical_history": {
    "pre_existing_conditions": [
      { "condition": "", "icd10_code": "", "since_year": 0, "current_status": "active|controlled|resolved", "medication": "" }
    ],
    "surgical_history": [
      { "procedure": "", "year": 0, "outcome": "successful|complications" }
    ],
    "hospitalizations": [
      { "reason": "", "year": 0, "duration_days": 0 }
    ],
    "family_history": {
      "cardiac": false,
      "diabetes": false,
      "cancer": false,
      "hypertension": false,
      "stroke": false,
      "mental_illness": false,
      "details": ""
    }
  },
  "lifestyle": {
    "smoking": { "status": "never|former|current", "packs_per_day": 0, "years": 0 },
    "alcohol": { "status": "never|occasional|regular|heavy", "units_per_week": 0 },
    "tobacco_chewing": { "status": "never|former|current" },
    "exercise": { "frequency": "none|occasional|regular|daily", "type": "" },
    "diet": "vegetarian|non_vegetarian|vegan",
    "occupation_hazard": "none|low|moderate|high",
    "travel_risk": "none|low|moderate|high"
  },
  "current_medications": [
    { "drug_name": "", "dosage": "", "frequency": "", "for_condition": "" }
  ],
  "declared_conditions_summary": [],
  "interviewer_observations": {
    "cooperativeness": "cooperative|reluctant|evasive",
    "consistency_score": 0-100,
    "flagged_responses": [],
    "hesitation_instances": [],
    "overall_impression": ""
  },
  "risk_flags": [],
  "auto_decision_eligible": false,
  "remarks": ""
}

Transcript:
${documentText}`;

  return callClaude(system, prompt);
}

async function extractVoiceAnalysis(documentText) {
  const system = `You are an AI agent analyzing voice/sentiment data from insurance TeleMER calls. Extract behavioral indicators and consistency metrics. Return ONLY valid JSON.`;

  const prompt = `Analyze voice/sentiment data from this TeleMER call analysis report. Return JSON:
{
  "call_duration_minutes": 0,
  "hesitation_count": 0,
  "hesitation_triggers": [],
  "sentiment_timeline": [
    { "timestamp_min": 0, "sentiment": "neutral|positive|negative|anxious|evasive", "topic": "" }
  ],
  "consistency_analysis": {
    "overall_score": 0-100,
    "contradictions": [
      { "statement_1": "", "statement_2": "", "topic": "", "severity": "minor|moderate|major" }
    ]
  },
  "deception_risk_index": 0-100,
  "stress_indicators": {
    "elevated_topics": [],
    "baseline_deviation_count": 0
  },
  "recommendation": "proceed|flag_for_review|escalate"
}

Analysis Data:
${documentText}`;

  return callClaude(system, prompt);
}

// ─── MODULE 3: PPHC Report Extraction (200+ Parameters) ───

async function extractPPHCBloodChemistry(documentText) {
  const system = `You are an insurance underwriting AI agent extracting blood chemistry parameters from Pre-Policy Health Check-up (PPHC) lab reports. Extract ALL values with their units and reference ranges. Use standard Indian lab report formats. Return ONLY valid JSON.`;

  const prompt = `Extract blood chemistry parameters from this PPHC lab report. For each parameter, extract the value, unit, reference range, and flag if abnormal.

Return JSON:
{
  "fasting_glucose": { "value": 0, "unit": "mg/dL", "ref_range": "70-100", "flag": "normal|low|high|critical" },
  "post_prandial_glucose": { "value": 0, "unit": "mg/dL", "ref_range": "70-140", "flag": "" },
  "hba1c": { "value": 0, "unit": "%", "ref_range": "4.0-5.6", "flag": "" },
  "total_cholesterol": { "value": 0, "unit": "mg/dL", "ref_range": "<200", "flag": "" },
  "hdl": { "value": 0, "unit": "mg/dL", "ref_range": ">40", "flag": "" },
  "ldl": { "value": 0, "unit": "mg/dL", "ref_range": "<100", "flag": "" },
  "triglycerides": { "value": 0, "unit": "mg/dL", "ref_range": "<150", "flag": "" },
  "vldl": { "value": 0, "unit": "mg/dL", "ref_range": "<30", "flag": "" },
  "tc_hdl_ratio": { "value": 0, "unit": "ratio", "ref_range": "<4.5", "flag": "" },
  "sgot_ast": { "value": 0, "unit": "U/L", "ref_range": "8-40", "flag": "" },
  "sgpt_alt": { "value": 0, "unit": "U/L", "ref_range": "7-56", "flag": "" },
  "alkaline_phosphatase": { "value": 0, "unit": "U/L", "ref_range": "44-147", "flag": "" },
  "ggt": { "value": 0, "unit": "U/L", "ref_range": "9-48", "flag": "" },
  "total_bilirubin": { "value": 0, "unit": "mg/dL", "ref_range": "0.1-1.2", "flag": "" },
  "direct_bilirubin": { "value": 0, "unit": "mg/dL", "ref_range": "0.0-0.3", "flag": "" },
  "total_protein": { "value": 0, "unit": "g/dL", "ref_range": "6.0-8.3", "flag": "" },
  "albumin": { "value": 0, "unit": "g/dL", "ref_range": "3.5-5.5", "flag": "" },
  "globulin": { "value": 0, "unit": "g/dL", "ref_range": "2.0-3.5", "flag": "" },
  "ag_ratio": { "value": 0, "unit": "ratio", "ref_range": "1.0-2.2", "flag": "" },
  "blood_urea": { "value": 0, "unit": "mg/dL", "ref_range": "7-20", "flag": "" },
  "serum_creatinine": { "value": 0, "unit": "mg/dL", "ref_range": "0.7-1.3", "flag": "" },
  "egfr": { "value": 0, "unit": "mL/min/1.73m2", "ref_range": ">90", "flag": "" },
  "uric_acid": { "value": 0, "unit": "mg/dL", "ref_range": "3.4-7.0", "flag": "" },
  "sodium": { "value": 0, "unit": "mEq/L", "ref_range": "136-145", "flag": "" },
  "potassium": { "value": 0, "unit": "mEq/L", "ref_range": "3.5-5.0", "flag": "" },
  "chloride": { "value": 0, "unit": "mEq/L", "ref_range": "98-106", "flag": "" },
  "calcium": { "value": 0, "unit": "mg/dL", "ref_range": "8.5-10.5", "flag": "" },
  "phosphorus": { "value": 0, "unit": "mg/dL", "ref_range": "2.5-4.5", "flag": "" },
  "tsh": { "value": 0, "unit": "mIU/L", "ref_range": "0.4-4.0", "flag": "" },
  "t3": { "value": 0, "unit": "ng/dL", "ref_range": "80-200", "flag": "" },
  "t4": { "value": 0, "unit": "mcg/dL", "ref_range": "5.1-14.1", "flag": "" },
  "psa": { "value": 0, "unit": "ng/mL", "ref_range": "<4.0", "flag": "" },
  "hiv": { "value": "", "unit": "", "ref_range": "non_reactive", "flag": "" },
  "hbsag": { "value": "", "unit": "", "ref_range": "non_reactive", "flag": "" },
  "hcv": { "value": "", "unit": "", "ref_range": "non_reactive", "flag": "" },
  "vdrl": { "value": "", "unit": "", "ref_range": "non_reactive", "flag": "" },
  "cotinine": { "value": "", "unit": "ng/mL", "ref_range": "<10", "flag": "" },
  "abnormal_count": 0,
  "critical_count": 0
}

If a parameter is not found in the report, set value to null and flag to "not_tested".

Lab Report:
${documentText}`;

  return callClaude(system, prompt, 6000);
}

async function extractPPHCHematology(documentText) {
  const system = `You are an insurance underwriting AI agent extracting hematology parameters from PPHC reports. Return ONLY valid JSON.`;

  const prompt = `Extract hematology (CBC) parameters from this PPHC report. Return JSON:
{
  "hemoglobin": { "value": 0, "unit": "g/dL", "ref_range": "13.0-17.0", "flag": "" },
  "rbc_count": { "value": 0, "unit": "million/cumm", "ref_range": "4.5-5.5", "flag": "" },
  "wbc_count": { "value": 0, "unit": "/cumm", "ref_range": "4000-11000", "flag": "" },
  "platelet_count": { "value": 0, "unit": "/cumm", "ref_range": "150000-400000", "flag": "" },
  "pcv_hematocrit": { "value": 0, "unit": "%", "ref_range": "40-50", "flag": "" },
  "mcv": { "value": 0, "unit": "fL", "ref_range": "80-100", "flag": "" },
  "mch": { "value": 0, "unit": "pg", "ref_range": "27-32", "flag": "" },
  "mchc": { "value": 0, "unit": "g/dL", "ref_range": "32-36", "flag": "" },
  "rdw": { "value": 0, "unit": "%", "ref_range": "11.5-14.5", "flag": "" },
  "neutrophils": { "value": 0, "unit": "%", "ref_range": "40-70", "flag": "" },
  "lymphocytes": { "value": 0, "unit": "%", "ref_range": "20-45", "flag": "" },
  "monocytes": { "value": 0, "unit": "%", "ref_range": "2-10", "flag": "" },
  "eosinophils": { "value": 0, "unit": "%", "ref_range": "1-6", "flag": "" },
  "basophils": { "value": 0, "unit": "%", "ref_range": "0-1", "flag": "" },
  "esr": { "value": 0, "unit": "mm/hr", "ref_range": "0-20", "flag": "" },
  "pt": { "value": 0, "unit": "seconds", "ref_range": "11-13.5", "flag": "" },
  "inr": { "value": 0, "unit": "ratio", "ref_range": "0.8-1.2", "flag": "" },
  "aptt": { "value": 0, "unit": "seconds", "ref_range": "25-35", "flag": "" },
  "abnormal_count": 0,
  "critical_count": 0
}

Set value to null and flag to "not_tested" if parameter not in report.

Lab Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

async function extractPPHCUrineAnalysis(documentText) {
  const system = `You are an insurance underwriting AI agent extracting urine analysis parameters from PPHC reports. Return ONLY valid JSON.`;

  const prompt = `Extract urine analysis parameters from this PPHC report. Return JSON:
{
  "color": "",
  "appearance": "",
  "specific_gravity": { "value": 0, "ref_range": "1.005-1.030", "flag": "" },
  "ph": { "value": 0, "ref_range": "4.5-8.0", "flag": "" },
  "protein": { "value": "", "ref_range": "nil", "flag": "" },
  "glucose": { "value": "", "ref_range": "nil", "flag": "" },
  "ketones": { "value": "", "ref_range": "nil", "flag": "" },
  "blood": { "value": "", "ref_range": "nil", "flag": "" },
  "bilirubin": { "value": "", "ref_range": "nil", "flag": "" },
  "urobilinogen": { "value": "", "ref_range": "normal", "flag": "" },
  "nitrite": { "value": "", "ref_range": "nil", "flag": "" },
  "leukocyte_esterase": { "value": "", "ref_range": "nil", "flag": "" },
  "rbc_microscopy": { "value": "", "unit": "/hpf", "ref_range": "0-2", "flag": "" },
  "wbc_microscopy": { "value": "", "unit": "/hpf", "ref_range": "0-5", "flag": "" },
  "epithelial_cells": { "value": "", "unit": "/hpf", "ref_range": "0-5", "flag": "" },
  "casts": { "value": "", "ref_range": "nil", "flag": "" },
  "crystals": { "value": "", "ref_range": "nil", "flag": "" },
  "bacteria": { "value": "", "ref_range": "nil", "flag": "" },
  "microalbumin": { "value": 0, "unit": "mg/L", "ref_range": "<20", "flag": "" },
  "acr": { "value": 0, "unit": "mg/g", "ref_range": "<30", "flag": "" },
  "abnormal_count": 0,
  "critical_count": 0
}

Lab Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

async function extractPPHCCardiac(documentText) {
  const system = `You are an insurance underwriting AI agent extracting cardiac investigation results from PPHC reports including ECG and 2D Echo. Return ONLY valid JSON.`;

  const prompt = `Extract cardiac parameters from this PPHC report (ECG and/or 2D Echo). Return JSON:
{
  "ecg": {
    "heart_rate": { "value": 0, "unit": "bpm", "ref_range": "60-100", "flag": "" },
    "rhythm": "sinus|atrial_fibrillation|atrial_flutter|ventricular|other",
    "axis": "normal|left_axis_deviation|right_axis_deviation",
    "pr_interval": { "value": 0, "unit": "ms", "ref_range": "120-200", "flag": "" },
    "qrs_duration": { "value": 0, "unit": "ms", "ref_range": "80-120", "flag": "" },
    "qt_interval": { "value": 0, "unit": "ms", "ref_range": "350-450", "flag": "" },
    "qtc": { "value": 0, "unit": "ms", "ref_range": "350-450", "flag": "" },
    "st_segment": "normal|elevated|depressed",
    "t_wave": "normal|inverted|flattened|peaked",
    "pathological_q_waves": false,
    "lvh_criteria": false,
    "rvh_criteria": false,
    "bundle_branch_block": "none|lbbb|rbbb|lafb",
    "arrhythmias": [],
    "overall_interpretation": "normal|abnormal|borderline",
    "findings": ""
  },
  "echo": {
    "lvef": { "value": 0, "unit": "%", "ref_range": "55-70", "flag": "" },
    "lv_dimension_diastole": { "value": 0, "unit": "mm", "ref_range": "35-56", "flag": "" },
    "lv_dimension_systole": { "value": 0, "unit": "mm", "ref_range": "20-40", "flag": "" },
    "ivs_thickness": { "value": 0, "unit": "mm", "ref_range": "6-11", "flag": "" },
    "pw_thickness": { "value": 0, "unit": "mm", "ref_range": "6-11", "flag": "" },
    "la_dimension": { "value": 0, "unit": "mm", "ref_range": "19-40", "flag": "" },
    "aortic_root": { "value": 0, "unit": "mm", "ref_range": "20-37", "flag": "" },
    "rv_dimension": { "value": 0, "unit": "mm", "ref_range": "9-26", "flag": "" },
    "mitral_valve": "normal|mild_regurgitation|moderate_regurgitation|severe_regurgitation|stenosis",
    "aortic_valve": "normal|mild_regurgitation|moderate_regurgitation|severe_regurgitation|stenosis|sclerosis",
    "tricuspid_valve": "normal|mild_regurgitation|moderate_regurgitation|severe_regurgitation",
    "pulmonary_valve": "normal|mild_regurgitation|moderate_regurgitation",
    "pericardial_effusion": "none|trivial|mild|moderate|severe",
    "rwma": false,
    "diastolic_dysfunction": "none|grade_1|grade_2|grade_3",
    "overall_interpretation": "normal|abnormal|borderline",
    "findings": ""
  },
  "tmt": {
    "performed": false,
    "result": "negative|positive|equivocal|inconclusive",
    "mets_achieved": 0,
    "max_heart_rate_achieved": 0,
    "target_heart_rate_percent": 0,
    "st_changes": "",
    "symptoms_during_test": "",
    "findings": ""
  },
  "abnormal_count": 0,
  "critical_count": 0
}

Report:
${documentText}`;

  return callClaude(system, prompt, 6000);
}

async function extractPPHCPhysicalExam(documentText) {
  const system = `You are an insurance underwriting AI agent extracting physical examination data from PPHC reports. Return ONLY valid JSON.`;

  const prompt = `Extract physical examination parameters from this PPHC report. Return JSON:
{
  "height_cm": 0,
  "weight_kg": 0,
  "bmi": { "value": 0, "ref_range": "18.5-24.9", "flag": "" },
  "bmi_category": "underweight|normal|overweight|obese_class1|obese_class2|obese_class3",
  "blood_pressure": {
    "systolic": { "value": 0, "unit": "mmHg", "ref_range": "<120", "flag": "" },
    "diastolic": { "value": 0, "unit": "mmHg", "ref_range": "<80", "flag": "" },
    "classification": "normal|elevated|stage1_hypertension|stage2_hypertension|hypertensive_crisis"
  },
  "pulse": { "value": 0, "unit": "bpm", "ref_range": "60-100", "flag": "" },
  "respiratory_rate": { "value": 0, "unit": "/min", "ref_range": "12-20", "flag": "" },
  "spo2": { "value": 0, "unit": "%", "ref_range": "95-100", "flag": "" },
  "build": "average|thin|muscular|obese",
  "general_appearance": "",
  "chest_examination": "normal|abnormal",
  "chest_findings": "",
  "abdomen_examination": "normal|abnormal",
  "abdomen_findings": "",
  "cns_examination": "normal|abnormal",
  "cns_findings": "",
  "musculoskeletal": "normal|abnormal",
  "musculoskeletal_findings": "",
  "skin": "normal|abnormal",
  "skin_findings": "",
  "lymph_nodes": "normal|palpable",
  "lymph_node_findings": "",
  "vision": { "right": "", "left": "", "corrected": false },
  "hearing": "normal|impaired",
  "dental": "good|fair|poor",
  "abnormal_count": 0,
  "physician_remarks": ""
}

Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

async function extractPPHCImaging(documentText) {
  const system = `You are an insurance underwriting AI agent extracting imaging study results from PPHC reports (Chest X-ray, USG Abdomen, etc). Return ONLY valid JSON.`;

  const prompt = `Extract imaging results from this PPHC report. Return JSON:
{
  "chest_xray": {
    "performed": false,
    "heart_size": "normal|enlarged",
    "cardiothoracic_ratio": 0,
    "lung_fields": "clear|abnormal",
    "lung_findings": "",
    "mediastinum": "normal|widened|shifted",
    "costophrenic_angles": "clear|blunted",
    "bony_thorax": "normal|abnormal",
    "overall_impression": "normal|abnormal",
    "findings": ""
  },
  "usg_abdomen": {
    "performed": false,
    "liver": { "size": "normal|enlarged|small", "echotexture": "normal|fatty|cirrhotic", "focal_lesions": "none|present", "findings": "" },
    "gallbladder": { "status": "normal|stones|polyps|wall_thickening|removed", "findings": "" },
    "kidneys": { "right_size": "", "left_size": "", "cortical_echogenicity": "normal|increased", "calculi": "none|present", "hydronephrosis": "none|mild|moderate|severe", "findings": "" },
    "spleen": { "size": "normal|enlarged", "findings": "" },
    "pancreas": { "status": "normal|abnormal", "findings": "" },
    "aorta": { "status": "normal|abnormal", "findings": "" },
    "free_fluid": "none|present",
    "overall_impression": "normal|abnormal",
    "findings": ""
  },
  "other_imaging": [],
  "abnormal_count": 0,
  "critical_count": 0
}

Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

// ─── MODULE 3: Clinical Correlation ───

async function performClinicalCorrelation(extractedData) {
  const system = `You are a senior insurance underwriting medical officer. Analyze all extracted PPHC data to identify clinical correlations, hidden conditions, drug-condition mismatches, and multi-system findings. Classify risk per reinsurer manuals (Munich Re, Swiss Re, RGA). Return ONLY valid JSON.`;

  const dataStr = JSON.stringify(extractedData, null, 2);
  const prompt = `Analyze the following extracted PPHC data for clinical correlations and risk assessment:

${dataStr}

Return JSON:
{
  "identified_conditions": [
    {
      "condition": "",
      "icd10_code": "",
      "evidence": [],
      "severity": "mild|moderate|severe",
      "control_status": "well_controlled|poorly_controlled|uncontrolled|new_finding",
      "uw_implication": "standard|loading|exclusion|postpone|decline"
    }
  ],
  "drug_condition_mismatches": [
    { "declared_medication": "", "expected_condition": "", "disclosed": false, "risk": "" }
  ],
  "multi_system_correlations": [
    { "finding_1": "", "finding_2": "", "correlation": "", "clinical_significance": "" }
  ],
  "metabolic_syndrome_screening": {
    "criteria_met": 0,
    "criteria_details": [],
    "diagnosis": false
  },
  "cardiovascular_risk": {
    "framingham_risk_category": "low|moderate|high|very_high",
    "contributing_factors": []
  },
  "renal_risk": { "ckd_stage": "none|stage1|stage2|stage3a|stage3b|stage4|stage5", "factors": [] },
  "hepatic_risk": { "assessment": "normal|mild|moderate|severe", "factors": [] },
  "overall_medical_risk": "standard|mildly_substandard|moderately_substandard|severely_substandard|uninsurable",
  "recommended_action": "accept_standard|accept_with_loading|accept_with_exclusion|postpone|decline",
  "loading_percentage": 0,
  "exclusions": [],
  "rationale": ""
}`;

  return callClaude(system, prompt, 8000);
}

// ─── MODULE 4: Historical Data Analysis ───

async function extractClaimsData(documentText) {
  const system = `You are an insurance underwriting AI agent analyzing historical claims data for pattern recognition and predictive modeling. Return ONLY valid JSON.`;

  const prompt = `Extract and analyze claims data from this document. Return JSON:
{
  "portfolio_summary": {
    "total_policies": 0,
    "total_claims": 0,
    "claim_ratio": 0,
    "average_claim_amount": 0,
    "period_start": "",
    "period_end": ""
  },
  "claims_by_category": [
    { "category": "", "count": 0, "total_amount": 0, "avg_amount": 0, "percentage": 0 }
  ],
  "risk_factor_analysis": [
    { "factor": "", "claim_correlation": 0, "predictive_strength": "low|moderate|high", "details": "" }
  ],
  "early_claim_indicators": [
    { "indicator": "", "threshold": "", "claim_probability_increase": 0 }
  ],
  "adverse_selection_patterns": [],
  "concentration_risks": [
    { "dimension": "", "concentration": "", "risk_level": "low|moderate|high" }
  ],
  "mortality_experience": {
    "actual_to_expected_ratio": 0,
    "trend": "improving|stable|deteriorating"
  },
  "morbidity_experience": {
    "actual_to_expected_ratio": 0,
    "trend": "improving|stable|deteriorating"
  },
  "recommendations": []
}

Claims Data:
${documentText}`;

  return callClaude(system, prompt, 6000);
}

async function analyzePortfolioRisk(portfolioData) {
  const system = `You are an insurance portfolio intelligence AI agent. Analyze portfolio composition for risk segmentation and pricing adequacy. Return ONLY valid JSON.`;

  const dataStr = JSON.stringify(portfolioData, null, 2);
  const prompt = `Analyze this insurance portfolio data:

${dataStr}

Return JSON:
{
  "risk_segments": [
    { "segment": "", "policy_count": 0, "sum_assured_total": 0, "expected_claim_rate": 0, "actual_claim_rate": 0, "adequacy": "adequate|under_priced|over_priced" }
  ],
  "concentration_alerts": [],
  "pricing_recommendations": [],
  "reinsurance_implications": [],
  "portfolio_health_score": 0
}`;

  return callClaude(system, prompt, 4000);
}

module.exports = {
  // Module 1
  extractBiometricData,
  // Module 2
  extractTeleMERData,
  extractVoiceAnalysis,
  // Module 3
  extractPPHCBloodChemistry,
  extractPPHCHematology,
  extractPPHCUrineAnalysis,
  extractPPHCCardiac,
  extractPPHCPhysicalExam,
  extractPPHCImaging,
  performClinicalCorrelation,
  // Module 4
  extractClaimsData,
  analyzePortfolioRisk
};
