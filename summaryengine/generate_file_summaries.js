const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const XLSX = require('xlsx');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// CRITICAL: Handle unhandled promise rejections (prevents silent exits)
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n\n❌ UNHANDLED PROMISE REJECTION:');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  console.error('\nThis would cause the process to exit silently!');
  console.error('Stack:', reason?.stack || 'No stack trace');
  // Don't exit - just log it
});

// CRITICAL: Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('\n\n❌ UNCAUGHT EXCEPTION:');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  console.error('\nProcess will exit!');
  process.exit(1);
});

// Log when process exits
process.on('exit', (code) => {
  console.log(`\n\n[EXIT] Process exiting with code: ${code}`);
});

// Log SIGTERM and SIGINT
process.on('SIGTERM', () => {
  console.log('\n\n[SIGTERM] Process received SIGTERM signal');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n\n[SIGINT] Process received SIGINT signal (Ctrl+C)');
  process.exit(0);
});

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Initialize S3 client
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// Initialize Claude client
const anthropic = new Anthropic({
  apiKey: CLAUDE_API_KEY,
});

function log(level, msg) {
  const ts = DateTime.now().setZone('Asia/Kolkata').toFormat('HH:mm:ss');
  const memUsage = process.memoryUsage();
  const memMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
  console.log(`[${ts}] [${level.toUpperCase()}] [MEM: ${memMB}MB] ${msg}`);
}

function readFilesFromExcel(excelPath) {
  log('info', `Reading files from Excel report: ${path.basename(excelPath)}`);
  log('debug', `Full path: ${excelPath}`);
  
  try {
    const workbook = XLSX.readFile(excelPath);
    log('debug', `Workbook loaded, sheets: ${workbook.SheetNames.join(', ')}`);
    
    const sheetName = 'Uploads';
    
    if (!workbook.SheetNames.includes(sheetName)) {
      log('error', `Sheet "${sheetName}" not found in Excel file`);
      return [];
    }
    
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    log('info', `Read ${data.length} rows from Excel`);
    
    const files = data.map((row, idx) => {
      const key = row.Key || '';
      const idxSlash = key.lastIndexOf('/');
      const fileName = idxSlash === -1 ? key : key.slice(idxSlash + 1);
      const directory = idxSlash === -1 ? '/' : key.slice(0, idxSlash);
      
      if ((idx + 1) % 100 === 0) {
        log('debug', `Parsed ${idx + 1} file entries...`);
      }
      
      return {
        bucket: row.Bucket,
        key: key,
        fileName: fileName,
        directory: directory,
        size: row.Size || 0,
      };
    });
    
    log('info', `Found ${files.length} files in the Excel report`);
    return files;
  } catch (error) {
    log('error', `Failed to read Excel file: ${error.message}`);
    log('error', `Stack: ${error.stack}`);
    return [];
  }
}

async function downloadFileContent(bucket, key, maxSize = 500000) {
  const startTime = Date.now();
  log('debug', `Downloading: s3://${bucket}/${key}`);
  
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3.send(command);
    log('debug', `S3 response received for ${key}`);
    
    // Convert stream to buffer
    const chunks = [];
    let totalSize = 0;
    let chunkCount = 0;
    
    for await (const chunk of response.Body) {
      chunkCount++;
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        log('warn', `File too large (${totalSize} > ${maxSize} bytes), truncating: ${key}`);
        break;
      }
      chunks.push(chunk);
    }
    
    const buffer = Buffer.concat(chunks);
    const downloadTime = Date.now() - startTime;
    log('debug', `Downloaded ${totalSize} bytes in ${chunkCount} chunks (${downloadTime}ms)`);
    
    // Try to convert to text
    const content = buffer.toString('utf-8');
    
    // Check if it's readable text (simple heuristic)
    const nonPrintable = content.split('').filter(c => {
      const code = c.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;
    
    log('debug', `Text analysis: ${nonPrintable} non-printable chars out of ${content.length} total`);
    
    if (nonPrintable > content.length * 0.3) {
      log('debug', `Rejecting as binary file (${(nonPrintable/content.length*100).toFixed(1)}% non-printable)`);
      return null; // Likely binary
    }
    
    const limitedContent = content.slice(0, 50000);
    log('debug', `Returning ${limitedContent.length} chars of text content`);
    return limitedContent; // Limit to 50KB for Claude
  } catch (error) {
    log('error', `Failed to download ${key}: ${error.message}`);
    if (error.Code) log('error', `  AWS Error Code: ${error.Code}`);
    if (error.$metadata) {
      log('error', `  HTTP Status: ${error.$metadata.httpStatusCode}`);
    }
    return null;
  }
}

