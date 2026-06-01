#!/bin/bash
###############################################################################
# SBI Health Insurance UW Agent — Prerequisites Setup
# OS: Amazon Linux 2023
# Run: bash setup.sh
# What this does:
#   1. Install required packages (Docker, Docker Compose, PostgreSQL client)
#   2. Configure Docker
#   3. ECR login
#   4. Create PostgreSQL schema (tables)
###############################################################################
set -euo pipefail

LOG_FILE="/var/log/sbi-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "============================================="
echo " SBI UW Setup Started: $(date)"
echo "============================================="

# ─── EDIT THESE BEFORE RUNNING ────────────────────────────────────────────────
AWS_REGION="ap-south-1"
ECR_ACCOUNT_ID="412024807377"        
DB_USER="sbi_app"
DB_NAME="sbi_uw"
# ──────────────────────────────────────────────────────────────────────────────

# Auto-detect account ID if not set
if [ -z "$ECR_ACCOUNT_ID" ]; then
  ECR_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  echo "Detected AWS Account ID: $ECR_ACCOUNT_ID"
fi

ECR_REGISTRY="${ECR_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# ─── Step 1: Install packages ─────────────────────────────────────────────────
echo ""
echo "--- Step 1: Installing packages ---"
sudo dnf update -y
sudo dnf install -y docker aws-cli curl wget jq openssl postgresql15
echo "Packages installed"

# ─── Step 2: Configure Docker ─────────────────────────────────────────────────
echo ""
echo "--- Step 2: Configuring Docker ---"
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user
echo "Docker started — ec2-user added to docker group"
echo "NOTE: Log out and back in for docker group to take effect"

# ─── Step 3: Install Docker Compose ──────────────────────────────────────────
echo ""
echo "--- Step 3: Installing Docker Compose ---"
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL \
  "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
sudo docker compose version
echo "Docker Compose installed"

# ─── Step 4: ECR login ────────────────────────────────────────────────────────
echo ""
echo "--- Step 4: ECR login ---"
aws ecr get-login-password --region "$AWS_REGION" | \
  sudo docker login --username AWS --password-stdin "$ECR_REGISTRY"
echo "ECR login successful: $ECR_REGISTRY"

# ─── Step 5: Create PostgreSQL schema ────────────────────────────────────────
echo ""
echo "--- Step 5: Creating PostgreSQL schema ---"
echo "Waiting for sbi-postgres container to be ready..."

for i in $(seq 1 12); do
  if sudo docker exec sbi-postgres pg_isready -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
    echo "PostgreSQL is ready"
    break
  fi
  echo "Attempt $i/12 — waiting 5s..."
  sleep 5
done

sudo docker exec sbi-postgres psql -U "$DB_USER" -d "$DB_NAME" << 'SQLEOF'
CREATE TABLE IF NOT EXISTS workflows (
  id           TEXT PRIMARY KEY,
  proposal_id  TEXT UNIQUE,
  state        TEXT NOT NULL DEFAULT 'created',
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflows_state   ON workflows(state);
CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at DESC);

CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL,
  name         TEXT,
  category     TEXT,
  s3_key       TEXT,
  content_type TEXT,
  size_bytes   INTEGER,
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_workflow ON documents(workflow_id);

CREATE TABLE IF NOT EXISTS analysis_results (
  id             SERIAL PRIMARY KEY,
  workflow_id    TEXT NOT NULL,
  ai_analysis    JSONB,
  extracted_data JSONB,
  decision       JSONB,
  risk_score     JSONB,
  analyzed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analysis_workflow ON analysis_results(workflow_id);

CREATE TABLE IF NOT EXISTS biometrics (
  id          SERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  type        TEXT,
  s3_key      TEXT,
  score       NUMERIC,
  status      TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_biometrics_workflow ON biometrics(workflow_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  workflow_id TEXT,
  action      TEXT,
  actor       TEXT,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_workflow ON audit_log(workflow_id);
SQLEOF

echo ""
echo "--- Verifying tables ---"
sudo docker exec sbi-postgres psql -U "$DB_USER" -d "$DB_NAME" -c "\dt"

echo ""
echo "============================================="
echo " Setup Complete: $(date)"
echo " Log: $LOG_FILE"
echo "============================================="