#!/usr/bin/env node
/**
 * Complete Pipeline Runner
 * 
 * This script runs the entire data ingestion pipeline in one go:
 * 1. Scans S3 buckets and generates upload report (npm start)
 * 2. Processes files in batches and sends email (npm run batch)
 */

const { spawn } = require('child_process');
const path = require('path');
const { DateTime } = require('luxon');

function log(level, msg) {
  const ts = DateTime.now().setZone('Asia/Kolkata').toFormat('HH:mm:ss');
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    log('info', `Running: ${command} ${args.join(' ')}`);
    
    const proc = spawn(command, args, {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        log('info', `✓ Command completed successfully`);
        resolve();
      } else {
        log('error', `✗ Command failed with code ${code}`);
        reject(new Error(`Process exited with code ${code}`));
      }
    });
    
    proc.on('error', (err) => {
      log('error', `✗ Failed to start command: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  const startTime = Date.now();
  
  log('info', '========================================');
  log('info', '🚀 COMPLETE PIPELINE STARTED');
  log('info', '========================================');
  log('info', `Start time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
  
  try {
    // Step 1: Run S3 scan and generate upload report
    log('info', '\n========================================');
    log('info', '📊 STEP 1: Scanning S3 Buckets');
    log('info', '========================================');
    await runCommand('node', ['s3_daily_summary.js']);
    
    log('info', '\n✓ Step 1 complete! Upload report generated.');
    log('info', 'Waiting 5 seconds before starting batch processing...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Step 2: Process files in batches and send email
    log('info', '========================================');
    log('info', '🤖 STEP 2: Processing Files in Batches');
    log('info', '========================================');
    await runCommand('node', ['process_in_batches.js']);
    
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    
    log('info', '\n========================================');
    log('info', '✅ COMPLETE PIPELINE FINISHED!');
    log('info', '========================================');
    log('info', `Total time: ${totalTime} minutes`);
    log('info', `End time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
    log('info', '\n📧 Email has been sent with both reports attached!');
    log('info', '========================================');
    
  } catch (error) {
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    
    log('error', '\n========================================');
    log('error', '❌ PIPELINE FAILED');
    log('error', '========================================');
    log('error', `Error: ${error.message}`);
    log('error', `Failed after ${totalTime} minutes`);
    log('error', '========================================');
    process.exit(1);
  }
}

main();
