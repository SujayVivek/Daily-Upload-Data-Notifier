#!/usr/bin/env node
/**
 * Batch Processing Orchestrator
 * 
 * This script processes files in batches of 25 using Claude AI to generate:
 * 1. A highly specific summary of each document's content
 * After each batch, it saves progress and continues with the next batch.
 * Once all files are processed, it sends the email automatically.
 */

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const XLSX = require('xlsx');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Configuration
const BATCH_SIZE = 25;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USERNAME;
const SMTP_SERVER = process.env.SMTP_SERVER || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;

// Parse TO_EMAIL from environment
function parseEnvEmails(raw) {
  if (!raw) return [];
  const cleaned = String(raw).trim();
  if (cleaned.startsWith('[')) {
    try {
      const arr = JSON.parse(cleaned);
      const items = Array.isArray(arr) ? arr : [];
      const out = [];
      for (const item of items) {
        if (item == null) continue;
        String(item)
          .split(',')
          .forEach(p => {
            const email = p.replace(/^['"]|['"]$/g, '').trim();
            if (email) out.push(email);
          });
      }
      return out;
    } catch {
      const withoutBrackets = cleaned.replace(/^\[/, '').replace(/\]$/, '');
      return withoutBrackets
        .split(',')
        .map(e => e.replace(/^['"]|['"]$/g, '').trim())
        .filter(Boolean);
    }
  }
  return cleaned
    .split(',')
    .map(e => e.replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

const TO_EMAIL = parseEnvEmails(process.env.TO_EMAIL || '');

// Initialize clients
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const anthropic = new Anthropic({
  apiKey: CLAUDE_API_KEY,
});

const CLAUDE_MODEL = 'claude-3-5-sonnet-20240620';

function log(level, msg) {
  const ts = DateTime.now().setZone('Asia/Kolkata').toFormat('HH:mm:ss');
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

// Directories to skip for question and summary generation
const SKIP_DIRECTORIES = [
  'commercial-case-laws',
  'usecase-reports-2',
  'usecase-reports-3',
  'usecase-reports-4',
  'usecase-reports-5',
  'usecase-reports'
];

function shouldSkipDirectory(directory) {
  // Check if the directory starts with or contains any of the skip patterns
  const dirLower = directory.toLowerCase();
  return SKIP_DIRECTORIES.some(skipDir => 
    dirLower.includes(skipDir.toLowerCase())
  );
}

function readFilesFromExcel(excelPath) {
  log('info', `Reading files from Excel report: ${path.basename(excelPath)}`);
  
  try {
    const workbook = XLSX.readFile(excelPath);
    const sheetName = 'Uploads';
    
    if (!workbook.SheetNames.includes(sheetName)) {
      log('error', `Sheet "${sheetName}" not found in Excel file`);
      return [];
    }
    
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    const files = data.map((row) => {
      const key = row.Key || '';
      const idxSlash = key.lastIndexOf('/');
      const fileName = idxSlash === -1 ? key : key.slice(idxSlash + 1);
      const directory = idxSlash === -1 ? '/' : key.slice(0, idxSlash);
      
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
    return [];
  }
}

async function downloadFileContent(bucket, key, maxSize = 500000) {
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3.send(command);
    
    const chunks = [];
    let totalSize = 0;
    
    for await (const chunk of response.Body) {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        break;
      }
      chunks.push(chunk);
    }
    
    const buffer = Buffer.concat(chunks);
    const content = buffer.toString('utf-8');
    
    // Check if it's readable text
    const nonPrintable = content.split('').filter(c => {
      const code = c.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;
    
    if (nonPrintable > content.length * 0.3) {
      return null; // Likely binary
    }
    
    return content.slice(0, 50000); // Limit to 50KB for Claude
  } catch (error) {
    log('error', `Failed to download ${key}: ${error.message}`);
    return null;
  }
}

async function generateSummaryWithClaude(fileName, directory, fileContent, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const contentPreview = fileContent.slice(0, 10000);
      
        const prompt = `You are a domain analyst summarizing one source document for downstream retrieval and decision support.

File: ${fileName}
    Directory: ${directory}

Content:
${contentPreview}

INSTRUCTIONS:
  1. Read the provided text and summarize ONLY what is explicitly present.
  2. Write EXACTLY 5 bullet lines, each starting with "- ".
  3. Every bullet must contain at least one concrete anchor from the text, such as:
       - a date, period, section/article/circular/notification number
       - a named party/authority/court/body
       - a numeric value, threshold, rate, penalty, amount, or count
       - a specific action/outcome (approved/rejected/amended/exempted/liable/etc.)
  4. Start each bullet directly with concrete content from the file. Do NOT start with generic framing like "This document", "The document", "It", or "This appears to be".
    4. Capture these 5 angles in order:
       - Main issue and scope of the document
       - Key decision/change/finding
       - Critical quantitative or legal details (rates, limits, dates, clauses)
       - Applicability (who is affected, from when, conditions/exceptions)
       - Practical impact or compliance consequence
    5. If the text states that earlier circulars/notifications/orders are amended/superseded/withdrawn, mention the exact references and what changed.
    6. If the document is not in English, understand it first and output in English.
    7. If extraction is weak (e.g., scanned PDF), use only visible facts and state this clearly in one bullet with whatever concrete clues are present.

    STRICTLY FORBIDDEN:
    - Generic openers like "This document appears to be" or "The document provides details".
    - Any phrasing that hedges or guesses ("appears", "seems", "likely", "possibly").
    - Vague statements without concrete facts.
    - Invented facts or assumptions.

    OUTPUT FORMAT:
    - Exactly 5 bullet points
    - English only
    - No heading, no preamble, no markdown except the bullet marker
    - Keep each bullet to 1 sentence
    `;

      const message = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 400,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: prompt,
        }],
      });

      const summary = message.content[0].text.trim();
      
      return summary;
    } catch (error) {
      log('error', `Claude API error for summary (attempt ${attempt}/${retries}): ${error.message}`);
      if (error.status) log('error', `  HTTP Status: ${error.status}`);
      
      // Rate limiting - exponential backoff
      if (error.status === 429 && attempt < retries) {
        const waitTime = Math.min(attempt * 15000, 60000); // Max 60s
        log('warn', `⚠️  Rate limited! Waiting ${waitTime/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Other errors - wait before retry
      if (attempt < retries) {
        const waitTime = 8000;
        log('warn', `  Retrying in ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      return 'Error generating summary (API failure after retries)';
    }
  }
}

// Helper function to save summaries to Excel immediately
function saveSummariesToExcel(summaries, excelPath, reportsDir) {
  try {
    const inputFilename = path.basename(excelPath);
    const dateMatch = inputFilename.match(/(\d{8})/);
    const dateStr = dateMatch ? dateMatch[1] : DateTime.now().setZone('Asia/Kolkata').toFormat('yyyyLLdd');
    
    const summaryFilename = `file_summaries_${dateStr}.xlsx`;
    const summaryPath = path.join(reportsDir, summaryFilename);
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(summaries);
    
    ws['!cols'] = [
      { wch: 30 },  // File Name
      { wch: 50 },  // File Directory
      { wch: 120 }, // Summary Generated by LLM
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, 'File Summaries');
    XLSX.writeFile(wb, summaryPath);
    
    return summaryPath;
  } catch (error) {
    log('error', `Failed to save Excel: ${error.message}`);
    return null;
  }
}

async function processBatch(files, startIndex, endIndex, progressFile, excelPath) {
  log('info', `\n========================================`);
  log('info', `Processing batch: Files ${startIndex + 1} to ${endIndex}`);
  log('info', `========================================`);
  
  const reportsDir = path.join(__dirname, 'reports');
  const summaries = [];
  
  // Load existing progress if available
  if (fs.existsSync(progressFile)) {
    try {
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      if (progress.summaries) {
        summaries.push(...progress.summaries);
        log('info', `Loaded ${summaries.length} existing summaries`);
      }
    } catch (err) {
      log('warn', `Could not load progress file: ${err.message}`);
    }
  }
  
  for (let i = startIndex; i < endIndex; i++) {
    const file = files[i];
    const fileNum = i + 1;
    const percentComplete = ((fileNum / files.length) * 100).toFixed(1);
    
    log('info', `\n[${fileNum}/${files.length}] (${percentComplete}%) Processing: ${file.fileName}`);
    log('info', `  Directory: ${file.directory}`);
    log('info', `  Bucket: ${file.bucket}`);
    log('info', `  Size: ${(file.size / 1024).toFixed(2)} KB`);
    
    let summary;
    let skippedReason = null;
    
    // Check if directory should be skipped
    if (shouldSkipDirectory(file.directory)) {
      summary = 'Skipped (excluded directory)';
      skippedReason = `Directory matches exclusion pattern: ${file.directory}`;
      log('warn', `  ⛔ SKIPPED: ${skippedReason}`);
    } else {
      try {
        const content = await downloadFileContent(file.bucket, file.key);
        
        if (!content) {
          summary = 'Binary file or unable to read content';
          skippedReason = 'File is binary or content could not be extracted';
          log('warn', `  ⛔ SKIPPED: ${skippedReason}`);
        } else {
          // Generate summary
          log('debug', `  Calling Claude API for summary...`);
          summary = await generateSummaryWithClaude(file.fileName, file.directory, content);
          log('info', `  ✓ Summary generated successfully`);
          
          // Log memory usage periodically
          if (fileNum % 50 === 0) {
            const memUsage = process.memoryUsage();
            const memMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
            log('info', `  📊 Memory: ${memMB} MB heap used`);
          }
          
          // Base delay before next file (increased to 5s)
          if (i < endIndex - 1) {
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
          
          // Extra cooldown every 20 files to prevent rate limit buildup
          if (fileNum % 20 === 0 && i < endIndex - 1) {
            log('info', `  🕐 Cooldown: Waiting 8s after ${fileNum} files...`);
            await new Promise(resolve => setTimeout(resolve, 8000));
          }
        }
      } catch (error) {
        log('error', `  Error processing file: ${error.message}`);
        summary = `Error: ${error.message}`;
      }
    }
    
    summaries.push({
      'File Name': file.fileName,
      'File Directory': file.directory,
      'Summary Generated by LLM': summary,
    });
    
    // Save to Excel file IMMEDIATELY after each file (crash-safe)
    try {
      const savedPath = saveSummariesToExcel(summaries, excelPath, reportsDir);
      if (savedPath && fileNum % 10 === 0) {
        log('info', `  💾 Excel saved: ${fileNum}/${files.length} files`);
      }
    } catch (err) {
      log('error', `  Failed to save Excel: ${err.message}`);
    }
    
    // Also save progress JSON for tracking
    try {
      fs.writeFileSync(progressFile, JSON.stringify({
        excelPath: excelPath,
        summaries: summaries,
        lastProcessed: fileNum,
        timestamp: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      log('error', `  Failed to save progress JSON: ${err.message}`);
    }
  }
  
  // Save final progress
  try {
    fs.writeFileSync(progressFile, JSON.stringify({
      excelPath: excelPath,
      summaries: summaries,
      lastProcessed: endIndex,
      timestamp: new Date().toISOString()
    }, null, 2));
    log('info', `✓ Batch complete! Progress saved.`);
  } catch (err) {
    log('error', `Failed to save final progress: ${err.message}`);
  }
  
  return summaries;
}

async function sendEmail(summaryFilePath, uploadReportPath) {
  log('info', '\n========================================');
  log('info', '📧 Sending Email');
  log('info', '========================================');
  
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_SERVER,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    // Extract date from filename for subject
    const filename = path.basename(summaryFilePath);
    const dateMatch = filename.match(/(\d{8})/);
    const dateStr = dateMatch ? 
      DateTime.fromFormat(dateMatch[1], 'yyyyLLdd').toFormat('dd LLL yyyy') :
      DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy');

    const subject = `Daily S3 Ingestion Summary — ${dateStr}`;
    const html = `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;">
<tr>
<td align="center">
<table width="800" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;">
<tr>
<td style="padding:20px;background:#2563eb;color:#ffffff;">
<h1 style="margin:0;">📊 Daily S3 Ingestion Summary</h1>
<p style="margin:6px 0 0;">${dateStr}</p>
</td>
</tr>

<tr>
<td style="padding:20px;">
<p>Hello,</p>
<p>Please find attached the daily S3 ingestion reports:</p>
<ul>
<li><b>${path.basename(uploadReportPath)}</b> - Upload statistics and details</li>
<li><b>${path.basename(summaryFilePath)}</b> - AI-generated file summaries</li>
</ul>
<p>All files have been processed successfully.</p>
</td>
</tr>

<tr>
<td style="padding:14px;font-size:12px;color:#64748b;background:#fafafa;">
Sent automatically by NeurasixAI Batch Processing System
</td>
</tr>

</table>
</td>
</tr>
</table>`;

    const info = await transporter.sendMail({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject,
      html,
      attachments: [
        { filename: path.basename(uploadReportPath), path: uploadReportPath },
        { filename: path.basename(summaryFilePath), path: summaryFilePath }
      ],
    });
    
    log('info', `✓ Email sent successfully! Message ID: ${info.messageId}`);
    log('info', `  Recipients: ${TO_EMAIL.join(', ')}`);
    return true;
  } catch (error) {
    log('error', `Failed to send email: ${error.message}`);
    return false;
  }
}

async function main() {
  log('info', '========================================');
  log('info', '🚀 Batch Processing Orchestrator Started');
  log('info', '========================================');
  log('info', `Process ID: ${process.pid}`);
  log('info', `Node version: ${process.version}`);
  log('info', `Platform: ${process.platform}`);
  log('info', `Batch size: ${BATCH_SIZE} files`);
  log('info', `Start time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
  log('info', `Working directory: ${__dirname}`);
  log('info', '========================================');
  
  const startTime = Date.now();
  const reportsDir = path.join(__dirname, 'reports');
  const progressFile = path.join(reportsDir, 'progress_summaries.json');
  
  // Find the most recent daily upload report
  if (!fs.existsSync(reportsDir)) {
    log('error', 'Reports directory not found');
    process.exit(1);
  }
  
  const reportFiles = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('s3_daily_uploads_') && f.endsWith('.xlsx'))
    .sort()
    .reverse();
  
  if (reportFiles.length === 0) {
    log('error', 'No daily upload reports found. Run s3_daily_summary.js first.');
    process.exit(1);
  }
  
  const latestReport = path.join(reportsDir, reportFiles[0]);
  log('info', `Using report: ${reportFiles[0]}`);
  
  // Read all files from Excel
  const files = readFilesFromExcel(latestReport);
  
  if (files.length === 0) {
    log('warn', 'No files to process - creating empty summary report');
    
    // Create empty summary file and send email anyway
    const inputFilename = path.basename(latestReport);
    const dateMatch = inputFilename.match(/(\d{8})/);
    const dateStr = dateMatch ? dateMatch[1] : DateTime.now().setZone('Asia/Kolkata').toFormat('yyyyLLdd');
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, 'File Summaries');
    
    const summaryFilename = `file_summaries_${dateStr}.xlsx`;
    const summaryPath = path.join(reportsDir, summaryFilename);
    XLSX.writeFile(wb, summaryPath);
    
    log('info', `✓ Empty summary report created: ${summaryFilename}`);
    
    // Send email with both attachments
    await sendEmail(summaryPath, latestReport);
    
    log('info', '\n========================================');
    log('info', '✅ PROCESS COMPLETE (0 files processed)');
    log('info', '========================================');
    log('info', `Email sent: Yes`);
    log('info', '========================================');
    return;
  }
  
  log('info', `Total files to process: ${files.length}`);
  const numBatches = Math.ceil(files.length / BATCH_SIZE);
  log('info', `Will process in ${numBatches} batches of ${BATCH_SIZE} files each`);
  log('info', `Estimated time: ${(files.length * 3 / 60).toFixed(1)} minutes (1 API call per file)`);
  
  // Determine summary file path upfront
  const inputFilename = path.basename(latestReport);
  const dateMatch = inputFilename.match(/(\d{8})/);
  const dateStr = dateMatch ? dateMatch[1] : DateTime.now().setZone('Asia/Kolkata').toFormat('yyyyLLdd');
  const summaryFilename = `file_summaries_${dateStr}.xlsx`;
  const summaryPath = path.join(reportsDir, summaryFilename);
  
  // Process all batches with crash protection
  let allSummaries = [];
  let processingError = null;
  
  try {
    for (let batchNum = 0; batchNum < numBatches; batchNum++) {
      const startIndex = batchNum * BATCH_SIZE;
      const endIndex = Math.min(startIndex + BATCH_SIZE, files.length);
      
      log('info', `\n========================================`);
      log('info', `📦 Batch ${batchNum + 1}/${numBatches}`);
      log('info', `========================================`);
      
      allSummaries = await processBatch(files, startIndex, endIndex, progressFile, latestReport);
      
      log('info', `✓ Batch ${batchNum + 1}/${numBatches} complete!`);
      log('info', `Total summaries generated so far: ${allSummaries.length}/${files.length}`);
      
      // Brief pause between batches
      if (batchNum < numBatches - 1) {
        log('info', `Pausing 5 seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    log('info', '\n✅ All batches completed successfully!');
  } catch (error) {
    processingError = error;
    log('error', `\n❌ Processing stopped due to error: ${error.message}`);
    log('warn', `⚠️  Will send email with ${allSummaries.length} summaries generated before crash`);
  }
  
  // ALWAYS try to send email with whatever summaries we have
  log('info', '\n========================================');
  log('info', '📧 Preparing to send email');
  log('info', '========================================');
  
  // Check if Excel file already exists (saved during processing)
  let emailSent = false;
  if (fs.existsSync(summaryPath)) {
    log('info', `✓ Summary file already exists: ${summaryFilename}`);
    log('info', `  Contains ${allSummaries.length} summaries`);
  } else if (allSummaries.length > 0) {
    log('info', '📊 Creating final summary report...');
    try {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(allSummaries);
      
      ws['!cols'] = [
        { wch: 30 },  // File Name
        { wch: 50 },  // File Directory
        { wch: 120 }, // Summary Generated by LLM
      ];
      
      XLSX.utils.book_append_sheet(wb, ws, 'File Summaries');
      XLSX.writeFile(wb, summaryPath);
      log('info', `✓ Summary report created: ${summaryFilename}`);
    } catch (excelError) {
      log('error', `Failed to create Excel: ${excelError.message}`);
    }
  } else {
    log('warn', '⚠️  No summaries to send!');
  }
  
  // Clean up progress file
  if (fs.existsSync(progressFile)) {
    try {
      fs.unlinkSync(progressFile);
      log('info', '✓ Progress file cleaned up');
    } catch (err) {
      log('warn', `Could not delete progress file: ${err.message}`);
    }
  }
  
  // Send email if we have a valid summary file
  if (fs.existsSync(summaryPath)) {
    try {
      emailSent = await sendEmail(summaryPath, latestReport);
      if (!emailSent) {
        log('error', '❌ Email sending returned false');
      }
    } catch (emailError) {
      log('error', `❌ Email sending failed: ${emailError.message}`);
      emailSent = false;
    }
  } else {
    log('error', `❌ Cannot send email - summary file does not exist: ${summaryPath}`);
  }
  
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  
  // Count skipped files
  const skippedFiles = allSummaries.filter(s => 
    s['Summary Generated by LLM'].startsWith('Skipped') || 
    s['Summary Generated by LLM'].startsWith('Binary') ||
    s['Summary Generated by LLM'].startsWith('Error')
  ).length;
  const processedFiles = allSummaries.length - skippedFiles;
  
  log('info', '\n========================================');
  if (processingError) {
    log('warn', '⚠️  PROCESS COMPLETED WITH ERRORS');
    log('warn', `Error: ${processingError.message}`);
  } else {
    log('info', '✅ PROCESS COMPLETE!');
  }
  log('info', '========================================');
  log('info', `Total files in report: ${files.length}`);
  log('info', `Files processed: ${allSummaries.length}/${files.length}`);
  log('info', `Successfully generated summaries: ${processedFiles}`);
  log('info', `Skipped/Failed: ${skippedFiles}`);
  log('info', `Total time: ${totalTime} minutes`);
  log('info', `Email sent: ${emailSent ? 'Yes ✓' : 'No ✗'}`);
  log('info', `End time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
  log('info', '========================================');
  
  // Exit with error code if processing failed but still sent email
  if (processingError && emailSent) {
    log('info', '📧 Email sent successfully despite processing errors');
  } else if (processingError) {
    throw processingError; // Re-throw to trigger catch block
  }
}

// Run the main function
process.on('uncaughtException', (error) => {
  log('error', `\n❌❌❌ UNCAUGHT EXCEPTION ❌❌❌`);
  log('error', `Error: ${error.message}`);
  log('error', `Stack: ${error.stack}`);
  log('error', `Process will attempt to save progress and send email before exiting...`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log('error', `\n❌❌❌ UNHANDLED PROMISE REJECTION ❌❌❌`);
  log('error', `Reason: ${reason}`);
  log('error', `Promise: ${promise}`);
  log('error', `Process will attempt to save progress and send email before exiting...`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('warn', `\n⚠️  Process interrupted by user (Ctrl+C)`);
  log('warn', `Progress has been saved. Run again to resume.`);
  process.exit(130);
});

process.on('SIGTERM', () => {
  log('warn', `\n⚠️  Process terminated by system`);
  log('warn', `Progress has been saved. Run again to resume.`);
  process.exit(143);
});

main().catch(err => {
  log('error', `Fatal error: ${err.message}`);
  log('error', `Stack: ${err.stack}`);
  process.exit(1);
});