async function generateSummaryWithClaude(fileName, directory, fileContent, retries = 3) {
  const startTime = Date.now();
  log('debug', `Calling Claude API for: ${fileName}`);
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const contentPreview = fileContent.slice(0, 10000);
      log('debug', `  Attempt ${attempt}/${retries} - Sending ${contentPreview.length} chars to Claude`);
      
      const prompt = `Read the following file content and provide a simple, clear 3-line briefing of what this document is about. Write it in plain human language as if explaining it to a colleague.

File: ${fileName}

Content:
${contentPreview}

Provide EXACTLY 3 lines describing:
1. What this document is about (main topic/subject)
2. Key information or findings in the document
3. Main conclusion, outcome, or purpose

Write naturally and clearly - no technical jargon or metadata descriptions.`;

      // Wrap API call with timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('API call timeout after 60 seconds')), 60000);
      });
      
      const apiPromise = anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 200,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: prompt,
        }],
      });
      
      const message = await Promise.race([apiPromise, timeoutPromise]);

      const apiTime = Date.now() - startTime;
      log('debug', `  Claude API responded in ${apiTime}ms`);
      
      const summary = message.content[0].text.trim();
      log('debug', `  Summary length: ${summary.length} chars`);
      
      // Ensure it's max 3 lines
      const lines = summary.split('\n').filter(l => l.trim());
      const result = lines.slice(0, 3).join('\n');
      
      log('info', `  ✓ Summary generated successfully (${apiTime}ms)`);
      return result;
    } catch (error) {
      log('error', `  Claude API error (attempt ${attempt}/${retries}): ${error.message}`);
      if (error.status) log('error', `    HTTP Status: ${error.status}`);
      if (error.type) log('error', `    Error Type: ${error.type}`);
      if (error.error && error.error.type) log('error', `    API Error Type: ${error.error.type}`);
      
      // Rate limiting - wait longer before retry
      if (error.status === 429 && attempt < retries) {
        const waitTime = attempt * 10000; // 10s, 20s, 30s
        log('warn', `    Rate limited! Waiting ${waitTime/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Other errors - shorter wait before retry
      if (attempt < retries) {
        const waitTime = 5000;
        log('warn', `    Retrying in ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // All retries exhausted
      log('error', `  ✗ All ${retries} attempts failed for ${fileName}`);
      return 'Error generating summary (API failure after retries)';
    }
  }
}

