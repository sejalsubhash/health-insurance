/**
 * Claude Extractor — Insurance Underwriting Document Extraction
 * UPDATED: Uses AWS Bedrock SDK instead of Anthropic SDK
 * - No ANTHROPIC_API_KEY needed
 * - Auth via EC2 IAM role automatically
 * - Traffic via Bedrock PrivateLink — never leaves AWS network
 */
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-south-1'
});


const MODEL = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';
async function callClaude(systemPrompt, userPrompt, maxTokens = 8000) {
  const startTime = Date.now();
  try {
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    };

    const command = new InvokeModelCommand({
      modelId: MODEL,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      accept: 'application/json'
    });

    const response = await client.send(command);
    const body = JSON.parse(Buffer.from(response.body).toString('utf-8'));

    const text = body.content
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
        input: body.usage?.input_tokens || 0,
        output: body.usage?.output_tokens || 0
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
    "consistency_score": 0,
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
    "overall_score": 0,
    "contradictions": [
      { "statement_1": "", "statement_2": "", "topic": "", "severity": "minor|moderate|major" }
    ]
  },
  "deception_risk_index": 0,
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

// ─── MODULE 3: PPHC Report Extraction ───

async function extractPPHCBloodChemistry(documentText) {
  const system = `You are an insurance underwriting AI agent extracting blood chemistry parameters from Pre-Policy Health Check-up (PPHC) lab reports. Extract ALL values with their units and reference ranges. Return ONLY valid JSON.`;

  const prompt = `Extract blood chemistry parameters from this PPHC lab report. Return JSON:
{
  "fasting_glucose": { "value": 0, "unit": "mg/dL", "ref_range": "70-100", "flag": "normal|low|high|critical" },
  "post_prandial_glucose": { "value": 0, "unit": "mg/dL", "ref_range": "70-140", "flag": "" },
  "hba1c": { "value": 0, "unit": "%", "ref_range": "4.0-5.6", "flag": "" },
  "total_cholesterol": { "value": 0, "unit": "mg/dL", "ref_range": "<200", "flag": "" },
  "hdl": { "value": 0, "unit": "mg/dL", "ref_range": ">40", "flag": "" },
  "ldl": { "value": 0, "unit": "mg/dL", "ref_range": "<100", "flag": "" },
  "triglycerides": { "value": 0, "unit": "mg/dL", "ref_range": "<150", "flag": "" },
  "sgot_ast": { "value": 0, "unit": "U/L", "ref_range": "8-40", "flag": "" },
  "sgpt_alt": { "value": 0, "unit": "U/L", "ref_range": "7-56", "flag": "" },
  "serum_creatinine": { "value": 0, "unit": "mg/dL", "ref_range": "0.7-1.3", "flag": "" },
  "egfr": { "value": 0, "unit": "mL/min/1.73m2", "ref_range": ">90", "flag": "" },
  "tsh": { "value": 0, "unit": "mIU/L", "ref_range": "0.4-4.0", "flag": "" },
  "hiv": { "value": "", "unit": "", "ref_range": "non_reactive", "flag": "" },
  "hbsag": { "value": "", "unit": "", "ref_range": "non_reactive", "flag": "" },
  "abnormal_count": 0,
  "critical_count": 0
}

If a parameter is not found, set value to null and flag to "not_tested".

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
  "neutrophils": { "value": 0, "unit": "%", "ref_range": "40-70", "flag": "" },
  "lymphocytes": { "value": 0, "unit": "%", "ref_range": "20-45", "flag": "" },
  "esr": { "value": 0, "unit": "mm/hr", "ref_range": "0-20", "flag": "" },
  "abnormal_count": 0,
  "critical_count": 0
}

Lab Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

async function extractPPHCUrineAnalysis(documentText) {
  const system = `You are an insurance underwriting AI agent extracting urine analysis parameters from PPHC reports. Return ONLY valid JSON.`;

  const prompt = `Extract urine analysis parameters from this PPHC report. Return JSON:
{
  "color": "",
  "specific_gravity": { "value": 0, "ref_range": "1.005-1.030", "flag": "" },
  "ph": { "value": 0, "ref_range": "4.5-8.0", "flag": "" },
  "protein": { "value": "", "ref_range": "nil", "flag": "" },
  "glucose": { "value": "", "ref_range": "nil", "flag": "" },
  "blood": { "value": "", "ref_range": "nil", "flag": "" },
  "abnormal_count": 0,
  "critical_count": 0
}

Lab Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

async function extractPPHCCardiac(documentText) {
  const system = `You are an insurance underwriting AI agent extracting cardiac investigation results from PPHC reports. Return ONLY valid JSON.`;

  const prompt = `Extract cardiac parameters from this PPHC report. Return JSON:
{
  "ecg": {
    "heart_rate": { "value": 0, "unit": "bpm", "ref_range": "60-100", "flag": "" },
    "rhythm": "sinus|atrial_fibrillation|other",
    "overall_interpretation": "normal|abnormal|borderline",
    "findings": ""
  },
  "echo": {
    "lvef": { "value": 0, "unit": "%", "ref_range": "55-70", "flag": "" },
    "overall_interpretation": "normal|abnormal|borderline",
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
    "systolic": { "value": 0, "unit": "mmHg", "flag": "" },
    "diastolic": { "value": 0, "unit": "mmHg", "flag": "" },
    "classification": "normal|elevated|stage1_hypertension|stage2_hypertension"
  },
  "pulse": { "value": 0, "unit": "bpm", "flag": "" },
  "spo2": { "value": 0, "unit": "%", "flag": "" },
  "abnormal_count": 0,
  "physician_remarks": ""
}

Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

async function extractPPHCImaging(documentText) {
  const system = `You are an insurance underwriting AI agent extracting imaging study results from PPHC reports. Return ONLY valid JSON.`;

  const prompt = `Extract imaging results from this PPHC report. Return JSON:
{
  "chest_xray": {
    "performed": false,
    "heart_size": "normal|enlarged",
    "lung_fields": "clear|abnormal",
    "overall_impression": "normal|abnormal",
    "findings": ""
  },
  "usg_abdomen": {
    "performed": false,
    "liver": { "size": "normal|enlarged|small", "echotexture": "normal|fatty|cirrhotic", "findings": "" },
    "kidneys": { "findings": "" },
    "overall_impression": "normal|abnormal",
    "findings": ""
  },
  "abnormal_count": 0,
  "critical_count": 0
}

Report:
${documentText}`;

  return callClaude(system, prompt, 4000);
}

async function performClinicalCorrelation(extractedData) {
  const system = `You are a senior insurance underwriting medical officer. Analyze all extracted PPHC data to identify clinical correlations and risk. Return ONLY valid JSON.`;

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
  const system = `You are an insurance underwriting AI agent analyzing historical claims data. Return ONLY valid JSON.`;

  const prompt = `Extract and analyze claims data from this document. Return JSON:
{
  "portfolio_summary": {
    "total_policies": 0,
    "total_claims": 0,
    "claim_ratio": 0,
    "average_claim_amount": 0
  },
  "claims_by_category": [
    { "category": "", "count": 0, "total_amount": 0, "percentage": 0 }
  ],
  "risk_factor_analysis": [
    { "factor": "", "claim_correlation": 0, "predictive_strength": "low|moderate|high" }
  ],
  "recommendations": []
}

Claims Data:
${documentText}`;

  return callClaude(system, prompt, 6000);
}

async function analyzePortfolioRisk(portfolioData) {
  const system = `You are an insurance portfolio intelligence AI agent. Return ONLY valid JSON.`;

  const dataStr = JSON.stringify(portfolioData, null, 2);
  const prompt = `Analyze this insurance portfolio data:

${dataStr}

Return JSON:
{
  "risk_segments": [
    { "segment": "", "policy_count": 0, "expected_claim_rate": 0, "actual_claim_rate": 0, "adequacy": "adequate|under_priced|over_priced" }
  ],
  "concentration_alerts": [],
  "pricing_recommendations": [],
  "portfolio_health_score": 0
}`;

  return callClaude(system, prompt, 4000);
}

module.exports = {
  extractBiometricData,
  extractTeleMERData,
  extractVoiceAnalysis,
  extractPPHCBloodChemistry,
  extractPPHCHematology,
  extractPPHCUrineAnalysis,
  extractPPHCCardiac,
  extractPPHCPhysicalExam,
  extractPPHCImaging,
  performClinicalCorrelation,
  extractClaimsData,
  analyzePortfolioRisk
};