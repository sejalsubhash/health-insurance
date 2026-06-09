// ─── ICMR Clinical Text Analyser ────────────────────────────────────────────
// Analyses non-numeric clinical text from vendor PDFs + manual medical
// feedback entered by UW/Medical Officer — using ICMR guidelines stored
// in PostgreSQL config table (key: 'icmr-guidelines').
//
// Called automatically after numeric extraction in submit-documents.
// Also called when manual feedback is added to an already-analysed workflow.
//
// Does NOT touch numeric scoring — that is handled by Per-CAT Scoring Config.
// ─────────────────────────────────────────────────────────────────────────────

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const __bedrockClient = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-south-1'
});

// ── Default ICMR guidelines (seeded on first run, updatable via Masters UI) ──
const DEFAULT_ICMR_GUIDELINES = `
ICMR GUIDELINES FOR INSURANCE UNDERWRITING — INDIAN POPULATION
(Source: ICMR-INDIAB 2023, ICMR Hypertension Guidelines 2023, ICMR Dyslipidaemia Guidelines 2023)

IMPORTANT: These guidelines use Indian-population-specific cut-offs which differ from WHO/international standards.

━━━ DIABETES & GLYCAEMIA ━━━
• Normal fasting glucose: < 100 mg/dL
• Impaired Fasting Glucose (Pre-diabetes): 100–125 mg/dL — BORDERLINE RISK
• Diabetes diagnosis: ≥ 126 mg/dL on two occasions — HIGH RISK
• Post-prandial glucose normal: < 140 mg/dL
• OGTT 2-hr: 140–199 = Pre-diabetes, ≥ 200 = Diabetes
• HbA1C: < 5.7% Normal | 5.7–6.4% Pre-diabetes (BORDERLINE) | ≥ 6.5% Diabetes (HIGH) | ≥ 8% Poorly controlled (VERY HIGH)
• Diabetes with organ involvement (nephropathy/retinopathy/neuropathy) = DECLINE trigger for high SA
• Indian-specific: Diabetes risk begins at lower BMI (23 kg/m2) compared to Western populations

━━━ HYPERTENSION ━━━
• Normal: < 130/80 mmHg
• Elevated BP: 130–139/80–89 mmHg — BORDERLINE RISK (document as borderline)
• Stage 1 Hypertension: 130–139/80–89 mmHg with risk factors — HIGH RISK
• Stage 2 Hypertension: ≥ 140/90 mmHg — HIGH RISK
• Hypertensive Crisis: ≥ 180/120 mmHg — DECLINE trigger
• Target organ damage (LVH on ECG, retinopathy Grade 3+, nephropathy) = upgrade risk by one level
• White coat hypertension: confirmed by ABPM — classify as BORDERLINE

━━━ OBESITY (INDIAN CUT-OFFS — DIFFERENT FROM WHO) ━━━
• Normal: BMI 18.5–22.9 kg/m2
• Overweight (Action Level 1): BMI 23.0–24.9 kg/m2 — BORDERLINE (Indian-specific)
• Obese (Action Level 2): BMI 25.0–29.9 kg/m2 — SIGNIFICANT RISK
• Obese Class II: BMI 30.0–34.9 kg/m2 — HIGH RISK
• Obese Class III: BMI ≥ 35 kg/m2 — VERY HIGH RISK / potential DECLINE trigger
• Central obesity: Waist circumference > 90 cm (male) / > 80 cm (female) — add loading
• Note: Indian BMI thresholds are 2–3 units lower than WHO because Indians have higher metabolic risk at lower BMI

━━━ DYSLIPIDAEMIA ━━━
• Desirable Total Cholesterol: < 200 mg/dL
• Borderline high TC: 200–239 mg/dL — BORDERLINE RISK
• High TC: ≥ 240 mg/dL — HIGH RISK
• LDL optimal: < 100 mg/dL | Near optimal: 100–129 | Borderline high: 130–159 | High: ≥ 160 | Very high: ≥ 190
• HDL protective: > 60 mg/dL | Low (risk factor): < 40 mg/dL male / < 50 mg/dL female
• Triglycerides: Normal < 150 | Borderline 150–199 | High 200–499 | Very high ≥ 500 (pancreatitis risk)
• TC/HDL ratio: < 3.5 excellent | 3.5–5.0 acceptable | > 5.0 high risk
• Familial hypercholesterolaemia (TC > 300 or LDL > 190 with family history) = SIGNIFICANT RISK

━━━ CARDIOVASCULAR RISK (ICMR/Indian Framingham) ━━━
• Low risk: < 10% 10-year CVD event probability
• Moderate risk: 10–20% 10-year CVD event probability
• High risk: > 20% 10-year CVD event probability
• Indian risk factors (each = +1): Age > 55M/65F, smoking, diabetes, hypertension, low HDL, family history CVD
• ECG changes indicating ischaemia (ST depression, T-wave inversion in 2+ leads) = SIGNIFICANT RISK
• ST elevation, new LBBB = DECLINE trigger
• LVH on ECG with hypertension = HIGH RISK
• Prior MI, CABG, PCI in history = HIGH RISK (require 2D Echo)

━━━ KIDNEY FUNCTION (CKD STAGING — ICMR/KDIGO) ━━━
• eGFR ≥ 90 (CKD G1): Normal or high — NORMAL if no proteinuria
• eGFR 60–89 (CKD G2): Mildly decreased — BORDERLINE (monitor)
• eGFR 45–59 (CKD G3a): Mild-moderate decrease — SIGNIFICANT RISK
• eGFR 30–44 (CKD G3b): Moderate-severe decrease — HIGH RISK
• eGFR < 30 (CKD G4/5): Severe/kidney failure — DECLINE trigger
• Serum Creatinine: Normal M < 1.3 F < 1.1 mg/dL | Elevated 1.3–1.7 BORDERLINE | > 1.7 HIGH RISK
• Urine Microalbumin 30–300 mg/g = Microalbuminuria (BORDERLINE-HIGH) — doubles CV risk
• Urine Microalbumin > 300 mg/g = Macroalbuminuria — HIGH RISK

━━━ LIVER FUNCTION ━━━
• SGPT/ALT normal: < 40 U/L | Mildly elevated 40–80: BORDERLINE | > 80: HIGH RISK
• SGOT/AST > SGPT (reverse ratio) with alcohol history = alcoholic liver disease — HIGH RISK
• Albumin < 3.5 g/dL = impaired synthetic function — SIGNIFICANT RISK
• Albumin < 3.0 g/dL = severe impairment — HIGH RISK
• Total Bilirubin > 2 mg/dL persistent = hepatic disease — investigate
• GGT elevated with alcohol use = liver damage — load accordingly

━━━ ECG INTERPRETATION (ICMR CARDIAC GUIDELINES) ━━━
• Normal sinus rhythm: NORMAL
• Sinus bradycardia/tachycardia without symptoms: BORDERLINE
• Bundle Branch Block (RBBB): BORDERLINE — needs echo if symptomatic
• LBBB: SIGNIFICANT RISK — may indicate cardiac disease
• LVH criteria met (Sokolov-Lyon > 35mm or Cornell voltage): SIGNIFICANT RISK if with hypertension
• ST depression ≥ 1mm in 2+ leads: SIGNIFICANT RISK — ischaemia possible
• T-wave inversion in 2+ leads: SIGNIFICANT RISK
• ST elevation in 2+ leads: DECLINE trigger — active ischaemia
• Atrial fibrillation: SIGNIFICANT RISK — needs anticoagulation status
• Premature complexes (PAC/PVC) < 10%: BORDERLINE
• Complete heart block: DECLINE trigger
• QTc prolongation > 500ms: HIGH RISK (sudden death risk)

━━━ CHEST X-RAY FINDINGS ━━━
• Normal: NORMAL
• Cardiomegaly (CT ratio > 0.5): SIGNIFICANT RISK — needs echo
• Pulmonary vascular congestion: HIGH RISK — cardiac failure suspected
• Pleural effusion: HIGH RISK — investigate cause
• Pulmonary fibrosis/ILD: HIGH RISK
• Mediastinal widening: SIGNIFICANT RISK — investigate
• Old healed TB (fibrosis, calcified nodes): BORDERLINE — assess symptoms

━━━ NON-DISCLOSURE RED FLAGS ━━━
• Medication found but condition not declared = NON-DISCLOSURE flag
• Metformin/Insulin without diabetes declared = Non-disclosure of diabetes
• Amlodipine/Telmisartan/Atenolol without hypertension declared = Non-disclosure of hypertension
• Atorvastatin/Rosuvastatin without dyslipidaemia declared = Non-disclosure of dyslipidaemia
• Clopidogrel/Aspirin (dual) without cardiac history = Non-disclosure of cardiac event
• Levothyroxine without thyroid disease declared = Non-disclosure of hypothyroidism
• Warfarin/Rivaroxaban without AF or DVT declared = Non-disclosure of clotting disorder

━━━ CLINICAL EXAMINATION FINDINGS ━━━
• Pedal oedema (bilateral pitting): SIGNIFICANT RISK — cardiac failure / hypoalbuminaemia
• Raised JVP: SIGNIFICANT RISK — right heart failure
• S3/S4 gallop on auscultation: HIGH RISK — cardiac failure
• Murmurs (Pan-systolic, diastolic): SIGNIFICANT RISK — valvular disease (needs echo)
• Reduced air entry/crepitations: SIGNIFICANT RISK — respiratory/cardiac
• Hepatomegaly: SIGNIFICANT RISK — hepatic disease or cardiac congestion
• Pallor (Hb < 10): SIGNIFICANT RISK — anaemia
• Lymphadenopathy (generalised): HIGH RISK — investigate
`;