async function generateFileSummaries(excelReportPath, saveDir) {
  log('info', '========================================');
  log('info', '📄 Starting File Summary Generation');
  log('info', '========================================');
  log('info', `Start time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
  
  // Read files from the existing Excel report
  const files = readFilesFromExcel(excelReportPath);
  
  if (files.length === 0) {
    log('warn', 'No files to summarize');
    return null;
  }
  
  // Process ALL files (no limit)
  const filesToProcess = files;
  log('info', `Processing all ${files.length} files`);
  log('info', `Estimated time: ${(files.length * 2.5 / 60).toFixed(1)} minutes`);
  
  // Progress file to resume from crashes
  const progressFile = path.join(saveDir, 'progress_summaries.json');
  let summaries = [];
  let startIndex = 0;
  
  // Try to resume from previous run
  if (fs.existsSync(progressFile)) {
    try {
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      if (progress.excelPath === excelReportPath && progress.summaries) {
        summaries = progress.summaries;
        startIndex = summaries.length;
        log('info', `🔄 RESUMING from previous run at file ${startIndex + 1}/${files.length}`);
        log('info', `Already processed: ${startIndex} files`);
      }
    } catch (err) {
      log('warn', `Could not load progress file: ${err.message}`);
    }
  }
  
  let processed = startIndex;
  const totalStartTime = Date.now();
  let apiCallCount = 0;
  let apiTotalTime = 0;
  let downloadCount = 0;
  let downloadTotalTime = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  for (let i = startIndex; i < filesToProcess.length; i++) {
    const file = filesToProcess[i];
    processed++;
    const percentComplete = ((processed / filesToProcess.length) * 100).toFixed(1);
    const eta = processed > startIndex ? 
      ((Date.now() - totalStartTime) / (processed - startIndex) * (filesToProcess.length - processed) / 1000 / 60).toFixed(1) : 
      'calculating...';
    
    log('info', `\n[${'='.repeat(Math.floor(processed/filesToProcess.length*40))}>${' '.repeat(40-Math.floor(processed/filesToProcess.length*40))}] ${percentComplete}%`);
    log('info', `[${processed}/${filesToProcess.length}] Processing: ${file.fileName}`);
    log('info', `  Bucket: ${file.bucket}`);
    log('info', `  Path: ${file.key}`);
    log('info', `  Size: ${(file.size / 1024).toFixed(2)} KB`);
    log('info', `  ETA: ${eta} minutes`);
    log('info', `  Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
    
    let briefing;
    
    // Wrap entire file processing in try-catch to prevent exit
    try {
      // Download and read file content
      const downloadStart = Date.now();
      const content = await downloadFileContent(file.bucket, file.key);
      const downloadTime = Date.now() - downloadStart;
      downloadCount++;
      downloadTotalTime += downloadTime;
      
      if (!content) {
        briefing = 'Binary file or unable to read content';
        skippedCount++;
        log('warn', `  ⊘ Skipped (binary or unreadable)`);
      } else {
        // Generate summary using Claude (one at a time)
        const apiStart = Date.now();
        briefing = await generateSummaryWithClaude(file.fileName, file.directory, content);
        const apiTime = Date.now() - apiStart;
        apiCallCount++;
        apiTotalTime += apiTime;
        
        if (briefing.startsWith('Error generating summary')) {
          errorCount++;
        }
        
        log('info', `  ✓ Summary generated (API: ${apiTime}ms, Download: ${downloadTime}ms)`);
        
        // Add delay between requests to avoid rate limits
        if (processed < filesToProcess.length) {
          const delay = 3000; // Increased to 3 seconds for safety
          log('debug', `  ⏱ Waiting ${delay/1000}s before next file...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      log('error', `  ✗ CRITICAL ERROR processing file: ${error.message}`);
      log('error', `     Error type: ${error.constructor.name}`);
      log('error', `     Error code: ${error.code || 'N/A'}`);
      log('error', `     Stack: ${error.stack}`);
      briefing = `CRITICAL ERROR: ${error.message}`;
      errorCount++;
      
      // Continue despite error - don't let one file crash everything
      log('warn', `  → Continuing with next file despite error...`);
    }
    
    // Extra safety: wrap summary push in try-catch
    try {
        summaries.push({
        'File Name': file.fileName,
        'File Directory': file.directory,
        'Briefing by LLM': briefing,
      });
    } catch (pushError) {
      log('error', `  ✗ ERROR pushing summary: ${pushError.message}`);
      // Still try to save what we have
      summaries.push({
        'File Name': file.fileName || 'UNKNOWN',
        'File Directory': file.directory || 'UNKNOWN',
        'Briefing by LLM': 'Error saving summary',
      });
    }
    
    // Save progress every 10 files
    if (processed % 10 === 0) {
      try {
        fs.writeFileSync(progressFile, JSON.stringify({
          excelPath: excelReportPath,
          summaries: summaries,
          lastProcessed: processed,
          timestamp: new Date().toISOString()
        }, null, 2));
        log('info', `  💾 Progress saved (${processed} files)`);
      } catch (err) {
        log('error', `  Failed to save progress: ${err.message}`);
      }
    }
    
    // Force garbage collection every 50 files to prevent memory leaks
    if (processed % 50 === 0 && global.gc) {
      const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
      global.gc();
      const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
      log('info', `  🗑️ Garbage collection: ${memBefore.toFixed(2)}MB → ${memAfter.toFixed(2)}MB`);
    }
    
    // Log statistics every 25 files
    if (processed % 25 === 0) {
      const avgApiTime = apiCallCount > 0 ? (apiTotalTime / apiCallCount).toFixed(0) : 0;
      const avgDownloadTime = downloadCount > 0 ? (downloadTotalTime / downloadCount).toFixed(0) : 0;
      log('info', `\n  📊 Statistics:`);
      log('info', `     Processed: ${processed}/${filesToProcess.length}`);
      log('info', `     API calls: ${apiCallCount}, Avg time: ${avgApiTime}ms`);
      log('info', `     Downloads: ${downloadCount}, Avg time: ${avgDownloadTime}ms`);
      log('info', `     Skipped: ${skippedCount}, Errors: ${errorCount}`);
      const elapsedMin = ((Date.now() - totalStartTime) / 1000 / 60).toFixed(1);
      log('info', `     Elapsed: ${elapsedMin} min`);
    }
  }
  
  // Final statistics
  const totalTime = (Date.now() - totalStartTime) / 1000;
  log('info', '\n========================================');
  log('info', '📊 FINAL STATISTICS');
  log('info', '========================================');
  log('info', `Total files: ${filesToProcess.length}`);
  log('info', `Successfully processed: ${summaries.length}`);
  log('info', `Skipped (binary): ${skippedCount}`);
  log('info', `Errors: ${errorCount}`);
  log('info', `API calls made: ${apiCallCount}`);
  log('info', `Total time: ${(totalTime / 60).toFixed(1)} minutes`);
  log('info', `Avg time per file: ${(totalTime / filesToProcess.length).toFixed(1)}s`);
  
  // Create Excel workbook
  log('info', '\nCreating Excel workbook with summaries...');
  
  if (!fs.existsSync(saveDir)) {
    log('debug', `Creating directory: ${saveDir}`);
    fs.mkdirSync(saveDir, { recursive: true });
  }
  
  const wb = XLSX.utils.book_new();
  log('debug', 'Converting summaries to sheet...');
  const ws = XLSX.utils.json_to_sheet(summaries);
  
  // Set column widths
  ws['!cols'] = [
    { wch: 30 },  // File Name
    { wch: 50 },  // File Directory
    { wch: 80 },  // Briefing by LLM
  ];
  log('debug', 'Column widths set');
  
  XLSX.utils.book_append_sheet(wb, ws, 'File Summaries');
  
  // Extract date from the input filename
  const inputFilename = path.basename(excelReportPath);
  const dateMatch = inputFilename.match(/(\d{8})/);
  const dateStr = dateMatch ? dateMatch[1] : DateTime.now().setZone('Asia/Kolkata').toFormat('yyyyLLdd');
  
  const filename = `file_summaries_${dateStr}.xlsx`;
  const outputPath = path.join(saveDir, filename);
  
  log('info', `Writing workbook to: ${outputPath}`);
  XLSX.writeFile(wb, outputPath);
  log('info', `✓ File summaries saved: ${filename}`);
  
  // Clean up progress file
  if (fs.existsSync(progressFile)) {
    try {
      fs.unlinkSync(progressFile);
      log('info', '✓ Progress file cleaned up');
    } catch (err) {
      log('warn', `Could not delete progress file: ${err.message}`);
    }
  }
  
  log('info', '========================================');
  log('info', `End time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
  log('info', '========================================');
  
  return outputPath;
}

module.exports = { generateFileSummaries };

// Allow running standalone
if (require.main === module) {
  (async () => {
    try {
      if (!CLAUDE_API_KEY) {
        log('error', 'CLAUDE_API_KEY not found in environment');
        process.exit(1);
      }
      
      // Find the most recent daily upload report
      const reportsDir = path.join(__dirname, 'reports');
      
      if (!fs.existsSync(reportsDir)) {
        log('error', 'Reports directory not found');
        process.exit(1);
      }
      
      const files = fs.readdirSync(reportsDir)
        .filter(f => f.startsWith('s3_daily_uploads_') && f.endsWith('.xlsx'))
        .sort()
        .reverse();
      
      if (files.length === 0) {
        log('error', 'No daily upload reports found');
        process.exit(1);
      }
      
      const latestReport = path.join(reportsDir, files[0]);
      log('info', `Using report: ${files[0]}`);
      
      await generateFileSummaries(latestReport, reportsDir);
      
      log('info', '✅ File summary generation complete');
    } catch (error) {
      log('error', `Fatal error: ${error.message}`);
      process.exit(1);
    }
  })();
}
