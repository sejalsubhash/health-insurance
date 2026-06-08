DELETE FROM config WHERE key = 'cat-scoring';

INSERT INTO config (key, value) VALUES ('cat-scoring', '{
  "CAT_1": {
    "_version": "dynamic-v2",
    "thresholds": {"approve": 80, "refer": 65, "decline_below": 50},
    "components": {
      "medical": {
        "label": "Medical Parameters", "weight": 35,
        "factors": [
          {"id":"bmi_bp","label":"MER — BMI + Blood Pressure","max":7,"bands":[
            {"label":"Normal BMI(18.5-24.9) + Normal BP(<130/85)","value":"both_normal","points":7},
            {"label":"One borderline (BMI 25-29 or BP 130-139/85-89)","value":"one_borderline","points":4},
            {"label":"BMI >=30 or BP >=140/90","value":"both_abnormal","points":1}
          ]},
          {"id":"ecg","label":"ECG — Rhythm, ST, LVH","max":4,"bands":[
            {"label":"Normal sinus rhythm","value":"normal","points":4},
            {"label":"Minor variation / LVH / BBB","value":"borderline","points":2},
            {"label":"Ischaemic / Abnormal / LBBB","value":"abnormal","points":0.5}
          ]},
          {"id":"urine_routine","label":"Urine Routine — Protein, Glucose, RBC","max":2,"bands":[
            {"label":"All negative / Nil","value":"nil","points":2},
            {"label":"Trace protein or 1+ glucose","value":"trace","points":1},
            {"label":"Protein 2+ or Glucose 2+","value":"abnormal","points":0.25}
          ]},
          {"id":"cbc","label":"CBC — Hb, WBC, Platelets","max":4,"bands":[
            {"label":"All normal (Hb>=13.5M/12F, WBC 4k-11k)","value":"normal","points":4},
            {"label":"Hb 11-13.4 or WBC borderline","value":"one_low","points":2},
            {"label":"Anaemia Hb<11 or Leukocytosis >15k","value":"abnormal","points":1}
          ]},
          {"id":"esr","label":"ESR — Inflammation Marker","max":2,"bands":[
            {"label":"Normal M<15 F<20 mm/hr","value":"normal","points":2},
            {"label":"Mildly elevated 20-40","value":"borderline","points":1},
            {"label":"Significantly elevated >40","value":"high","points":0.25}
          ]},
          {"id":"hba1c","label":"HbA1C — Glycated Haemoglobin","max":5,"bands":[
            {"label":"Normal <5.7%","value":"< 5.7","points":5},
            {"label":"Pre-diabetic 5.7-6.4%","value":"5.7-6.4","points":2.5},
            {"label":"Diabetic 6.5-7.9%","value":"6.5-7.9","points":1},
            {"label":"Poorly controlled >=8%","value":">= 8","points":0.25}
          ]},
          {"id":"sgpt","label":"SGPT — Liver Cell Damage (ALT)","max":3,"bands":[
            {"label":"Normal <40 U/L","value":"normal","points":3},
            {"label":"Mildly elevated 40-80","value":"mild","points":1.5},
            {"label":"Elevated >80 U/L","value":"high","points":0.5}
          ]},
          {"id":"serum_creatinine","label":"Serum Creatinine — Kidney Filtration","max":3,"bands":[
            {"label":"Normal M<1.3 F<1.1 mg/dL","value":"normal","points":3},
            {"label":"Mildly elevated 1.3-1.7","value":"mild","points":1.5},
            {"label":"Elevated >1.7 mg/dL","value":"high","points":0.5}
          ]},
          {"id":"total_cholesterol","label":"Total Cholesterol","max":3,"bands":[
            {"label":"Desirable <200 mg/dL","value":"< 200","points":3},
            {"label":"Borderline 200-239","value":"200-239","points":1.5},
            {"label":"High >=240 mg/dL","value":">= 240","points":0.5}
          ]}
        ]
      },
      "lifestyle": {
        "label": "Lifestyle Risk", "weight": 20,
        "factors": [
          {"id":"smoking","label":"Smoking Status","max":7,"bands":[
            {"label":"Never","value":"never","points":7},
            {"label":"Former smoker","value":"former","points":4},
            {"label":"Current smoker","value":"current","points":1}
          ]},
          {"id":"alcohol","label":"Alcohol Use","max":5,"bands":[
            {"label":"Never","value":"never","points":5},
            {"label":"Occasional","value":"occasional","points":4},
            {"label":"Regular","value":"regular","points":2},
            {"label":"Heavy","value":"heavy","points":0.5}
          ]},
          {"id":"tobacco","label":"Tobacco Chewing","max":3,"bands":[
            {"label":"Never","value":"never","points":3},
            {"label":"Former","value":"former","points":1.5},
            {"label":"Current","value":"current","points":0.5}
          ]},
          {"id":"occupation","label":"Occupation Hazard","max":3,"bands":[
            {"label":"None","value":"none","points":3},
            {"label":"Low","value":"low","points":2.5},
            {"label":"Moderate","value":"moderate","points":1.5},
            {"label":"High","value":"high","points":0.5}
          ]},
          {"id":"exercise","label":"Exercise Frequency","max":2,"bands":[
            {"label":"Daily","value":"daily","points":2},
            {"label":"Regular (3-4/week)","value":"regular","points":1.5},
            {"label":"Occasional","value":"occasional","points":1},
            {"label":"None","value":"none","points":0.5}
          ]}
        ]
      },
      "history": {
        "label": "Medical History", "weight": 15,
        "factors": [
          {"id":"pre_existing","label":"Pre-Existing Conditions","max":7,"bands":[
            {"label":"None declared","value":"none","points":7},
            {"label":"Controlled (1 condition)","value":"controlled","points":5},
            {"label":"1-2 active conditions","value":"1-2 active","points":3},
            {"label":"3+ active conditions","value":"3+ active","points":1}
          ]},
          {"id":"family_history","label":"Family Medical History","max":4,"bands":[
            {"label":"None known","value":"none","points":4},
            {"label":"1 risk (cardiac/DM/Ca)","value":"one_risk","points":3},
            {"label":"2 risk conditions","value":"two_risks","points":2},
            {"label":"3+ risk conditions","value":"three_plus","points":1}
          ]},
          {"id":"hospitalizations","label":"Prior Hospitalizations","max":2,"bands":[
            {"label":"None","value":"none","points":2},
            {"label":"1-2 events","value":"1-2","points":1},
            {"label":"3+ events","value":"3+","points":0.5}
          ]},
          {"id":"surgical_history","label":"Surgical History","max":2,"bands":[
            {"label":"None","value":"none","points":2},
            {"label":"1 surgery (minor)","value":"one_minor","points":1.5},
            {"label":"2+ or major surgery","value":"two_plus","points":1}
          ]}
        ]
      },
      "clinical": {
        "label": "Clinical Correlation", "weight": 15,
        "factors": [
          {"id":"drug_condition","label":"Drug-Condition Matching","max":5,"bands":[
            {"label":"Consistent — meds match declared PED","value":"consistent","points":5},
            {"label":"Minor gap — partial disclosure","value":"minor gap","points":2.5},
            {"label":"Non-disclosure likely","value":"non-disclosure","points":0}
          ]},
          {"id":"multi_system","label":"Multi-System Findings","max":5,"bands":[
            {"label":"No multi-system involvement","value":"none","points":5},
            {"label":"1 organ system cluster","value":"1 cluster","points":3},
            {"label":"2+ organ system clusters","value":"2+ clusters","points":1}
          ]},
          {"id":"cv_risk","label":"Cardiovascular Risk Score","max":5,"bands":[
            {"label":"Low (<10% 10-yr CV event)","value":"low","points":5},
            {"label":"Moderate (10-20%)","value":"moderate","points":3},
            {"label":"High (>20%)","value":"high","points":1}
          ]}
        ]
      },
      "documentation": {
        "label": "Documentation Quality", "weight": 15,
        "factors": [
          {"id":"completeness","label":"Report Completeness %","max":8,"bands":[
            {"label":"90%+ parameters filled","value":"90%+","points":8},
            {"label":"75-89% filled","value":"75%","points":6},
            {"label":"50-74% filled","value":"50%","points":4},
            {"label":"<50% filled","value":"<50%","points":2}
          ]},
          {"id":"module_coverage","label":"Module Coverage","max":4,"bands":[
            {"label":"All required modules present","value":"all","points":4},
            {"label":"Most modules present","value":"most","points":3},
            {"label":"Several modules missing","value":"few","points":2}
          ]},
          {"id":"consistency","label":"Consistency & Validity","max":3,"bands":[
            {"label":"No conflicts, all reports current","value":"clean","points":3},
            {"label":"Minor inconsistency","value":"minor","points":2},
            {"label":"Conflicts or expired reports","value":"conflicts","points":0}
          ]}
        ]
      }
    }
  },
  "CAT_2": {
    "_version": "dynamic-v2",
    "thresholds": {"approve": 78, "refer": 62, "decline_below": 46},
    "components": {
      "medical": {
        "label": "Medical Parameters", "weight": 38,
        "factors": [
          {"id":"bmi_bp","label":"MER — BMI + Blood Pressure","max":7,"bands":[{"label":"Normal BMI(18.5-24.9) + Normal BP(<130/85)","value":"both_normal","points":7},{"label":"One borderline (BMI 25-29 or BP 130-139/85-89)","value":"one_borderline","points":4},{"label":"BMI >=30 or BP >=140/90","value":"both_abnormal","points":1}]},
          {"id":"ecg","label":"ECG — Rhythm, ST, LVH","max":4,"bands":[{"label":"Normal sinus rhythm","value":"normal","points":4},{"label":"Minor variation / LVH / BBB","value":"borderline","points":2},{"label":"Ischaemic / Abnormal / LBBB","value":"abnormal","points":0.5}]},
          {"id":"urine_routine","label":"Urine Routine — Protein, Glucose, RBC","max":2,"bands":[{"label":"All negative / Nil","value":"nil","points":2},{"label":"Trace protein or 1+ glucose","value":"trace","points":1},{"label":"Protein 2+ or Glucose 2+","value":"abnormal","points":0.25}]},
          {"id":"cbc","label":"CBC — Hb, WBC, Platelets","max":4,"bands":[{"label":"All normal (Hb>=13.5M/12F, WBC 4k-11k)","value":"normal","points":4},{"label":"Hb 11-13.4 or WBC borderline","value":"one_low","points":2},{"label":"Anaemia Hb<11 or Leukocytosis >15k","value":"abnormal","points":1}]},
          {"id":"esr","label":"ESR — Inflammation Marker","max":2,"bands":[{"label":"Normal M<15 F<20 mm/hr","value":"normal","points":2},{"label":"Mildly elevated 20-40","value":"borderline","points":1},{"label":"Significantly elevated >40","value":"high","points":0.25}]},
          {"id":"hba1c","label":"HbA1C — Glycated Haemoglobin","max":5,"bands":[{"label":"Normal <5.7%","value":"< 5.7","points":5},{"label":"Pre-diabetic 5.7-6.4%","value":"5.7-6.4","points":2.5},{"label":"Diabetic 6.5-7.9%","value":"6.5-7.9","points":1},{"label":"Poorly controlled >=8%","value":">= 8","points":0.25}]},
          {"id":"sgpt","label":"SGPT — Liver Cell Damage (ALT)","max":3,"bands":[{"label":"Normal <40 U/L","value":"normal","points":3},{"label":"Mildly elevated 40-80","value":"mild","points":1.5},{"label":"Elevated >80 U/L","value":"high","points":0.5}]},
          {"id":"serum_creatinine","label":"Serum Creatinine — Kidney Filtration","max":3,"bands":[{"label":"Normal M<1.3 F<1.1 mg/dL","value":"normal","points":3},{"label":"Mildly elevated 1.3-1.7","value":"mild","points":1.5},{"label":"Elevated >1.7 mg/dL","value":"high","points":0.5}]},
          {"id":"total_cholesterol","label":"Total Cholesterol","max":2,"bands":[{"label":"Desirable <200 mg/dL","value":"< 200","points":2},{"label":"Borderline 200-239","value":"200-239","points":1},{"label":"High >=240 mg/dL","value":">= 240","points":0.5}]},
          {"id":"triglyceride","label":"Serum Triglyceride — Lipid Metabolism","max":3,"bands":[{"label":"Normal <150 mg/dL","value":"< 150","points":3},{"label":"Borderline 150-199","value":"150-199","points":1.5},{"label":"High 200-499","value":"200-499","points":0.5},{"label":"Very high >=500","value":">= 500","points":0.1}]},
          {"id":"urine_microalbumin","label":"Urine Microalbumin — Early Nephropathy","max":4,"bands":[{"label":"Normal <30 mg/g Creatinine","value":"< 30","points":4},{"label":"Microalbuminuria 30-300 mg/g","value":"30-300","points":2},{"label":"Macroalbuminuria >300 mg/g","value":"> 300","points":0.5}]}
        ]
      },
      "lifestyle":     {"label":"Lifestyle Risk",        "weight":18,"factors":[{"id":"smoking","label":"Smoking Status","max":7,"bands":[{"label":"Never","value":"never","points":7},{"label":"Former smoker","value":"former","points":4},{"label":"Current smoker","value":"current","points":1}]},{"id":"alcohol","label":"Alcohol Use","max":5,"bands":[{"label":"Never","value":"never","points":5},{"label":"Occasional","value":"occasional","points":4},{"label":"Regular","value":"regular","points":2},{"label":"Heavy","value":"heavy","points":0.5}]},{"id":"tobacco","label":"Tobacco Chewing","max":3,"bands":[{"label":"Never","value":"never","points":3},{"label":"Former","value":"former","points":1.5},{"label":"Current","value":"current","points":0.5}]},{"id":"occupation","label":"Occupation Hazard","max":3,"bands":[{"label":"None","value":"none","points":3},{"label":"Low","value":"low","points":2.5},{"label":"Moderate","value":"moderate","points":1.5},{"label":"High","value":"high","points":0.5}]},{"id":"exercise","label":"Exercise Frequency","max":2,"bands":[{"label":"Daily","value":"daily","points":2},{"label":"Regular (3-4/week)","value":"regular","points":1.5},{"label":"Occasional","value":"occasional","points":1},{"label":"None","value":"none","points":0.5}]}]},
      "history":       {"label":"Medical History",       "weight":15,"factors":[{"id":"pre_existing","label":"Pre-Existing Conditions","max":7,"bands":[{"label":"None declared","value":"none","points":7},{"label":"Controlled (1 condition)","value":"controlled","points":5},{"label":"1-2 active conditions","value":"1-2 active","points":3},{"label":"3+ active conditions","value":"3+ active","points":1}]},{"id":"family_history","label":"Family Medical History","max":4,"bands":[{"label":"None known","value":"none","points":4},{"label":"1 risk (cardiac/DM/Ca)","value":"one_risk","points":3},{"label":"2 risk conditions","value":"two_risks","points":2},{"label":"3+ risk conditions","value":"three_plus","points":1}]},{"id":"hospitalizations","label":"Prior Hospitalizations","max":2,"bands":[{"label":"None","value":"none","points":2},{"label":"1-2 events","value":"1-2","points":1},{"label":"3+ events","value":"3+","points":0.5}]},{"id":"surgical_history","label":"Surgical History","max":2,"bands":[{"label":"None","value":"none","points":2},{"label":"1 surgery (minor)","value":"one_minor","points":1.5},{"label":"2+ or major surgery","value":"two_plus","points":1}]}]},
      "clinical":      {"label":"Clinical Correlation",  "weight":15,"factors":[{"id":"drug_condition","label":"Drug-Condition Matching","max":5,"bands":[{"label":"Consistent","value":"consistent","points":5},{"label":"Minor gap","value":"minor gap","points":2.5},{"label":"Non-disclosure likely","value":"non-disclosure","points":0}]},{"id":"multi_system","label":"Multi-System Findings","max":5,"bands":[{"label":"No multi-system involvement","value":"none","points":5},{"label":"1 organ system cluster","value":"1 cluster","points":3},{"label":"2+ organ system clusters","value":"2+ clusters","points":1}]},{"id":"cv_risk","label":"Cardiovascular Risk Score","max":5,"bands":[{"label":"Low (<10%)","value":"low","points":5},{"label":"Moderate (10-20%)","value":"moderate","points":3},{"label":"High (>20%)","value":"high","points":1}]}]},
      "documentation": {"label":"Documentation Quality", "weight":14,"factors":[{"id":"completeness","label":"Report Completeness %","max":8,"bands":[{"label":"90%+ parameters filled","value":"90%+","points":8},{"label":"75-89% filled","value":"75%","points":6},{"label":"50-74% filled","value":"50%","points":4},{"label":"<50% filled","value":"<50%","points":2}]},{"id":"module_coverage","label":"Module Coverage","max":4,"bands":[{"label":"All required modules present","value":"all","points":4},{"label":"Most modules present","value":"most","points":3},{"label":"Several modules missing","value":"few","points":2}]},{"id":"consistency","label":"Consistency & Validity","max":3,"bands":[{"label":"No conflicts","value":"clean","points":3},{"label":"Minor inconsistency","value":"minor","points":2},{"label":"Conflicts or expired","value":"conflicts","points":0}]}]}
    }
  },
  "CAT_3": {
    "_version": "dynamic-v2",
    "thresholds": {"approve": 75, "refer": 58, "decline_below": 42},
    "components": {
      "medical": {
        "label": "Medical Parameters", "weight": 42,
        "factors": [
          {"id":"bmi_bp","label":"MER — BMI + Blood Pressure","max":7,"bands":[{"label":"Normal BMI(18.5-24.9) + Normal BP(<130/85)","value":"both_normal","points":7},{"label":"One borderline (BMI 25-29 or BP 130-139/85-89)","value":"one_borderline","points":4},{"label":"BMI >=30 or BP >=140/90","value":"both_abnormal","points":1}]},
          {"id":"ecg","label":"ECG — Rhythm, ST, LVH","max":4,"bands":[{"label":"Normal sinus rhythm","value":"normal","points":4},{"label":"Minor variation / LVH / BBB","value":"borderline","points":2},{"label":"Ischaemic / Abnormal / LBBB","value":"abnormal","points":0.5}]},
          {"id":"urine_routine","label":"Urine Routine — Protein, Glucose, RBC","max":2,"bands":[{"label":"All negative / Nil","value":"nil","points":2},{"label":"Trace protein or 1+ glucose","value":"trace","points":1},{"label":"Protein 2+ or Glucose 2+","value":"abnormal","points":0.25}]},
          {"id":"cbc","label":"CBC — Hb, WBC, Platelets","max":4,"bands":[{"label":"All normal (Hb>=13.5M/12F, WBC 4k-11k)","value":"normal","points":4},{"label":"Hb 11-13.4 or WBC borderline","value":"one_low","points":2},{"label":"Anaemia Hb<11 or Leukocytosis >15k","value":"abnormal","points":1}]},
          {"id":"esr","label":"ESR — Inflammation Marker","max":2,"bands":[{"label":"Normal M<15 F<20 mm/hr","value":"normal","points":2},{"label":"Mildly elevated 20-40","value":"borderline","points":1},{"label":"Significantly elevated >40","value":"high","points":0.25}]},
          {"id":"hba1c","label":"HbA1C — Glycated Haemoglobin","max":5,"bands":[{"label":"Normal <5.7%","value":"< 5.7","points":5},{"label":"Pre-diabetic 5.7-6.4%","value":"5.7-6.4","points":2.5},{"label":"Diabetic 6.5-7.9%","value":"6.5-7.9","points":1},{"label":"Poorly controlled >=8%","value":">= 8","points":0.25}]},
          {"id":"urine_microalbumin","label":"Urine Microalbumin — Early Nephropathy","max":4,"bands":[{"label":"Normal <30 mg/g Creatinine","value":"< 30","points":4},{"label":"Microalbuminuria 30-300 mg/g","value":"30-300","points":2},{"label":"Macroalbuminuria >300 mg/g","value":"> 300","points":0.5}]},
          {"id":"lipid_profile","label":"Lipid Profile - LDL + HDL + TC/HDL + TG","max":4,"bands":[{"label":"Optimal - LDL<100 + HDL>60 + TC/HDL<3.5 + TG<150","value":"optimal","points":4},{"label":"Borderline - LDL 100-159 or TC/HDL 3.5-5","value":"borderline","points":2},{"label":"High Risk - LDL>=160 or TC/HDL>5 or TG>=500","value":"high_risk","points":1}]},
          {"id":"lft","label":"LFT — Full Liver Function Tests","max":5,"bands":[{"label":"All normal - SGPT<40 + Bili<1.2 + Albumin>=3.5","value":"normal","points":5},{"label":"One parameter mildly elevated","value":"mild","points":2.5},{"label":"Two+ elevated or Albumin<3.0","value":"abnormal","points":1}]},
          {"id":"kft","label":"KFT — Full Kidney Function Tests","max":5,"bands":[{"label":"All normal - Cr<1.3M + BUN<25 + Uric Acid<7M","value":"normal","points":5},{"label":"One parameter mildly elevated","value":"mild","points":2.5},{"label":"Creatinine>1.7 or BUN>40 mg/dL","value":"high","points":1}]}
        ]
      },
      "lifestyle":     {"label":"Lifestyle Risk",        "weight":15,"factors":[{"id":"smoking","label":"Smoking Status","max":7,"bands":[{"label":"Never","value":"never","points":7},{"label":"Former smoker","value":"former","points":4},{"label":"Current smoker","value":"current","points":1}]},{"id":"alcohol","label":"Alcohol Use","max":5,"bands":[{"label":"Never","value":"never","points":5},{"label":"Occasional","value":"occasional","points":4},{"label":"Regular","value":"regular","points":2},{"label":"Heavy","value":"heavy","points":0.5}]},{"id":"tobacco","label":"Tobacco Chewing","max":3,"bands":[{"label":"Never","value":"never","points":3},{"label":"Former","value":"former","points":1.5},{"label":"Current","value":"current","points":0.5}]},{"id":"occupation","label":"Occupation Hazard","max":3,"bands":[{"label":"None","value":"none","points":3},{"label":"Low","value":"low","points":2.5},{"label":"Moderate","value":"moderate","points":1.5},{"label":"High","value":"high","points":0.5}]},{"id":"exercise","label":"Exercise Frequency","max":2,"bands":[{"label":"Daily","value":"daily","points":2},{"label":"Regular (3-4/week)","value":"regular","points":1.5},{"label":"Occasional","value":"occasional","points":1},{"label":"None","value":"none","points":0.5}]}]},
      "history":       {"label":"Medical History",       "weight":15,"factors":[{"id":"pre_existing","label":"Pre-Existing Conditions","max":7,"bands":[{"label":"None declared","value":"none","points":7},{"label":"Controlled (1 condition)","value":"controlled","points":5},{"label":"1-2 active conditions","value":"1-2 active","points":3},{"label":"3+ active conditions","value":"3+ active","points":1}]},{"id":"family_history","label":"Family Medical History","max":4,"bands":[{"label":"None known","value":"none","points":4},{"label":"1 risk (cardiac/DM/Ca)","value":"one_risk","points":3},{"label":"2 risk conditions","value":"two_risks","points":2},{"label":"3+ risk conditions","value":"three_plus","points":1}]},{"id":"hospitalizations","label":"Prior Hospitalizations","max":2,"bands":[{"label":"None","value":"none","points":2},{"label":"1-2 events","value":"1-2","points":1},{"label":"3+ events","value":"3+","points":0.5}]},{"id":"surgical_history","label":"Surgical History","max":2,"bands":[{"label":"None","value":"none","points":2},{"label":"1 surgery (minor)","value":"one_minor","points":1.5},{"label":"2+ or major surgery","value":"two_plus","points":1}]}]},
      "clinical":      {"label":"Clinical Correlation",  "weight":16,"factors":[{"id":"drug_condition","label":"Drug-Condition Matching","max":5,"bands":[{"label":"Consistent","value":"consistent","points":5},{"label":"Minor gap","value":"minor gap","points":2.5},{"label":"Non-disclosure likely","value":"non-disclosure","points":0}]},{"id":"multi_system","label":"Multi-System Findings","max":5,"bands":[{"label":"No multi-system involvement","value":"none","points":5},{"label":"1 organ system cluster","value":"1 cluster","points":3},{"label":"2+ organ system clusters","value":"2+ clusters","points":1}]},{"id":"cv_risk","label":"Cardiovascular Risk Score","max":6,"bands":[{"label":"Low (<10%)","value":"low","points":6},{"label":"Moderate (10-20%)","value":"moderate","points":3},{"label":"High (>20%)","value":"high","points":1}]}]},
      "documentation": {"label":"Documentation Quality", "weight":12,"factors":[{"id":"completeness","label":"Report Completeness %","max":6,"bands":[{"label":"90%+ parameters filled","value":"90%+","points":6},{"label":"75-89% filled","value":"75%","points":4},{"label":"50-74% filled","value":"50%","points":2},{"label":"<50% filled","value":"<50%","points":1}]},{"id":"module_coverage","label":"Module Coverage","max":4,"bands":[{"label":"All required modules present","value":"all","points":4},{"label":"Most modules present","value":"most","points":3},{"label":"Several modules missing","value":"few","points":2}]},{"id":"consistency","label":"Consistency & Validity","max":2,"bands":[{"label":"No conflicts","value":"clean","points":2},{"label":"Minor inconsistency","value":"minor","points":1},{"label":"Conflicts or expired","value":"conflicts","points":0}]}]}
    }
  },
  "CAT_4": {
    "_version": "dynamic-v2",
    "thresholds": {"approve": 72, "refer": 55, "decline_below": 40},
    "components": {
      "medical": {
        "label": "Medical Parameters", "weight": 45,
        "factors": [
          {"id":"bmi_bp","label":"MER — BMI + Blood Pressure","max":7,"bands":[{"label":"Normal BMI(18.5-24.9) + Normal BP(<130/85)","value":"both_normal","points":7},{"label":"One borderline (BMI 25-29 or BP 130-139/85-89)","value":"one_borderline","points":4},{"label":"BMI >=30 or BP >=140/90","value":"both_abnormal","points":1}]},
          {"id":"ecg","label":"ECG — Rhythm, ST, LVH","max":4,"bands":[{"label":"Normal sinus rhythm","value":"normal","points":4},{"label":"Minor variation / LVH / BBB","value":"borderline","points":2},{"label":"Ischaemic / Abnormal / LBBB","value":"abnormal","points":0.5}]},
          {"id":"urine_routine","label":"Urine Routine — Protein, Glucose, RBC","max":2,"bands":[{"label":"All negative / Nil","value":"nil","points":2},{"label":"Trace protein or 1+ glucose","value":"trace","points":1},{"label":"Protein 2+ or Glucose 2+","value":"abnormal","points":0.25}]},
          {"id":"cbc","label":"CBC — Hb, WBC, Platelets","max":4,"bands":[{"label":"All normal (Hb>=13.5M/12F, WBC 4k-11k)","value":"normal","points":4},{"label":"Hb 11-13.4 or WBC borderline","value":"one_low","points":2},{"label":"Anaemia Hb<11 or Leukocytosis >15k","value":"abnormal","points":1}]},
          {"id":"esr","label":"ESR — Inflammation Marker","max":2,"bands":[{"label":"Normal M<15 F<20 mm/hr","value":"normal","points":2},{"label":"Mildly elevated 20-40","value":"borderline","points":1},{"label":"Significantly elevated >40","value":"high","points":0.25}]},
          {"id":"hba1c","label":"HbA1C — Glycated Haemoglobin","max":5,"bands":[{"label":"Normal <5.7%","value":"< 5.7","points":5},{"label":"Pre-diabetic 5.7-6.4%","value":"5.7-6.4","points":2.5},{"label":"Diabetic 6.5-7.9%","value":"6.5-7.9","points":1},{"label":"Poorly controlled >=8%","value":">= 8","points":0.25}]},
          {"id":"urine_microalbumin","label":"Urine Microalbumin — Early Nephropathy","max":4,"bands":[{"label":"Normal <30 mg/g Creatinine","value":"< 30","points":4},{"label":"Microalbuminuria 30-300 mg/g","value":"30-300","points":2},{"label":"Macroalbuminuria >300 mg/g","value":"> 300","points":0.5}]},
          {"id":"lipid_profile","label":"Lipid Profile - LDL + HDL + TC/HDL + TG","max":4,"bands":[{"label":"Optimal - LDL<100 + HDL>60 + TC/HDL<3.5 + TG<150","value":"optimal","points":4},{"label":"Borderline - LDL 100-159 or TC/HDL 3.5-5","value":"borderline","points":2},{"label":"High Risk - LDL>=160 or TC/HDL>5 or TG>=500","value":"high_risk","points":1}]},
          {"id":"lft","label":"LFT — Full Liver Function Tests","max":5,"bands":[{"label":"All normal - SGPT<40 + Bili<1.2 + Albumin>=3.5","value":"normal","points":5},{"label":"One parameter mildly elevated","value":"mild","points":2.5},{"label":"Two+ elevated or Albumin<3.0","value":"abnormal","points":1}]},
          {"id":"kft","label":"KFT — Full Kidney Function Tests","max":5,"bands":[{"label":"All normal - Cr<1.3M + BUN<25 + Uric Acid<7M","value":"normal","points":5},{"label":"One parameter mildly elevated","value":"mild","points":2.5},{"label":"Creatinine>1.7 or BUN>40 mg/dL","value":"high","points":1}]},
          {"id":"echo_2d","label":"2D Echo — LVEF + Wall Motion","max":5,"bands":[{"label":"LVEF >=55% + Normal wall motion","value":"normal","points":5},{"label":"LVEF 45-54% or mild hypokinesia","value":"mildly_reduced","points":2},{"label":"LVEF <45% or akinetic segment","value":"significantly_reduced","points":0.5}]},
          {"id":"psa_pap","label":"PSA (Male) / PAP Smear (Female)","max":2,"bands":[{"label":"PSA <4 or PAP NILM - Normal","value":"normal","points":2},{"label":"PSA 4-10 or PAP ASCUS/LSIL","value":"borderline","points":1},{"label":"PSA >10 or PAP HSIL","value":"high_risk","points":0.1}]}
        ]
      },
      "lifestyle":     {"label":"Lifestyle Risk",        "weight":12,"factors":[{"id":"smoking","label":"Smoking Status","max":7,"bands":[{"label":"Never","value":"never","points":7},{"label":"Former smoker","value":"former","points":4},{"label":"Current smoker","value":"current","points":1}]},{"id":"alcohol","label":"Alcohol Use","max":5,"bands":[{"label":"Never","value":"never","points":5},{"label":"Occasional","value":"occasional","points":4},{"label":"Regular","value":"regular","points":2},{"label":"Heavy","value":"heavy","points":0.5}]},{"id":"tobacco","label":"Tobacco Chewing","max":3,"bands":[{"label":"Never","value":"never","points":3},{"label":"Former","value":"former","points":1.5},{"label":"Current","value":"current","points":0.5}]},{"id":"occupation","label":"Occupation Hazard","max":3,"bands":[{"label":"None","value":"none","points":3},{"label":"Low","value":"low","points":2.5},{"label":"Moderate","value":"moderate","points":1.5},{"label":"High","value":"high","points":0.5}]},{"id":"exercise","label":"Exercise Frequency","max":2,"bands":[{"label":"Daily","value":"daily","points":2},{"label":"Regular (3-4/week)","value":"regular","points":1.5},{"label":"Occasional","value":"occasional","points":1},{"label":"None","value":"none","points":0.5}]}]},
      "history":       {"label":"Medical History",       "weight":15,"factors":[{"id":"pre_existing","label":"Pre-Existing Conditions","max":7,"bands":[{"label":"None declared","value":"none","points":7},{"label":"Controlled (1 condition)","value":"controlled","points":5},{"label":"1-2 active conditions","value":"1-2 active","points":3},{"label":"3+ active conditions","value":"3+ active","points":1}]},{"id":"family_history","label":"Family Medical History","max":4,"bands":[{"label":"None known","value":"none","points":4},{"label":"1 risk (cardiac/DM/Ca)","value":"one_risk","points":3},{"label":"2 risk conditions","value":"two_risks","points":2},{"label":"3+ risk conditions","value":"three_plus","points":1}]},{"id":"hospitalizations","label":"Prior Hospitalizations","max":2,"bands":[{"label":"None","value":"none","points":2},{"label":"1-2 events","value":"1-2","points":1},{"label":"3+ events","value":"3+","points":0.5}]},{"id":"surgical_history","label":"Surgical History","max":2,"bands":[{"label":"None","value":"none","points":2},{"label":"1 surgery (minor)","value":"one_minor","points":1.5},{"label":"2+ or major surgery","value":"two_plus","points":1}]}]},
      "clinical":      {"label":"Clinical Correlation",  "weight":16,"factors":[{"id":"drug_condition","label":"Drug-Condition Matching","max":5,"bands":[{"label":"Consistent","value":"consistent","points":5},{"label":"Minor gap","value":"minor gap","points":2.5},{"label":"Non-disclosure likely","value":"non-disclosure","points":0}]},{"id":"multi_system","label":"Multi-System Findings","max":5,"bands":[{"label":"No multi-system involvement","value":"none","points":5},{"label":"1 organ system cluster","value":"1 cluster","points":3},{"label":"2+ organ system clusters","value":"2+ clusters","points":1}]},{"id":"cv_risk","label":"Cardiovascular Risk Score","max":6,"bands":[{"label":"Low (<10%)","value":"low","points":6},{"label":"Moderate (10-20%)","value":"moderate","points":3},{"label":"High (>20%)","value":"high","points":1}]}]},
      "documentation": {"label":"Documentation Quality", "weight":12,"factors":[{"id":"completeness","label":"Report Completeness %","max":6,"bands":[{"label":"90%+ parameters filled","value":"90%+","points":6},{"label":"75-89% filled","value":"75%","points":4},{"label":"50-74% filled","value":"50%","points":2},{"label":"<50% filled","value":"<50%","points":1}]},{"id":"module_coverage","label":"Module Coverage","max":4,"bands":[{"label":"All required modules present","value":"all","points":4},{"label":"Most modules present","value":"most","points":3},{"label":"Several modules missing","value":"few","points":2}]},{"id":"consistency","label":"Consistency & Validity","max":2,"bands":[{"label":"No conflicts","value":"clean","points":2},{"label":"Minor inconsistency","value":"minor","points":1},{"label":"Conflicts or expired","value":"conflicts","points":0}]}]}
    }
  },
  "tele_mer": {
    "_version": "dynamic-v2",
    "thresholds": {"approve": 85, "refer": 65, "decline_below": 50},
    "components": {
      "medical":       {"label":"Medical Parameters",   "weight":0,  "factors":[]},
      "lifestyle":     {"label":"Lifestyle Risk",        "weight":35, "factors":[{"id":"smoking","label":"Smoking Status","max":7,"bands":[{"label":"Never","value":"never","points":7},{"label":"Former smoker","value":"former","points":4},{"label":"Current smoker","value":"current","points":1}]},{"id":"alcohol","label":"Alcohol Use","max":5,"bands":[{"label":"Never","value":"never","points":5},{"label":"Occasional","value":"occasional","points":4},{"label":"Regular","value":"regular","points":2},{"label":"Heavy","value":"heavy","points":0.5}]},{"id":"tobacco","label":"Tobacco Chewing","max":3,"bands":[{"label":"Never","value":"never","points":3},{"label":"Former","value":"former","points":1.5},{"label":"Current","value":"current","points":0.5}]},{"id":"occupation","label":"Occupation Hazard","max":5,"bands":[{"label":"None","value":"none","points":5},{"label":"Low","value":"low","points":4},{"label":"Moderate","value":"moderate","points":2},{"label":"High","value":"high","points":0.5}]},{"id":"exercise","label":"Exercise Frequency","max":5,"bands":[{"label":"Daily","value":"daily","points":5},{"label":"Regular (3-4/week)","value":"regular","points":4},{"label":"Occasional","value":"occasional","points":2},{"label":"None","value":"none","points":0.5}]}]},
      "history":       {"label":"Medical History",       "weight":30, "factors":[{"id":"pre_existing","label":"Pre-Existing Conditions","max":12,"bands":[{"label":"None declared","value":"none","points":12},{"label":"Controlled (1 condition)","value":"controlled","points":9},{"label":"1-2 active conditions","value":"1-2 active","points":5},{"label":"3+ active conditions","value":"3+ active","points":2}]},{"id":"family_history","label":"Family Medical History","max":10,"bands":[{"label":"None known","value":"none","points":10},{"label":"1 risk (cardiac/DM/Ca)","value":"one_risk","points":7},{"label":"2 risk conditions","value":"two_risks","points":4},{"label":"3+ risk conditions","value":"three_plus","points":2}]},{"id":"hospitalizations","label":"Prior Hospitalizations","max":8,"bands":[{"label":"None","value":"none","points":8},{"label":"1-2 events","value":"1-2","points":5},{"label":"3+ events","value":"3+","points":2}]}]},
      "clinical":      {"label":"Clinical Correlation",  "weight":25, "factors":[{"id":"drug_condition","label":"Drug-Condition Matching","max":15,"bands":[{"label":"Consistent — meds match declared PED","value":"consistent","points":15},{"label":"Minor gap — partial disclosure","value":"minor gap","points":8},{"label":"Non-disclosure likely","value":"non-disclosure","points":0}]},{"id":"cv_risk","label":"Cardiovascular Risk Score","max":10,"bands":[{"label":"Low (<10% 10-yr CV event)","value":"low","points":10},{"label":"Moderate (10-20%)","value":"moderate","points":6},{"label":"High (>20%)","value":"high","points":2}]}]},
      "documentation": {"label":"Documentation Quality", "weight":10, "factors":[{"id":"completeness","label":"Interview Completeness","max":10,"bands":[{"label":"All questions answered","value":"complete","points":10},{"label":"Most questions answered","value":"most","points":7},{"label":"Several questions skipped","value":"incomplete","points":3}]}]}
    }
  }
}'::jsonb);