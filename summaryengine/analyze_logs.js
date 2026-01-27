#!/usr/bin/env node
/**
 * Log Analyzer Tool
 * 
 * Analyzes logs from crashed runs to identify:
 * - Where the crash occurred
 * - What errors appeared
 * - Performance metrics
 * - Memory trends
 */

const fs = require('fs');
const path = require('path');

function analyzeLogFile(logContent) {
  const lines = logContent.split('\n');
  
  const stats = {
    totalLines: lines.length,
    filesProcessed: 0,
    lastFileProcessed: null,
    errors: [],
    warnings: [],
    apiCalls: 0,
    avgApiTime: 0,
    memoryReadings: [],
    crashPoint: null,
    rateLimit429: 0,
    authErrors: 0,
  };
  
  let apiTimes = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Extract memory usage
    const memMatch = line.match(/\[MEM: ([\d.]+)MB\]/);
    if (memMatch) {
      stats.memoryReadings.push(parseFloat(memMatch[1]));
    }
    
    // Count files processed
    if (line.includes('Processing:') && line.match(/\[(\d+)\/(\d+)\]/)) {
      const match = line.match(/\[(\d+)\/(\d+)\]/);
      stats.filesProcessed = parseInt(match[1]);
      
      // Extract filename
      const fileMatch = line.match(/Processing: (.+)$/);
      if (fileMatch) {
        stats.lastFileProcessed = fileMatch[1];
      }
    }
    
    // Count API calls and timing
    if (line.includes('Summary generated') && line.includes('API:')) {
      stats.apiCalls++;
      const timeMatch = line.match(/API: (\d+)ms/);
      if (timeMatch) {
        apiTimes.push(parseInt(timeMatch[1]));
      }
    }
    
    // Capture errors
    if (line.includes('[ERROR]')) {
      stats.errors.push({
        line: i + 1,
        message: line,
      });
      
      if (line.includes('429') || line.includes('rate_limit')) {
        stats.rateLimit429++;
      }
      
      if (line.includes('401') || line.includes('authentication')) {
        stats.authErrors++;
      }
    }
    
    // Capture warnings
    if (line.includes('[WARN]')) {
      stats.warnings.push({
        line: i + 1,
        message: line,
      });
    }
    
    // Detect crash indicators
    if (line.includes('heap out of memory') || 
        line.includes('FATAL ERROR') ||
        line.includes('Segmentation fault') ||
        line.includes('Cannot read property')) {
      stats.crashPoint = {
        line: i + 1,
        message: line,
      };
    }
  }
  
  // Calculate average API time
  if (apiTimes.length > 0) {
    stats.avgApiTime = Math.round(apiTimes.reduce((a, b) => a + b, 0) / apiTimes.length);
  }
  
  return stats;
}

