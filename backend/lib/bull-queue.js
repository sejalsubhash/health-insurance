/**
 * BullMQ Worker — Async document processing pipeline
 * Processes uploaded documents through extraction → correlation → risk scoring
 */
const { Worker, Queue } = require('bullmq');
const IORedis = require('ioredis');
const extractor = require('./claude-extractor');
const riskEngine = require('./medical-risk-engine');
const telemerModel = require('./telemer-score');
const s3Client = require('./s3-client');

let connection;
let worker;
let queue;
let socketManager;

function getConnection() {
  if (!connection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
    });
  }
  return connection;
}

function getQueue() {
  if (!queue) {
    queue = new Queue('insurance-uw', { connection: getConnection() });
  }
  return queue;
}

function setSocketManager(sm) {
  socketManager = sm;
}

function emitProgress(assessmentId, data) {
  if (socketManager) {
    socketManager.emitToAssessment(assessmentId, 'processing_progress', data);
  }
}

async function processAssessment(job) {
  const { assessmentId, module: moduleType, documents } = job.data;
  const startTime = Date.now();

  try {
    // Load current assessment
    const assessment = await s3Client.getAssessment(assessmentId);
    if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

    assessment.status = 'processing';
    assessment.processing_started_at = new Date().toISOString();
    assessment.processing_log = [];
    await s3Client.saveAssessment(assessmentId, assessment);

    emitProgress(assessmentId, { stage: 'started', module: moduleType, message: 'Processing started' });

    let extractedData = {};
    let correlationData = {};
    let riskResult = {};

    switch (moduleType) {
      case 'biometric':
        extractedData = await processBiometricModule(assessmentId, documents, assessment);
        riskResult = riskEngine.calculateBiometricRisk(extractedData.biometric);
        break;

      case 'telemer':
        extractedData = await processTeleMERModule(assessmentId, documents, assessment);
        // New 5-parameter, remarks-driven model. Map extractor output → model input → frontend shape.
        {
          const modelInput = telemerModel.fromExtractorData(extractedData.telemer_data, {
            bmi: extractedData.telemer_data?.proposer_info?.bmi || 0
          });
          riskResult = telemerModel.toFrontendShape(telemerModel.scoreTeleMER(modelInput));
        }
        break;

      case 'pphc':
        extractedData = await processPPHCModule(assessmentId, documents, assessment);
        // Clinical correlation
        emitProgress(assessmentId, { stage: 'clinical_correlation', message: 'Running clinical correlation analysis...' });
        const corrResult = await extractor.performClinicalCorrelation(extractedData);
        correlationData = corrResult.data;
        logApiCall(assessment, 'clinical_correlation', corrResult);
        // Full risk scoring
        riskResult = riskEngine.calculateAll(extractedData, correlationData);
        break;

      case 'historical':
        extractedData = await processHistoricalModule(assessmentId, documents, assessment);
        break;

      default:
        throw new Error(`Unknown module type: ${moduleType}`);
    }

    // Save final results
    assessment.extracted_data = extractedData;
    assessment.correlation_data = correlationData;
    assessment.risk_score = riskResult.risk_score || riskResult;
    assessment.decision = riskResult.decision || { recommendation: 'refer', rationale: 'Manual review required' };
    assessment.guidelines_compliance = riskResult.guidelines_compliance || {};
    assessment.status = 'completed';
    assessment.processing_completed_at = new Date().toISOString();
    assessment.processing_duration_ms = Date.now() - startTime;

    await s3Client.saveAssessment(assessmentId, assessment);

    emitProgress(assessmentId, {
      stage: 'completed',
      message: 'Processing complete',
      risk_score: assessment.risk_score,
      decision: assessment.decision
    });

    return { success: true, assessmentId, duration: Date.now() - startTime };
  } catch (err) {
    console.error(`Processing error for ${assessmentId}:`, err);
    const assessment = await s3Client.getAssessment(assessmentId);
    if (assessment) {
      assessment.status = 'error';
      assessment.error = err.message;
      await s3Client.saveAssessment(assessmentId, assessment);
    }
    emitProgress(assessmentId, { stage: 'error', message: err.message });
    throw err;
  }
}

// ─── Module Processing Functions ───

async function processBiometricModule(assessmentId, documents, assessment) {
  const extractedData = { biometric: {} };

  for (const doc of documents) {
    if (doc.type === 'biometric_report') {
      emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Liveness Agent' });
      const result = await extractor.extractBiometricData(doc.text);
      extractedData.biometric = result.data;
      logApiCall(assessment, 'biometric_extraction', result);
    }
  }

  return extractedData;
}

