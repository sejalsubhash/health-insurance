/**
 * Bedrock Cross-Account Connectivity Test
 * Equivalent to bedrock-test.py — Node.js version
 *
 * Usage:
 *   sudo docker cp bedrock-test.js sbi-backend:/app/bedrock-test.js
 *   sudo docker exec sbi-backend node /app/bedrock-test.js
 */

require('dotenv').config();

const { STSClient, AssumeRoleCommand }                      = require('@aws-sdk/client-sts');
const { BedrockRuntimeClient, InvokeModelCommand,
        ConverseCommand }                                    = require('@aws-sdk/client-bedrock-runtime');

// ── Config — reads from .env same as server.js ────────────────────────────────
const ROLE_ARN             = process.env.BEDROCK_CROSS_ACCOUNT_ROLE_ARN
                           || 'arn:aws:iam::916292310858:role/poc-health-claims-acc-cross-account-role';

const INFERENCE_PROFILE_ARN = process.env.BEDROCK_INFERENCE_PROFILE
                            || 'arn:aws:bedrock:ap-south-1:916292310858:application-inference-profile/9d6evt7kqmq0';

const REGION               = process.env.BEDROCK_REGION || 'ap-south-1';

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('================================================');
  console.log('  Bedrock Cross-Account Connectivity Test');
  console.log('  ' + new Date().toLocaleString('en-IN'));
  console.log('================================================');
  console.log('');
  console.log('Config:');
  console.log('  ROLE_ARN             :', ROLE_ARN);
  console.log('  INFERENCE_PROFILE_ARN:', INFERENCE_PROFILE_ARN);
  console.log('  REGION               :', REGION);
  console.log('');

  // ── Step 1: STS AssumeRole ─────────────────────────────────────────────────
  console.log('--- Step 1: STS AssumeRole ---');
  let credentials;
  try {
    const sts = new STSClient({ region: REGION });
    const res = await sts.send(new AssumeRoleCommand({
      RoleArn:         ROLE_ARN,
      RoleSessionName: 'BedrockCrossAccountSession',
      DurationSeconds: 900
    }));
    credentials = res.Credentials;
    console.log('✅ AssumeRole SUCCESS');
    console.log('   AccessKeyId  :', credentials.AccessKeyId.substring(0, 8) + '...');
    console.log('   SessionToken :', credentials.SessionToken.substring(0, 20) + '...');
    console.log('   Expiration   :', credentials.Expiration);
  } catch (e) {
    console.log('❌ AssumeRole FAILED');
    console.log('   Error name   :', e.name);
    console.log('   Error message:', e.message);
    console.log('   HTTP status  :', e.$metadata?.httpStatusCode);
    console.log('   Request ID   :', e.$metadata?.requestId);
    console.log('');
    if (e.name === 'AccessDenied')
      console.log('   FIX: EC2 instance role lacks sts:AssumeRole on', ROLE_ARN);
    if (e.name === 'NoSuchEntity')
      console.log('   FIX: Role ARN does not exist — check BEDROCK_CROSS_ACCOUNT_ROLE_ARN');
    if (e.name === 'CredentialsProviderError' || e.message?.includes('Could not load'))
      console.log('   FIX: EC2 instance has no IAM role attached');
    process.exit(1);
  }

  // ── Step 2: Create Bedrock Client with assumed credentials ─────────────────
  console.log('');
  console.log('--- Step 2: Create Bedrock Client ---');
  const bedrockClient = new BedrockRuntimeClient({
    region: REGION,
    credentials: {
      accessKeyId:     credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken:    credentials.SessionToken
    }
  });
  console.log('✅ BedrockRuntimeClient created');
  console.log('   Region:', REGION);

  // ── Step 3: Test with Converse API (same as Python bedrock_runtime.converse) ─
  console.log('');
  console.log('--- Step 3: Bedrock Converse API Test ---');
  try {
    const start = Date.now();
    const res = await bedrockClient.send(new ConverseCommand({
      modelId: INFERENCE_PROFILE_ARN,
      messages: [
        {
          role: 'user',
          content: [{ text: 'Explain AWS Bedrock cross-account access in simple terms.' }]
        }
      ],
      inferenceConfig: {
        maxTokens:   1000,
        temperature: 0.5,
        topP:        0.9
      }
    }));
    const elapsed = Date.now() - start;
    const text = res.output?.message?.content?.[0]?.text || '';
    console.log('✅ Converse API SUCCESS (' + elapsed + 'ms)');
    console.log('   Stop reason  :', res.stopReason);
    console.log('   Input tokens :', res.usage?.inputTokens);
    console.log('   Output tokens:', res.usage?.outputTokens);
    console.log('');
    console.log('   Response (first 300 chars):');
    console.log('   ' + text.substring(0, 300).replace(/\n/g, '\n   '));
  } catch (e) {
    console.log('❌ Converse API FAILED');
    console.log('   Error name   :', e.name);
    console.log('   Error message:', e.message);
    console.log('   HTTP status  :', e.$metadata?.httpStatusCode);
    console.log('   Request ID   :', e.$metadata?.requestId);
    console.log('');
    if (e.name === 'AccessDeniedException')
      console.log('   FIX: Assumed role lacks bedrock:InvokeModel on inference profile ARN');
    if (e.name === 'ResourceNotFoundException')
      console.log('   FIX: Inference profile ARN not found — check BEDROCK_INFERENCE_PROFILE value');
    if (e.name === 'ValidationException')
      console.log('   FIX: Model ID or inference profile format invalid');
    if (e.name === 'ThrottlingException')
      console.log('   FIX: Bedrock rate limit hit — wait and retry');
    if (e.message?.includes('inference profile'))
      console.log('   FIX: Profile may not be shared to this account — check cross-account profile sharing in Bedrock console');
    process.exit(1);
  }

  // ── Step 4: Test with InvokeModel API (what server.js uses) ───────────────
  console.log('');
  console.log('--- Step 4: Bedrock InvokeModel API Test (used by server.js) ---');
  try {
    const start = Date.now();
    const res = await bedrockClient.send(new InvokeModelCommand({
      modelId:     INFERENCE_PROFILE_ARN,
      contentType: 'application/json',
      accept:      'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens:        100,
        messages: [{ role: 'user', content: 'Reply with exactly: INVOKE_OK' }]
      })
    }));
    const elapsed = Date.now() - start;
    const out  = JSON.parse(Buffer.from(res.body).toString('utf8'));
    const text = out.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    console.log('✅ InvokeModel API SUCCESS (' + elapsed + 'ms)');
    console.log('   Response:', text.trim());
    console.log('   Input tokens :', out.usage?.input_tokens);
    console.log('   Output tokens:', out.usage?.output_tokens);
  } catch (e) {
    console.log('❌ InvokeModel API FAILED');
    console.log('   Error name   :', e.name);
    console.log('   Error message:', e.message);
    console.log('   HTTP status  :', e.$metadata?.httpStatusCode);
    console.log('   Request ID   :', e.$metadata?.requestId);
    console.log('');
    if (e.name === 'AccessDeniedException')
      console.log('   FIX: Role lacks bedrock:InvokeModel permission');
    if (e.name === 'ResourceNotFoundException')
      console.log('   FIX: Inference profile ARN not found in this region');
    process.exit(1);
  }

  // ── All tests passed ───────────────────────────────────────────────────────
  console.log('');
  console.log('================================================');
  console.log('  ✅ ALL TESTS PASSED — Bedrock is working');
  console.log('================================================');
  console.log('');
}

run().catch(e => {
  console.error('Unexpected error:', e.message);
  process.exit(1);
});