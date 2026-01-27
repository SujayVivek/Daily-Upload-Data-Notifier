#!/usr/bin/env node
/**
 * Resume Summary Generation Tool
 * 
 * This script helps you resume a crashed summary generation process
 * or check the status of an ongoing/completed run.
 */

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const reportsDir = path.join(__dirname, 'reports');
const progressFile = path.join(reportsDir, 'progress_summaries.json');

function log(level, msg) {
  const ts = DateTime.now().setZone('Asia/Kolkata').toFormat('HH:mm:ss');
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

function checkProgress() {
  log('info', '========================================');
  log('info', '🔍 Checking Progress Status');
  log('info', '========================================');
  
  if (!fs.existsSync(progressFile)) {
    log('info', '❌ No progress file found.');
    log('info', 'Either no run has started, or the last run completed successfully.');
    return null;
  }
  
  try {
    const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    
    log('info', '✓ Progress file found!');
    log('info', '');
    log('info', 'Details:');
    log('info', `  Excel file: ${path.basename(progress.excelPath)}`);
    log('info', `  Files processed: ${progress.lastProcessed || progress.summaries.length}`);
    log('info', `  Last update: ${new Date(progress.timestamp).toLocaleString()}`);
    log('info', '');
    
    // Try to read the original Excel to get total count
    if (fs.existsSync(progress.excelPath)) {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(progress.excelPath);
      const ws = wb.Sheets['Uploads'];
      const data = XLSX.utils.sheet_to_json(ws);
      
      const processed = progress.summaries.length;
      const total = data.length;
      const remaining = total - processed;
      const percentComplete = ((processed / total) * 100).toFixed(1);
      
      log('info', 'Progress:');
      log('info', `  Total files: ${total}`);
      log('info', `  Processed: ${processed} (${percentComplete}%)`);
      log('info', `  Remaining: ${remaining}`);
      log('info', `  [${'\u2588'.repeat(Math.floor(processed/total*40))}${' '.repeat(40-Math.floor(processed/total*40))}]`);
      
      if (remaining > 0) {
        const estMinutes = (remaining * 2.5 / 60).toFixed(1);
        log('info', `  Estimated time to complete: ${estMinutes} minutes`);
      }
    }
    
    return progress;
  } catch (error) {
    log('error', `Failed to read progress file: ${error.message}`);
    return null;
  }
}

function cleanProgress() {
  log('info', '========================================');
  log('info', '🧹 Cleaning Progress File');
  log('info', '========================================');
  
  if (!fs.existsSync(progressFile)) {
    log('info', 'No progress file to clean.');
    return;
  }
  
  try {
    fs.unlinkSync(progressFile);
    log('info', '✓ Progress file deleted successfully.');
    log('info', 'You can now start a fresh run.');
  } catch (error) {
    log('error', `Failed to delete progress file: ${error.message}`);
  }
}

async function resumeSummaries() {
  log('info', '========================================');
  log('info', '▶️  Resuming Summary Generation');
  log('info', '========================================');
  
  const progress = checkProgress();
  
  if (!progress) {
    log('error', 'Cannot resume: No progress file found.');
    log('info', 'Run the main script instead: node s3_daily_summary.js');
    return;
  }
  
  if (!fs.existsSync(progress.excelPath)) {
    log('error', `Cannot resume: Excel file not found at ${progress.excelPath}`);
    return;
  }
  
  const processed = progress.summaries.length;
  log('info', `Resuming from file ${processed + 1}...`);
  log('info', '');
  
  try {
    const { generateFileSummaries } = require('./generate_file_summaries');
    await generateFileSummaries(progress.excelPath, reportsDir);
    log('info', '✅ Summary generation completed!');
  } catch (error) {
    log('error', `Error during resume: ${error.message}`);
    log('error', `Stack: ${error.stack}`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Resume Summary Generation Tool
===============================

Usage:
  node resume_summaries.js [command]

Commands:
  status    Check the current progress status (default)
  resume    Resume summary generation from last checkpoint
  clean     Delete the progress file and start fresh
  help      Show this help message

Examples:
  node resume_summaries.js              # Check status
  node resume_summaries.js status       # Check status
  node resume_summaries.js resume       # Resume from crash
  node resume_summaries.js clean        # Clean and start over

The script automatically saves progress every 10 files.
If the process crashes, you can resume from the last checkpoint.
`);
}

// Main execution
const command = process.argv[2] || 'status';

(async () => {
  try {
    switch (command) {
      case 'status':
        checkProgress();
        break;
      
      case 'resume':
        await resumeSummaries();
        break;
      
      case 'clean':
        cleanProgress();
        break;
      
      case 'help':
      case '--help':
      case '-h':
        showHelp();
        break;
      
      default:
        log('error', `Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    log('error', `Fatal error: ${error.message}`);
    process.exit(1);
  }
})();