function printReport(stats, logFile) {
  console.log('\n========================================');
  console.log('📊 LOG ANALYSIS REPORT');
  console.log('========================================');
  console.log(`Log file: ${logFile}`);
  console.log(`Total lines: ${stats.totalLines}`);
  console.log('');
  
  console.log('📈 PROGRESS');
  console.log('─────────────────────────────────────');
  console.log(`Files processed: ${stats.filesProcessed}`);
  if (stats.lastFileProcessed) {
    console.log(`Last file: ${stats.lastFileProcessed}`);
  }
  console.log('');
  
  console.log('⚡ PERFORMANCE');
  console.log('─────────────────────────────────────');
  console.log(`API calls made: ${stats.apiCalls}`);
  console.log(`Average API time: ${stats.avgApiTime}ms`);
  
  if (stats.avgApiTime > 3000) {
    console.log('  ⚠️  WARNING: Slow API response times detected');
  }
  console.log('');
  
  console.log('💾 MEMORY USAGE');
  console.log('─────────────────────────────────────');
  if (stats.memoryReadings.length > 0) {
    const minMem = Math.min(...stats.memoryReadings).toFixed(2);
    const maxMem = Math.max(...stats.memoryReadings).toFixed(2);
    const avgMem = (stats.memoryReadings.reduce((a, b) => a + b, 0) / stats.memoryReadings.length).toFixed(2);
    const lastMem = stats.memoryReadings[stats.memoryReadings.length - 1].toFixed(2);
    
    console.log(`Minimum: ${minMem} MB`);
    console.log(`Maximum: ${maxMem} MB`);
    console.log(`Average: ${avgMem} MB`);
    console.log(`Last reading: ${lastMem} MB`);
    
    if (maxMem > 1500) {
      console.log('  ⚠️  WARNING: High memory usage detected (>1.5GB)');
    }
    
    // Check if memory was growing
    const first100 = stats.memoryReadings.slice(0, Math.min(100, stats.memoryReadings.length));
    const last100 = stats.memoryReadings.slice(-Math.min(100, stats.memoryReadings.length));
    const avgFirst = first100.reduce((a, b) => a + b, 0) / first100.length;
    const avgLast = last100.reduce((a, b) => a + b, 0) / last100.length;
    
    if (avgLast > avgFirst * 1.5) {
      console.log('  ⚠️  WARNING: Memory appears to be growing steadily');
    }
  } else {
    console.log('No memory readings found (old log format?)');
  }
  console.log('');
  
  console.log('🚨 ERRORS & WARNINGS');
  console.log('─────────────────────────────────────');
  console.log(`Total errors: ${stats.errors.length}`);
  console.log(`Total warnings: ${stats.warnings.length}`);
  
  if (stats.rateLimit429 > 0) {
    console.log(`Rate limit errors (429): ${stats.rateLimit429}`);
    console.log('  ℹ️  Rate limiting is normal and handled automatically');
  }
  
  if (stats.authErrors > 0) {
    console.log(`Authentication errors: ${stats.authErrors}`);
    console.log('  ⚠️  CHECK: CLAUDE_API_KEY in .env file');
  }
  
  // Show recent errors
  if (stats.errors.length > 0) {
    console.log('');
    console.log('Recent errors (last 5):');
    const recentErrors = stats.errors.slice(-5);
    recentErrors.forEach(err => {
      const shortMsg = err.message.length > 100 ? 
        err.message.slice(0, 97) + '...' : 
        err.message;
      console.log(`  Line ${err.line}: ${shortMsg}`);
    });
  }
  console.log('');
  
  console.log('💥 CRASH ANALYSIS');
  console.log('─────────────────────────────────────');
  if (stats.crashPoint) {
    console.log('❌ CRASH DETECTED');
    console.log(`Line ${stats.crashPoint.line}: ${stats.crashPoint.message}`);
    console.log('');
    console.log('🔧 Recommended action:');
    if (stats.crashPoint.message.includes('heap out of memory')) {
      console.log('  - Memory issue detected');
      console.log('  - Consider processing in smaller batches');
      console.log('  - Check for memory leaks');
    } else {
      console.log('  - Review the error message above');
      console.log('  - Check the last few files processed');
      console.log('  - Use resume command to continue');
    }
  } else {
    console.log('✓ No explicit crash detected in logs');
    console.log('');
    if (stats.filesProcessed < 1400 && stats.errors.length === 0) {
      console.log('Possible causes:');
      console.log('  - Process was manually killed (Ctrl+C, timeout, etc.)');
      console.log('  - Network connection lost');
      console.log('  - EC2 instance stopped/restarted');
      console.log('  - Terminal session disconnected');
    } else if (stats.errors.length > 10) {
      console.log('Many errors detected - check errors above');
    }
  }
  console.log('');
  
  console.log('🎯 RECOMMENDATIONS');
  console.log('─────────────────────────────────────');
  
  if (stats.filesProcessed > 0 && stats.filesProcessed < 1400) {
    console.log('✅ Good news: Progress was made!');
    console.log(`   ${stats.filesProcessed} files were processed`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Check if progress file exists:');
    console.log('     node resume_summaries.js status');
    console.log('');
    console.log('  2. Resume from where it stopped:');
    console.log('     node resume_summaries.js resume');
  } else if (stats.filesProcessed === 0) {
    console.log('⚠️  Process crashed early or didn\'t start properly');
    console.log('');
    console.log('Check:');
    console.log('  - Environment variables (.env file)');
    console.log('  - AWS credentials');
    console.log('  - Claude API key');
    console.log('  - Node.js version');
  }
  
  console.log('');
  console.log('========================================');
  console.log('End of report');
  console.log('========================================\n');
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
Log Analyzer Tool
==================

Usage:
  node analyze_logs.js <log-file>

Example:
  node analyze_logs.js output.log
  node analyze_logs.js /var/log/summary.log

This tool analyzes log files from crashed runs to help identify:
  - Where the crash occurred
  - What errors appeared  
  - Performance metrics
  - Memory trends
  - Recommended next steps
`);
  process.exit(0);
}

const logFile = args[0];

if (!fs.existsSync(logFile)) {
  console.error(`❌ Error: Log file not found: ${logFile}`);
  process.exit(1);
}

console.log(`Reading log file: ${logFile}`);

try {
  const logContent = fs.readFileSync(logFile, 'utf-8');
  const stats = analyzeLogFile(logContent);
  printReport(stats, logFile);
} catch (error) {
  console.error(`❌ Error analyzing log file: ${error.message}`);
  process.exit(1);
}
