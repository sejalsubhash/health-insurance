#!/bin/bash
# ── SBI UW — Database Content Check ─────────────────────────────────────────
echo ""
echo "================================================"
echo "  SBI UW — Database Content Check"
echo "  $(date)"
echo "================================================"
echo ""

# ── 1. Check PostgreSQL is running ───────────────────────────────────────────
echo "--- 1. PostgreSQL Container Status ---"
sudo docker ps --format "table {{.Names}}\t{{.Status}}" | grep postgres

# ── 2. List all tables ────────────────────────────────────────────────────────
echo ""
echo "--- 2. Tables in Database ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "\dt" 2>&1

# ── 3. Workflows count and latest 5 ──────────────────────────────────────────
echo ""
echo "--- 3. Workflows Table ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "
SELECT COUNT(*) AS total_workflows FROM workflows;
" 2>&1

echo ""
echo "--- 4. Latest 5 Workflows ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "
SELECT
  id,
  data->>'proposal_id'   AS proposal_id,
  data->>'state'         AS state,
  data->>'cat_level'     AS cat_level,
  data->>'proposer_name' AS name,
  data->>'assigned_vendor_id' AS vendor,
  LEFT(data->>'extraction_method', 20) AS extraction,
  updated_at
FROM workflows
ORDER BY updated_at DESC
LIMIT 5;
" 2>&1

# ── 5. Check extracted_data for latest workflow ───────────────────────────────
echo ""
echo "--- 5. Extracted Data — Latest Workflow ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "
SELECT
  data->>'proposal_id' AS proposal_id,
  data->'extracted_data'->'blood_chemistry'->>'hba1c'            AS hba1c,
  data->'extracted_data'->'blood_chemistry'->>'sgpt_alt'         AS sgpt,
  data->'extracted_data'->'blood_chemistry'->>'serum_creatinine' AS creatinine,
  data->'extracted_data'->'blood_chemistry'->>'total_cholesterol' AS cholesterol,
  data->'extracted_data'->'hematology'->>'hemoglobin'            AS hemoglobin,
  data->'extracted_data'->'hematology'->>'esr'                   AS esr,
  data->'extracted_data'->'physical_exam'->>'bmi'                AS bmi
FROM workflows
ORDER BY updated_at DESC
LIMIT 3;
" 2>&1

# ── 6. Config table — what keys are stored ────────────────────────────────────
echo ""
echo "--- 6. Config Table ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "
SELECT
  key,
  LENGTH(data::text) AS data_size_bytes,
  updated_at
FROM config
ORDER BY updated_at DESC;
" 2>&1

# ── 7. Cat scoring config exists ─────────────────────────────────────────────
echo ""
echo "--- 7. CAT Scoring Config Check ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "
SELECT
  key,
  data->'CAT_1'->>'_version'    AS cat1_version,
  data->'tele_mer'->>'_version' AS telemer_version,
  jsonb_object_keys(data)       AS cat_keys
FROM config
WHERE key = 'cat-scoring';
" 2>&1

# ── 8. ICMR analysis stored ──────────────────────────────────────────────────
echo ""
echo "--- 8. ICMR Analysis Check (latest 3 workflows) ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "
SELECT
  data->>'proposal_id'                                      AS proposal_id,
  data->'icmr_analysis'->>'overall_clinical_risk'           AS icmr_risk,
  data->'icmr_analysis'->>'score_adjustment'                AS icmr_adj,
  jsonb_array_length(COALESCE(data->'icmr_analysis'->'icmr_findings', '[]'::jsonb)) AS icmr_findings_count
FROM workflows
WHERE data->'icmr_analysis' IS NOT NULL
ORDER BY updated_at DESC
LIMIT 3;
" 2>&1

# ── 9. Database size ──────────────────────────────────────────────────────────
echo ""
echo "--- 9. Database Size ---"
sudo docker exec sbi-postgres psql -U sbi_app -d sbi_uw -c "
SELECT
  pg_size_pretty(pg_database_size('sbi_uw')) AS total_db_size,
  pg_size_pretty(pg_total_relation_size('workflows')) AS workflows_table_size,
  pg_size_pretty(pg_total_relation_size('config')) AS config_table_size;
" 2>&1

echo ""
echo "================================================"
echo "  Check Complete"
echo "================================================"