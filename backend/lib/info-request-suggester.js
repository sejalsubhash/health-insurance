/**
 * Info Request Suggester — Phase 3
 *
 * Walks workflow.ai_analysis.findings + .violations and proposes specific
 * additional tests, documents, or clarifications the underwriter should request.
 *
 * Pure function. UI shows the suggestions; UW selects which to send.
 */

// Suggestion catalogue keyed by trigger condition. Each rule:
//   trigger(finding|violation|extracted) → boolean
//   item: { type: 'test'|'document'|'clarification', name, description, mandatory, fasting_required }
const SUGGESTION_RULES = [
  // ─── Lipid retests ───
  {
    id: 'LIPID_REPEAT',
    trigger_paths: ['blood_chemistry.tc_hdl_ratio.value', 'blood_chemistry.total_cholesterol.value', 'blood_chemistry.ldl.value', 'blood_chemistry.triglycerides.value'],
    finding_keywords: ['TC/HDL', 'Cholesterol', 'LDL', 'Triglycerides'],
    item: {
      type: 'test', name: 'Fasting Lipid Profile (Repeat)',
      description: 'Repeat full lipid panel after 12-hour fast. Original values were borderline/abnormal.',
      mandatory: true, fasting_required: true,
      reason_template: 'Initial lipid values flagged — ${finding_value}. Confirmation needed before final decision.'
    }
  },
  // ─── Diabetes confirmation ───
  {
    id: 'DIABETES_CONFIRM',
    trigger_paths: ['blood_chemistry.fasting_glucose.value', 'blood_chemistry.hba1c.value'],
    finding_keywords: ['Fasting Glucose', 'HbA1c'],
    item: {
      type: 'test', name: 'Diabetic Profile (FBS + PPBS + HbA1c)',
      description: 'Complete diabetic workup: fasting glucose, post-prandial glucose, and HbA1c. Required to assess glycemic control.',
      mandatory: true, fasting_required: true,
      reason_template: 'Glucose/HbA1c flagged — ${finding_value}. Need full diabetic workup.'
    }
  },
  // ─── Renal workup ───
  {
    id: 'RENAL_WORKUP',
    trigger_paths: ['blood_chemistry.serum_creatinine.value', 'blood_chemistry.blood_urea.value', 'blood_chemistry.egfr.value'],
    finding_keywords: ['Serum Creatinine', 'Creatinine', 'Blood Urea'],
    item: {
      type: 'test', name: 'Kidney Function Test (KFT) + USG KUB',
      description: 'KFT panel (urea, creatinine, eGFR) plus ultrasound of kidneys, ureters, bladder. Required to assess renal status.',
      mandatory: true, fasting_required: false,
      reason_template: 'Renal markers flagged — ${finding_value}. Need full renal assessment.'
    }
  },
  // ─── Urine protein → 24-hour urine ───
  {
    id: 'URINE_24HR',
    trigger_paths: ['urine_analysis.protein.value', 'urine_analysis.microalbumin.value', 'urine_analysis.acr.value'],
    finding_keywords: ['Urine Protein', 'Microalbumin', 'ACR'],
    item: {
      type: 'test', name: '24-hour Urine Protein',
      description: '24-hour urine collection for total protein quantification. Required when spot urine shows proteinuria.',
      mandatory: true, fasting_required: false,
      reason_template: 'Spot urine protein abnormal — ${finding_value}. Need 24-hour quantification.'
    }
  },
  // ─── Liver workup ───
  {
    id: 'LIVER_WORKUP',
    trigger_paths: ['blood_chemistry.sgpt_alt.value', 'blood_chemistry.sgot_ast.value', 'blood_chemistry.total_bilirubin.value', 'liver_extended.ggt.value'],
    finding_keywords: ['SGPT', 'SGOT', 'Bilirubin', 'GGT', 'ALT', 'AST'],
    item: {
      type: 'test', name: 'Extended Liver Panel + USG Abdomen + Hepatitis Screen',
      description: 'GGT, ALP, total/direct bilirubin, albumin, USG abdomen (focus on liver), HBsAg, anti-HCV.',
      mandatory: true, fasting_required: false,
      reason_template: 'Liver enzymes flagged — ${finding_value}. Need extended workup including viral hepatitis screen.'
    }
  },
  // ─── Cardiac stress test ───
  {
    id: 'CARDIAC_STRESS',
    trigger_paths: ['cardiac.ecg.overall_interpretation', 'cardiac_extended.lvef.value'],
    finding_keywords: ['ECG', 'LVEF', 'CV Risk'],
    age_min: 40,
    item: {
      type: 'test', name: 'TMT (Stress Test) + 2D Echo',
      description: 'Treadmill stress test and 2D echocardiogram with LVEF measurement. Required when ECG borderline or CV risk elevated.',
      mandatory: true, fasting_required: false,
      reason_template: 'Cardiac findings — ${finding_value}. Need stress test + echo.'
    }
  },
  // ─── Hypertension home monitoring ───
  {
    id: 'BP_DIARY',
    trigger_paths: ['physical_exam.blood_pressure.systolic.value', 'physical_exam.blood_pressure.diastolic.value'],
    finding_keywords: ['Blood Pressure'],
    item: {
      type: 'document', name: '7-day Home BP Diary',
      description: 'Twice-daily BP readings for 7 consecutive days, recorded with timestamps and any medications taken.',
      mandatory: false, fasting_required: false,
      reason_template: 'BP elevated in clinic — ${finding_value}. Home readings will rule out white-coat hypertension.'
    }
  },
  // ─── BMI discrepancy → physical re-exam ───
  {
    id: 'BMI_REEXAM',
    finding_keywords: ['BMI Discrepancy', 'BMI Discrepancy'],
    item: {
      type: 'test', name: 'In-person Physical Re-examination',
      description: 'Independent measurement of height, weight, BMI, and BP at an empanelled centre.',
      mandatory: true, fasting_required: false,
      reason_template: 'Declared vs measured BMI mismatch detected. Independent verification required.'
    }
  },
  // ─── Undisclosed medication → prescription history ───
  {
    id: 'PRESCRIPTION_HISTORY',
    finding_keywords: ['Undisclosed Condition', 'Non-disclosure'],
    item: {
      type: 'document', name: 'Prescription History (last 12 months)',
      description: 'All prescriptions from any treating physician in the last 12 months, plus a diagnosis letter from the prescribing doctor.',
      mandatory: true, fasting_required: false,
      reason_template: 'Medication evidence suggests undeclared condition — ${finding_value}. Need full prescription history.'
    }
  },
  // ─── Thyroid workup ───
  {
    id: 'THYROID_WORKUP',
    trigger_paths: ['thyroid.tsh.value'],
    finding_keywords: ['TSH'],
    item: {
      type: 'test', name: 'Complete Thyroid Profile (TSH + T3 + T4 + Anti-TPO)',
      description: 'Full thyroid panel with antibodies. Required when TSH is outside normal range.',
      mandatory: true, fasting_required: false,
      reason_template: 'TSH abnormal — ${finding_value}. Need complete thyroid panel.'
    }
  },
  // ─── Alcohol declaration ───
  {
    id: 'ALCOHOL_DECLARATION',
    finding_keywords: ['Alcohol', 'GGT'],
    item: {
      type: 'clarification', name: 'Alcohol Consumption Declaration',
      description: 'Specify exact units per week, type of alcohol, and duration of consumption pattern.',
      mandatory: true, fasting_required: false,
      reason_template: 'Liver markers or declared lifestyle suggest alcohol-related risk. Need detailed declaration.'
    }
  },
  // ─── Family history clarification ───
  {
    id: 'FAMILY_HISTORY_DETAILS',
    finding_keywords: ['Family History'],
    item: {
      type: 'clarification', name: 'Detailed Family Medical History',
      description: 'Provide age of onset, relationship (parent/sibling/grandparent), and current status of affected family members for each condition declared.',
      mandatory: false, fasting_required: false,
      reason_template: 'Family history declared but lacks specifics. Need ages of onset and relationships.'
    }
  }
];

