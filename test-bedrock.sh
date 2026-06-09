#!/bin/bash
# Bedrock Connection Test Script
# Usage: bash test-bedrock.sh

echo ""
echo "=============================="
echo "   BEDROCK CONNECTION TEST"
echo "=============================="
echo ""

# Step 1 — Copy test script into container and run it
echo "--- Copying test script into container ---"
sudo docker cp /home/HealthUWAIAdmin/health-insurance/backend/test-bedrock.js sbi-backend:/app/test-bedrock.js

echo "--- Running test inside container ---"
echo ""
sudo docker exec sbi-backend node /app/test-bedrock.js

echo ""
echo "--- Saving result to file ---"
sudo docker exec sbi-backend node /app/test-bedrock.js > /home/HealthUWAIAdmin/bedrock-test-result.txt 2>&1
echo "Result saved to: /home/HealthUWAIAdmin/bedrock-test-result.txt"
echo ""
cat /home/HealthUWAIAdmin/bedrock-test-result.txt