// ── Collect all non-numeric clinical text from extractedData ─────────────────
function collectClinicalText(extractedData) {
  const texts = [];

  // ECG findings text
  const ecg = extractedData?.cardiac?.ecg;
  if (ecg?.findings && ecg.findings.trim()) texts.push(`ECG FINDINGS: ${ecg.findings}`);
  if (ecg?.overall_interpretation && ecg.overall_interpretation !== 'normal') {
    texts.push(`ECG INTERPRETATION: ${ecg.overall_interpretation}`);
  }

  // TMT result
  const tmt = extractedData?.cardiac_extended?.tmt;
  if (tmt?.result && tmt.result !== 'not_done') {
    texts.push(`TREADMILL TEST: Result=${tmt.result}${tmt.findings ? ', Findings='+tmt.findings : ''}`);
  }

  // Chest X-ray
  const cxr = extractedData?.chest_xray;
  if (cxr?.findings && cxr.findings.trim()) texts.push(`CHEST X-RAY FINDINGS: ${cxr.findings}`);
  if (cxr?.interpretation && cxr.interpretation !== 'normal') {
    texts.push(`CHEST X-RAY INTERPRETATION: ${cxr.interpretation}`);
  }

  // 2D Echo findings
  const echo = extractedData?.cardiac_extended;
  if (echo?.echo_findings && echo.echo_findings.trim()) texts.push(`2D ECHO FINDINGS: ${echo.echo_findings}`);

  // Summary from extraction (often contains qualitative text)
  if (extractedData?.summary && extractedData.summary.trim()) {
    texts.push(`EXTRACTION SUMMARY: ${extractedData.summary}`);
  }

  // Drug condition mismatches (non-disclosure markers)
  const mismatches = extractedData?.correlation_data?.drug_condition_mismatches || [];
  if (mismatches.length > 0) {
    const undisclosed = mismatches.filter(m => !m.disclosed);
    if (undisclosed.length > 0) {
      texts.push(`UNDISCLOSED CONDITIONS DETECTED: ${undisclosed.map(m =>
        `${m.drug} implies ${m.implied_condition} (clinical significance: ${m.clinical_significance})`
      ).join('; ')}`);
    }
  }

  // Multi-system correlations
  const msCorr = extractedData?.correlation_data?.multi_system_correlations || [];
  if (msCorr.length > 0) {
    texts.push(`MULTI-SYSTEM CORRELATIONS: ${msCorr.map(c =>
      `[${c.systems?.join('+')}] ${c.finding} (${c.clinical_significance})`
    ).join('; ')}`);
  }

  // Medications found
  const meds = extractedData?.correlation_data?.medications_found || [];
  if (meds.length > 0) {
    texts.push(`MEDICATIONS FOUND IN REPORTS: ${meds.map(m =>
      `${m.name} (treats: ${m.condition}, disclosed: ${m.disclosed})`
    ).join('; ')}`);
  }

  // Urine analysis qualitative
  const urine = extractedData?.urine_analysis;
  if (urine?.protein?.value && !['nil','negative','none'].includes((urine.protein.value+'').toLowerCase())) {
    texts.push(`URINE PROTEIN: ${urine.protein.value} (flag: ${urine.protein.flag||''})`);
  }

  return texts;
}