/**
 * suggestInfoRequests(workflow) → { items: [], reasoning: [], total }
 *
 * Returns suggested items deduplicated by id, with each item carrying a populated reason from the
 * triggering finding. UW reviews and selects which to send.
 */
function suggestInfoRequests(workflow) {
  const analysis = workflow.ai_analysis || {};
  const findings = analysis.findings || [];
  const violations = analysis.guidelines_compliance?.violations || [];
  const warnings = analysis.guidelines_compliance?.warnings || [];
  const age = parseInt(workflow.age, 10) || 0;

  const triggered = new Map(); // id → { rule, triggers: [{ source, value, parameter }] }

  // Pass 1: findings
  for (const f of findings) {
    const fName = f.parameter || '';
    for (const rule of SUGGESTION_RULES) {
      // Skip age-gated rules if age below threshold
      if (rule.age_min && age < rule.age_min) continue;
      const matchesKeyword = (rule.finding_keywords || []).some(kw => fName.toLowerCase().includes(kw.toLowerCase()));
      if (!matchesKeyword) continue;
      // Skip if status is normal (rules only fire on adverse findings)
      if (f.status === 'normal') continue;
      if (!triggered.has(rule.id)) triggered.set(rule.id, { rule, triggers: [] });
      triggered.get(rule.id).triggers.push({ source: 'finding', parameter: fName, value: f.value, status: f.status });
    }
  }

  // Pass 2: violations and warnings (use rule path)
  for (const v of [...violations, ...warnings]) {
    for (const rule of SUGGESTION_RULES) {
      if (!rule.trigger_paths) continue;
      if (rule.age_min && age < rule.age_min) continue;
      if (rule.trigger_paths.includes(v.path)) {
        if (!triggered.has(rule.id)) triggered.set(rule.id, { rule, triggers: [] });
        triggered.get(rule.id).triggers.push({ source: v.severity === 'critical' ? 'violation' : 'warning', parameter: v.rule_name, value: v.value, threshold: v.threshold });
      }
    }
  }

  // Pass 3: missing tests for SA tier (special trigger from analysis)
  for (const f of findings) {
    if (f.parameter === 'Missing Tests for SA Tier' || f.parameter === 'Mandatory Tests Missing') {
      const missingList = (f.value || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const test of missingList) {
        const id = `MISSING_TEST_${test.toUpperCase().replace(/\W/g, '_')}`;
        triggered.set(id, {
          rule: { id },
          triggers: [{ source: 'mandatory_test', parameter: 'SA Tier Requirement', value: test }],
          customItem: {
            type: 'test', name: test.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: `Required test for sum assured tier — ${test}`,
            mandatory: true, fasting_required: ['blood_work', 'blood_chemistry', 'lipid_profile'].includes(test.toLowerCase()),
            reason_template: 'Required by SA tier but not present in extracted data.'
          }
        });
      }
    }
  }

  // Build items array, dedup'd, with reasons populated from first trigger
  const items = [];
  const reasoning = [];
  for (const [id, entry] of triggered) {
    const baseItem = entry.customItem || entry.rule?.item;
    if (!baseItem) continue;
    const firstTrigger = entry.triggers[0];
    const reason = (baseItem.reason_template || '').replace('${finding_value}', firstTrigger.value || firstTrigger.parameter || '');
    items.push({
      id,
      type: baseItem.type,
      name: baseItem.name,
      description: baseItem.description,
      mandatory: baseItem.mandatory,
      fasting_required: baseItem.fasting_required,
      reason,
      triggered_by: entry.triggers.slice(0, 3) // cap for readability
    });
    reasoning.push({ id, name: baseItem.name, trigger_count: entry.triggers.length });
  }

  return {
    total: items.length,
    items,
    reasoning,
    suggested_at: new Date().toISOString()
  };
}

module.exports = { suggestInfoRequests, SUGGESTION_RULES };
