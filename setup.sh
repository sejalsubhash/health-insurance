#!/bin/bash
###############################################################################
# SBI Health Insurance UW Agent — Prerequisites Setup
# OS: RHEL 9 / Red Hat Enterprise Linux 9
# Run: bash setup.sh
# What this does:
#   1. Install required packages
#   2. Install AWS CLI v2
#   3. Install PostgreSQL 15 client
#   4. Install Docker + Docker Compose
#   5. ECR login
#   6. Create PostgreSQL schema (tables)
###############################################################################
set -euo pipefail

LOG_FILE="/var/log/sbi-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "============================================="
echo " SBI UW Setup Started: $(date)"
echo "============================================="

# ─── EDIT THESE BEFORE RUNNING ────────────────────────────────────────────────
AWS_REGION="ap-south-1"
ECR_ACCOUNT_ID="412024807377"        # e.g. 850092039328 — leave blank to auto-detect
DB_USER="sbi_app"
DB_NAME="sbi_uw"
APP_USER=$(whoami)       # auto-detects current user (HealthUWAIAdmin)
# ──────────────────────────────────────────────────────────────────────────────

echo "Running as user: $APP_USER"

# ─── Step 1: Install base packages ───────────────────────────────────────────
echo ""
echo "--- Step 1: Installing base packages ---"
sudo dnf install -y curl wget jq openssl unzip tar
echo "Base packages installed"

# ─── Step 2: Install AWS CLI v2 ──────────────────────────────────────────────
echo ""
echo "--- Step 2: Installing AWS CLI v2 ---"
if command -v aws &>/dev/null; then
  echo "AWS CLI already installed: $(aws --version)"
else
  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" \
    -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp/
  sudo /tmp/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/aws
  echo "AWS CLI installed: $(aws --version)"
fi

# ─── Step 3: Install PostgreSQL 15 client ────────────────────────────────────
echo ""
echo "--- Step 3: Installing PostgreSQL 15 client ---"
if command -v psql &>/dev/null; then
  echo "psql already installed: $(psql --version)"
else
  sudo dnf install -y \
    https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm \
    2>/dev/null || true
  sudo dnf -qy module disable postgresql 2>/dev/null || true
  sudo dnf install -y postgresql15
  echo "PostgreSQL client installed: $(psql --version)"
fi

# ─── Step 4: Install Docker ───────────────────────────────────────────────────
echo ""
echo "--- Step 4: Installing Docker ---"
if command -v docker &>/dev/null; then
  echo "Docker already installed: $(docker --version)"
else
  # RHEL 9 — use podman-docker or install Docker CE via repo
  sudo dnf install -y yum-utils
  sudo yum-config-manager --add-repo \
    https://download.docker.com/linux/rhel/docker-ce.repo 2>/dev/null || \
  sudo yum-config-manager --add-repo \
    https://download.docker.com/linux/centos/docker-ce.repo
  sudo dnf install -y docker-ce docker-ce-cli containerd.io
  echo "Docker installed: $(docker --version)"
fi

sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker "$APP_USER"
echo "Docker started — $APP_USER added to docker group"

# ─── Step 5: Install Docker Compose ──────────────────────────────────────────
echo ""
echo "--- Step 5: Installing Docker Compose ---"
if sudo docker compose version &>/dev/null; then
  echo "Docker Compose already installed: $(sudo docker compose version)"
else
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -SL \
    "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  echo "Docker Compose installed: $(sudo docker compose version)"
fi

# ─── Step 6: ECR login ────────────────────────────────────────────────────────
echo ""
echo "--- Step 6: ECR login ---"

if [ -z "$ECR_ACCOUNT_ID" ]; then
  ECR_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  echo "Detected AWS Account ID: $ECR_ACCOUNT_ID"
fi

ECR_REGISTRY="${ECR_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

for i in 1 2 3; do
  if aws ecr get-login-password --region "$AWS_REGION" | \
    sudo docker login --username AWS --password-stdin "$ECR_REGISTRY"; then
    echo "ECR login successful: $ECR_REGISTRY"
    break
  fi
  echo "ECR login attempt $i failed — retrying in 10s..."
  sleep 10
done

# ─── Step 7: Create PostgreSQL schema ────────────────────────────────────────
echo ""
echo "--- Step 7: Creating PostgreSQL schema ---"
echo "Waiting for sbi-postgres container to be ready..."

READY=false
for i in $(seq 1 12); do
  if sudo docker exec sbi-postgres pg_isready \
      -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
    echo "PostgreSQL is ready"
    READY=true
    break
  fi
  echo "Attempt $i/12 — waiting 5s..."
  sleep 5
done

if [ "$READY" = false ]; then
  echo "WARNING: sbi-postgres not ready — start containers first then re-run step 7"
  echo "Run: docker compose up -d"
  echo "Then re-run: bash setup.sh"
  exit 1
fi

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