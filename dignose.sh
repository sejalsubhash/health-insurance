#!/bin/bash
###############################################################################
# SBI UW — Upload & Extraction Diagnostic Script
# Run: bash diagnose.sh
###############################################################################
echo "============================================="
echo " SBI UW — Upload & Extraction Diagnosis"
echo " $(date)"
echo "============================================="

echo ""
echo "--- 1. Container Status ---"
sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "--- 2. Upload Limit (Multer in server.js) ---"
sudo docker exec sbi-backend grep "fileSize" /app/server.js | head -3

echo ""
echo "--- 3. Nginx Body Size & Timeout ---"
sudo docker exec sbi-frontend nginx -T 2>/dev/null | grep -E "client_max_body|proxy_read_timeout|proxy_send_timeout"

echo ""
echo "--- 4. Size Check Fix (base64SizeMB) ---"
sudo docker exec sbi-backend grep "base64SizeMB\|too large\|FILE TOO LARGE" /app/server.js | head -5

echo ""
echo "--- 5. Bedrock Endpoint Reachable ---"
sudo docker exec sbi-backend node -e "
const https = require('https');
const req = https.request({
  hostname: 'bedrock-runtime.ap-south-1.amazonaws.com',
  port: 443,
  path: '/',
  method: 'GET',
  timeout: 5000
}, r => console.log('Bedrock reachable: HTTP', r.statusCode));
req.on('error', e => console.log('Bedrock ERROR:', e.message));
req.on('timeout', () => console.log('Bedrock TIMEOUT — VPC endpoint SG may be blocking port 443'));
req.end();
" 2>/dev/null

echo ""
echo "--- 6. Recent Extraction Errors ---"
sudo docker logs sbi-backend 2>&1 | grep -E "extract|Extract|Claude|Error|error|timeout|Bedrock|large|size" | tail -10

echo ""
echo "--- 7. Redis Queue Status ---"
sudo docker exec sbi-redis redis-cli llen "bull:insurance-uw:wait" 2>/dev/null || echo "Queue check skipped"
sudo docker exec sbi-redis redis-cli llen "bull:insurance-uw:failed" 2>/dev/null || echo "Failed queue check skipped"

echo ""
echo "--- 8. Memory Usage ---"
sudo docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"

echo ""
echo "============================================="
echo " Diagnosis Complete"
echo "============================================="