async function processTeleMERModule(assessmentId, documents, assessment) {
  const extractedData = { telemer_data: {}, voice_analysis: {} };

  for (const doc of documents) {
    if (doc.type === 'telemer_transcript') {
      emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Questionnaire Agent' });
      const result = await extractor.extractTeleMERData(doc.text);
      extractedData.telemer_data = result.data;
      logApiCall(assessment, 'telemer_extraction', result);
    }
    if (doc.type === 'voice_analysis') {
      emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Voice Analysis Agent' });
      const result = await extractor.extractVoiceAnalysis(doc.text);
      extractedData.voice_analysis = result.data;
      logApiCall(assessment, 'voice_analysis', result);
    }
  }

  return extractedData;
}

async function processPPHCModule(assessmentId, documents, assessment) {
  const extractedData = {
    blood_chemistry: {},
    hematology: {},
    urine_analysis: {},
    cardiac: {},
    physical_exam: {},
    imaging: {}
  };

  for (const doc of documents) {
    switch (doc.type) {
      case 'blood_chemistry':
      case 'lab_report':
        emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Report Extraction Agent — Blood Chemistry' });
        const bcResult = await extractor.extractPPHCBloodChemistry(doc.text);
        extractedData.blood_chemistry = bcResult.data;
        logApiCall(assessment, 'blood_chemistry', bcResult);
        break;

      case 'hematology':
      case 'cbc_report':
        emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Report Extraction Agent — Hematology' });
        const hemResult = await extractor.extractPPHCHematology(doc.text);
        extractedData.hematology = hemResult.data;
        logApiCall(assessment, 'hematology', hemResult);
        break;

      case 'urine_analysis':
        emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Report Extraction Agent — Urine' });
        const urineResult = await extractor.extractPPHCUrineAnalysis(doc.text);
        extractedData.urine_analysis = urineResult.data;
        logApiCall(assessment, 'urine_analysis', urineResult);
        break;

      case 'ecg':
      case 'echo':
      case 'cardiac':
      case 'tmt':
        emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Report Extraction Agent — Cardiac' });
        const cardResult = await extractor.extractPPHCCardiac(doc.text);
        extractedData.cardiac = cardResult.data;
        logApiCall(assessment, 'cardiac', cardResult);
        break;

      case 'physical_exam':
        emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Report Extraction Agent — Physical Exam' });
        const peResult = await extractor.extractPPHCPhysicalExam(doc.text);
        extractedData.physical_exam = peResult.data;
        logApiCall(assessment, 'physical_exam', peResult);
        break;

      case 'xray':
      case 'usg':
      case 'imaging':
        emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Report Extraction Agent — Imaging' });
        const imgResult = await extractor.extractPPHCImaging(doc.text);
        extractedData.imaging = imgResult.data;
        logApiCall(assessment, 'imaging', imgResult);
        break;
    }
  }

  return extractedData;
}

async function processHistoricalModule(assessmentId, documents, assessment) {
  const extractedData = { claims_data: {}, portfolio_analysis: {} };

  for (const doc of documents) {
    if (doc.type === 'claims_data') {
      emitProgress(assessmentId, { stage: 'extracting', document: doc.name, agent: 'Claims Learning Agent' });
      const result = await extractor.extractClaimsData(doc.text);
      extractedData.claims_data = result.data;
      logApiCall(assessment, 'claims_extraction', result);
    }
    if (doc.type === 'portfolio_data') {
      emitProgress(assessmentId, { stage: 'analyzing', document: doc.name, agent: 'Portfolio Intelligence Agent' });
      const result = await extractor.analyzePortfolioRisk(doc.text);
      extractedData.portfolio_analysis = result.data;
      logApiCall(assessment, 'portfolio_analysis', result);
    }
  }

  return extractedData;
}

function logApiCall(assessment, agent, result) {
  if (!assessment.api_log) assessment.api_log = [];
  assessment.api_log.push({
    agent,
    timestamp: new Date().toISOString(),
    tokens: result.tokens,
    duration_ms: result.duration_ms
  });
}

// ─── Worker Setup ───

function startWorker() {
  try {
    worker = new Worker('insurance-uw', processAssessment, {
      connection: getConnection(),
      concurrency: 2,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 }
    });

    worker.on('completed', (job, result) => {
      console.log(`Job ${job.id} completed: ${result.assessmentId} in ${result.duration}ms`);
    });

    worker.on('failed', (job, err) => {
      console.error(`Job ${job?.id} failed:`, err.message);
    });

    worker.on('error', (err) => {
      console.error('Worker error:', err.message);
    });

    console.log('BullMQ worker started');
    return worker;
  } catch (err) {
    console.error('Failed to start BullMQ worker:', err.message);
    return null;
  }
}

async function addJob(assessmentId, moduleType, documents) {
  const q = getQueue();
  const job = await q.add('process-assessment', {
    assessmentId,
    module: moduleType,
    documents
  }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true
  });
  return job;
}

module.exports = {
  startWorker,
  addJob,
  setSocketManager,
  getQueue
};
