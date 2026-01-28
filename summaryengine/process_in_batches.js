#!/usr/bin/env node
/**
 * Batch Processing Orchestrator
 * 
 * This script processes files in batches of 50 using generate_file_summaries.js logic.
 * After each batch of 50 files, it stops and restarts with the next batch.
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

function log(level, msg) {
  const ts = DateTime.now().setZone('Asia/Kolkata').toFormat('HH:mm:ss');
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

// Directories to skip for question generation
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
      
      const prompt = `You are analyzing a legal/financial/regulatory document. Your task is to generate ONE highly specific question about this document's content.

File: ${fileName}

Content:
${contentPreview}

INSTRUCTIONS:
1. If the text is clearly readable and extractable (like the content provided above), generate a highly specific question based on the extracted text.

2. If the file appears to be a scanned PDF or image-based document where text is not extractable, you should still analyze whatever content is visible and generate a highly specific question about what you can perceive from the document.

3. If the document is in a foreign language (non-English), first understand the content in that language, then generate your question IN ENGLISH ONLY about the document's content.

Your question should be:
- HIGHLY SPECIFIC to this particular document
- Focus on key facts, findings, decisions, or conclusions
- Be clear and concise (one sentence)
- Written in English regardless of the document's language
- Answerable by someone who has read this document

Generate ONE specific question only. Do not provide any preamble or explanation.`;

      const message = await anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 150,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: prompt,
        }],
      });

      const question = message.content[0].text.trim();
      const cleanQuestion = question.replace(/^\d+\.\s*/, '').trim();
      
      return cleanQuestion;
    } catch (error) {
      log('error', `Claude API error (attempt ${attempt}/${retries}): ${error.message}`);
      
      // Rate limiting - wait longer before retry
      if (error.status === 429 && attempt < retries) {
        const waitTime = attempt * 10000;
        log('warn', `Rate limited! Waiting ${waitTime/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Other errors - shorter wait before retry
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      
      return 'Error generating question (API failure after retries)';
    }
  }
}

async function processBatch(files, startIndex, endIndex, progressFile, excelPath) {
  log('info', `\n========================================`);
  log('info', `Processing batch: Files ${startIndex + 1} to ${endIndex}`);
  log('info', `========================================`);
  
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
    
    let briefing;
    
    // Check if directory should be skipped
    if (shouldSkipDirectory(file.directory)) {
      briefing = 'Skipped (excluded directory)';
      log('info', `  ⊘ Skipped - directory excluded from question generation`);
    } else {
      try {
        const content = await downloadFileContent(file.bucket, file.key);
        
        if (!content) {
          briefing = 'Binary file or unable to read content';
          log('warn', `  Skipped (binary or unreadable)`);
        } else {
          briefing = await generateSummaryWithClaude(file.fileName, file.directory, content);
          log('info', `  ✓ Question generated successfully`);
          
          // Add delay between requests to avoid rate limits
          if (i < endIndex - 1) {
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      } catch (error) {
        log('error', `  Error processing file: ${error.message}`);
        briefing = `Error: ${error.message}`;
      }
    }
    
    summaries.push({
      'File Name': file.fileName,
      'File Directory': file.directory,
      'Question Generated by LLM': briefing,
    });
    
    // Save progress every 10 files
    if (fileNum % 10 === 0) {
      try {
        fs.writeFileSync(progressFile, JSON.stringify({
          excelPath: excelPath,
          summaries: summaries,
          lastProcessed: fileNum,
          timestamp: new Date().toISOString()
        }, null, 2));
        log('info', `  Progress saved (${fileNum} files)`);
      } catch (err) {
        log('error', `  Failed to save progress: ${err.message}`);
      }
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
  log('info', `Batch size: ${BATCH_SIZE} files`);
  log('info', `Start time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
  
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
    log('warn', 'No files to process');
    return;
  }
  
  log('info', `Total files to process: ${files.length}`);
  const numBatches = Math.ceil(files.length / BATCH_SIZE);
  log('info', `Will process in ${numBatches} batches of ${BATCH_SIZE} files each`);
  log('info', `Estimated time: ${(files.length * 3 / 60).toFixed(1)} minutes`);
  
  // Process all batches
  let allSummaries = [];
  
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
  
  // All batches complete - create final Excel file
  log('info', '\n========================================');
  log('info', '📊 Creating Final Summary Report');
  log('info', '========================================');
  
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(allSummaries);
  
  ws['!cols'] = [
    { wch: 30 },
    { wch: 50 },
    { wch: 100 },
  ];
  
  XLSX.utils.book_append_sheet(wb, ws, 'File Summaries');
  
  const inputFilename = path.basename(latestReport);
  const dateMatch = inputFilename.match(/(\d{8})/);
  const dateStr = dateMatch ? dateMatch[1] : DateTime.now().setZone('Asia/Kolkata').toFormat('yyyyLLdd');
  
  const summaryFilename = `file_summaries_${dateStr}.xlsx`;
  const summaryPath = path.join(reportsDir, summaryFilename);
  
  XLSX.writeFile(wb, summaryPath);
  log('info', `✓ Summary report created: ${summaryFilename}`);
  
  // Clean up progress file
  if (fs.existsSync(progressFile)) {
    try {
      fs.unlinkSync(progressFile);
      log('info', '✓ Progress file cleaned up');
    } catch (err) {
      log('warn', `Could not delete progress file: ${err.message}`);
    }
  }
  
  // Send email with both attachments
  const emailSent = await sendEmail(summaryPath, latestReport);
  
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  
  log('info', '\n========================================');
  log('info', '✅ PROCESS COMPLETE!');
  log('info', '========================================');
  log('info', `Total files processed: ${allSummaries.length}`);
  log('info', `Total time: ${totalTime} minutes`);
  log('info', `Email sent: ${emailSent ? 'Yes' : 'No'}`);
  log('info', `End time: ${DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, HH:mm:ss')}`);
  log('info', '========================================');
}

// Run the main function
main().catch(err => {
  log('error', `Fatal error: ${err.message}`);
  log('error', `Stack: ${err.stack}`);
  process.exit(1);
});