// ── Main ICMR analysis function ───────────────────────────────────────────────
async function runICMRAnalysis(wf, icmrGuidelinesText) {
  const clinicalTexts = collectClinicalText(wf.extracted_data || {});
  const manualFeedback = (wf.medical_officer_feedback || [])
    .map(f => `[${f.submitted_by} at ${new Date(f.timestamp).toLocaleString('en-IN')}]: ${f.feedback}`)
    .join('\n');

  // If nothing to analyse, return empty result
  if (clinicalTexts.length === 0 && !manualFeedback) {
    return {
      icmr_findings: [],
      overall_clinical_risk: 'low',
      score_adjustment: 0,
      non_disclosure_flags: [],
      analysed_at: new Date().toISOString(),
      source: 'no_clinical_text'
    };
  }

  const clinicalTextBlock = clinicalTexts.length > 0
    ? `CLINICAL TEXT FROM VENDOR REPORTS:\n${clinicalTexts.map((t, i) => `${i+1}. ${t}`).join('\n')}`
    : 'No clinical text extracted from reports.';

  const feedbackBlock = manualFeedback
    ? `\nMANUAL MEDICAL FEEDBACK FROM UNDERWRITER/MEDICAL OFFICER:\n${manualFeedback}`
    : '';

  const prompt = `PROPOSER PROFILE:
Name: ${wf.proposer_name}, Age: ${wf.age}, Gender: ${wf.gender}
Product: ${wf.product_name}, Sum Assured: ₹${(wf.sum_assured||0).toLocaleString('en-IN')}
Declared PED: ${wf.medical_history?.pre_existing_conditions?.join(', ') || 'None declared'}
Lifestyle: Smoking=${wf.lifestyle?.smoking||'unknown'}, Alcohol=${wf.lifestyle?.alcohol||'unknown'}
CAT Level: ${wf.pphc_category || 'Unknown'}

${clinicalTextBlock}${feedbackBlock}

TASK: Analyse the above clinical text against the ICMR guidelines provided in the system prompt.
For EACH distinct clinical finding, classify risk and suggest UW action.

Return ONLY valid JSON:
{
  "icmr_findings": [
    {
      "source": "ECG|CXR|MER|Tele_MER|Manual_Feedback|Medications|Multi_System",
      "finding": "exact clinical text",
      "icmr_classification": "normal|borderline|significant|high|decline_trigger",
      "icmr_reference": "which ICMR guideline applies",
      "risk_implication": "clinical meaning for underwriting",
      "non_disclosure_flag": true|false,
      "suggested_action": "approve|load|refer|decline|request_more_info"
    }
  ],
  "overall_clinical_risk": "low|moderate|high|very_high",
  "score_adjustment": 0,
  "non_disclosure_flags": ["list of undisclosed conditions if any"],
  "additional_tests_recommended": ["any tests ICMR guidelines suggest based on findings"],
  "summary": "2-3 sentence clinical summary for UW"
}

RULES:
- score_adjustment must be 0 or NEGATIVE only (between -20 and 0). Numeric scoring is handled separately.
- Only flag non_disclosure if a medication clearly implies an undisclosed condition.
- If no adverse findings, return icmr_findings as empty array and overall_clinical_risk as "low".
- Do not re-score numeric values — only analyse text/qualitative findings.`;

  try {
    const params = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 3000,
      temperature: 0,
      system: `You are a senior insurance medical officer trained in ICMR (Indian Council of Medical Research) guidelines for health insurance underwriting in India. You analyse clinical text findings from medical examination reports and classify risk using ICMR guidelines specific to the Indian population.\n\nICMR REFERENCE GUIDELINES:\n${icmrGuidelinesText || DEFAULT_ICMR_GUIDELINES}`,
      messages: [{ role: 'user', content: prompt }]
    };

    const cmd = new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(params)
    });

    const res = await __bedrockClient.send(cmd);
    const responseText = JSON.parse(Buffer.from(res.body).toString('utf8'))
      .content.filter(b => b.type === 'text').map(b => b.text).join('');

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in ICMR analysis response');

    const result = JSON.parse(jsonMatch[0]);
    result.analysed_at = new Date().toISOString();
    result.source = 'icmr_bedrock';
    // Clamp score adjustment to 0 or negative
    result.score_adjustment = Math.min(0, Number(result.score_adjustment) || 0);
    return result;

  } catch (e) {
    console.error('[ICMR Analyser] Error:', e.message);
    return {
      icmr_findings: [],
      overall_clinical_risk: 'low',
      score_adjustment: 0,
      non_disclosure_flags: [],
      summary: 'ICMR analysis could not be completed: ' + e.message,
      analysed_at: new Date().toISOString(),
      source: 'error',
      error: e.message
    };
  }
}

module.exports = { runICMRAnalysis, DEFAULT_ICMR_GUIDELINES, collectClinicalText };