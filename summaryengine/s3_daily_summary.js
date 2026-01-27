const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const { S3Client, ListBucketsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_BUCKETS_RAW = process.env.S3_BUCKETS;

function parseEnvEmails(raw) {
  if (!raw) return [];
  const cleaned = String(raw).trim();
  // Prefer JSON array if provided, e.g. ["a@x.com","b@y.com"]
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
      // Fallback: strip brackets and treat as CSV
      const withoutBrackets = cleaned.replace(/^\[/, '').replace(/\]$/, '');
      return withoutBrackets
        .split(',')
        .map(e => e.replace(/^['"]|['"]$/g, '').trim())
        .filter(Boolean);
    }
  }
  // Default: CSV string
  return cleaned
    .split(',')
    .map(e => e.replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

const TO_EMAIL = parseEnvEmails(process.env.TO_EMAIL || '');

const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USERNAME;
const SMTP_SERVER = process.env.SMTP_SERVER || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;

const DRY_RUN = process.argv.includes('--dry');
const ARGV = new Set(process.argv.slice(2));
const VERBOSE = ARGV.has('--verbose');

function log(level, msg) {
  if (VERBOSE || level !== 'debug') {
    const ts = DateTime.now().setZone('Asia/Kolkata').toFormat('HH:mm:ss');
    const memUsage = process.memoryUsage();
    const memMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
    console.log(`[${ts}] [${level.toUpperCase()}] [MEM: ${memMB}MB] ${msg}`);
  }
}

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  console.error('Missing AWS credentials');
  process.exit(1);
}

if (!FROM_EMAIL || TO_EMAIL.length === 0) {
  console.error('Missing email settings');
  process.exit(1);
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

function computeISTWindow() {
  const nowIST = DateTime.now().setZone('Asia/Kolkata');
  const endIST = nowIST.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  const startIST = endIST.minus({ days: 1 });

  return {
    startIST,
    endIST,
    startUTC: startIST.toUTC(),
    endUTC: endIST.toUTC(),
  };
}

function parseEnvBuckets() {
  if (!S3_BUCKETS_RAW) return null;
  try {
    if (S3_BUCKETS_RAW.trim().startsWith('[')) {
      return JSON.parse(S3_BUCKETS_RAW);
    }
  } catch {}
  return S3_BUCKETS_RAW.split(',').map(b => b.trim()).filter(Boolean);
}

async function listAllBuckets() {
  try {
    log('info', 'Fetching list of all buckets...');
    const resp = await s3.send(new ListBucketsCommand({}));
    const buckets = (resp.Buckets || []).map(b => b.Name);
    log('info', `Found ${buckets.length} bucket(s): ${buckets.join(', ')}`);
    return buckets;
  } catch (error) {
    log('error', `Failed to list buckets: ${error.message}`);
    throw error;
  }
}

async function listBucketUploadsInWindow(bucket, startUTC, endUTC) {
  const uploads = [];
  const folderCounts = new Map();
  let token;
  let totalScanned = 0;
  let batchCount = 0;
  const startTime = Date.now();

  try {
    do {
      batchCount++;
      log('debug', `[${bucket}] Fetching batch ${batchCount} (continuation: ${token ? 'yes' : 'no'})...`);
      
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
        MaxKeys: 1000,
      }));

      const batchSize = (resp.Contents || []).length;
      totalScanned += batchSize;
      
      log('info', `[${bucket}] Batch ${batchCount}: Scanned ${batchSize} objects | Total scanned: ${totalScanned}`);

      for (const obj of resp.Contents || []) {
        if (!obj.LastModified) continue;
        if (obj.LastModified >= startUTC.toJSDate() && obj.LastModified < endUTC.toJSDate()) {
          if (!obj.Key || obj.Key.endsWith('/')) continue;
          
          // Only include PDF files
          if (!obj.Key.toLowerCase().endsWith('.pdf')) continue;
          
          const idx = obj.Key.lastIndexOf('/');
          const folder = idx === -1 ? '/' : obj.Key.slice(0, idx);
          folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
          uploads.push(obj);
        }
      }

      token = resp.NextContinuationToken;
      
      if (token) {
        log('debug', `[${bucket}] More data available, continuing...`);
      } else {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        log('info', `[${bucket}] Scan complete! Total objects scanned: ${totalScanned} in ${elapsed}s`);
      }
    } while (token);

    return { uploads, folderCounts };
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log('error', `[${bucket}] Error after scanning ${totalScanned} objects in ${elapsed}s`);
    log('error', `[${bucket}] Error details: ${error.message}`);
    if (error.Code) log('error', `[${bucket}] AWS Error Code: ${error.Code}`);
    if (error.$metadata) {
      log('error', `[${bucket}] HTTP Status: ${error.$metadata.httpStatusCode}`);
      log('error', `[${bucket}] Request ID: ${error.$metadata.requestId}`);
    }
    throw error;
  }
}

function buildWorkbook(allUploads, perBucketFolderCounts, windowIST, saveDir) {
  try {
    log('info', `Building Excel workbook with ${allUploads.length} upload records...`);
    const wb = XLSX.utils.book_new();

    const uploadRows = allUploads.map(u => ({
      Bucket: u.Bucket,
      Key: u.Key,
      Size: u.Size,
    }));

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(uploadRows), 'Uploads');

    if (!fs.existsSync(saveDir)) {
      log('debug', `Creating reports directory: ${saveDir}`);
      fs.mkdirSync(saveDir, { recursive: true });
    }

    const filename = `s3_daily_uploads_${windowIST.endIST.toFormat('yyyyLLdd')}.xlsx`;
    const out = path.join(saveDir, filename);
    
    log('debug', `Writing workbook to: ${out}`);
    XLSX.writeFile(wb, out);
    log('info', `Excel workbook created successfully: ${filename}`);
    return out;
  } catch (error) {
    log('error', `Failed to build workbook: ${error.message}`);
    throw error;
  }
}

/* ===========================
   FOLDER PATH PARSING
   =========================== */
function parseCaseType(folderPath) {
  const firstFolder = folderPath.split('/')[0];
  
  if (firstFolder.includes('Direct-Taxes') || firstFolder.includes('Direct-Tax')) {
    return 'Direct Tax Cases';
  } else if (firstFolder.includes('Indirect-Taxes') || firstFolder.includes('Indirect-Tax')) {
    return 'Indirect Tax Cases';
  } else if (firstFolder.includes('commercial')) {
    return 'Commercial Cases';
  }
  
  // Default fallback
  return firstFolder || 'Other Cases';
}

function extractCountry(folderPath) {
  const parts = folderPath.split('/').filter(Boolean);
  
  // Country is the second folder (index 1)
  if (parts.length > 1) {
    return parts[1];
  }
  
  return 'Unknown';
}

function extractCourtAuthority(folderPath) {
  const parts = folderPath.split('/').filter(Boolean);
  
  // Skip first folder (case type) and second folder (country)
  const relevantParts = parts.slice(2);
  
  if (relevantParts.length === 0) {
    return 'General';
  }
  
  // Join remaining parts with ' – ' (en dash)
  return relevantParts.join(' – ');
}

function buildDetailedSummaryTable(perBucketFolderCounts) {
  const data = [];
  
  // Collect all folder data from all buckets
  for (const [bucket, folderMap] of perBucketFolderCounts.entries()) {
    for (const [folder, count] of folderMap.entries()) {
      if (folder === '/') continue; // Skip root folder
      
      const caseType = parseCaseType(folder);
      const country = extractCountry(folder);
      const courtAuthority = extractCourtAuthority(folder);
      
      data.push({
        caseType,
        country,
        courtAuthority,
        count
      });
    }
  }
  
  // Sort by case type, then country, then court authority
  data.sort((a, b) => {
    if (a.caseType !== b.caseType) {
      return a.caseType.localeCompare(b.caseType);
    }
    if (a.country !== b.country) {
      return a.country.localeCompare(b.country);
    }
    return a.courtAuthority.localeCompare(b.courtAuthority);
  });
  
  return data;
}

function buildHighLevelSummary(detailedData) {
  const summary = new Map();
  
  for (const item of detailedData) {
    const current = summary.get(item.caseType) || 0;
    summary.set(item.caseType, current + item.count);
  }
  
  // Convert to array and sort by case type
  return [...summary.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([caseType, total]) => ({ caseType, total }));
}

/* ===========================
   EMAIL SAFE HTML
   =========================== */
function buildHtmlSummary(perBucketFolderCounts, windowIST, totalUploads) {
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const windowText = `${windowIST.startIST.toFormat('dd LLL yyyy, hh:mm a')} → ${windowIST.endIST.toFormat('dd LLL yyyy, hh:mm a')} IST`;
  const generatedAt = DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, hh:mm a');

  // Generate business-friendly summaries
  const detailedData = buildDetailedSummaryTable(perBucketFolderCounts);
  const highLevelData = buildHighLevelSummary(detailedData);

  // Build High-Level Summary Table (Case Type → Total Files)
  let highLevelRows = '';
  for (const item of highLevelData) {
    highLevelRows += `
      <tr>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(item.caseType)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${item.total}</td>
      </tr>`;
  }

  const highLevelTable = `
    <h2 style="margin-top:24px;color:#1e40af;">📈 High-Level Summary</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <th style="padding:10px;border:1px solid #e5e7eb;background:#1e40af;color:#ffffff;text-align:left;">Case Type</th>
        <th style="padding:10px;border:1px solid #e5e7eb;background:#1e40af;color:#ffffff;text-align:right;">Total Files</th>
      </tr>
      ${highLevelRows || `<tr><td colspan="2" style="padding:8px;">No data</td></tr>`}
    </table>`;

  // Build Detailed Summary Table (Case Type → Country → Court/Authority → Files)
  let detailedRows = '';
  for (const item of detailedData) {
    detailedRows += `
      <tr>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(item.caseType)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(item.country)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(item.courtAuthority)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${item.count}</td>
      </tr>`;
  }

  const detailedTable = `
    <h2 style="margin-top:32px;color:#1e40af;">📋 Detailed Summary</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <th style="padding:10px;border:1px solid #e5e7eb;background:#1e40af;color:#ffffff;text-align:left;">Case Type</th>
        <th style="padding:10px;border:1px solid #e5e7eb;background:#1e40af;color:#ffffff;text-align:left;">Country</th>
        <th style="padding:10px;border:1px solid #e5e7eb;background:#1e40af;color:#ffffff;text-align:left;">Court / Authority</th>
        <th style="padding:10px;border:1px solid #e5e7eb;background:#1e40af;color:#ffffff;text-align:right;">No. of Files</th>
      </tr>
      ${detailedRows || `<tr><td colspan="4" style="padding:8px;">No data</td></tr>`}
    </table>`;

  let bucketSections = '';
  for (const [bucket, folderMap] of perBucketFolderCounts.entries()) {
    let rows = '';
    let total = 0;
    const sorted = [...folderMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [folder, count] of sorted) {
      total += count;
      rows += `
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(folder === '/' ? '/' : folder + '/')}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${count}</td>
        </tr>`;
    }

    bucketSections += `
      <h3 style="margin-top:24px;">🪣 ${bucket} (Total: ${total})</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <th style="padding:8px;border:1px solid #e5e7eb;background:#f1f5f9;">Folder</th>
          <th style="padding:8px;border:1px solid #e5e7eb;background:#f1f5f9;">Uploads</th>
        </tr>
        ${rows || `<tr><td colspan="2" style="padding:8px;">No uploads</td></tr>`}
      </table>`;
  }

  return `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;">
<tr>
<td align="center">
<table width="800" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;">
<tr>
<td style="padding:20px;background:#2563eb;color:#ffffff;">
<h1 style="margin:0;">📊 Daily S3 Ingestion Summary</h1>
<p style="margin:6px 0 0;">Window: ${windowText}</p>
</td>
</tr>

<tr>
<td style="padding:20px;">
<p><b>Total Uploads:</b> ${totalUploads}</p>
<p><b>Buckets Scanned:</b> ${perBucketFolderCounts.size}</p>
<p><b>Generated (IST):</b> ${generatedAt}</p>

<!-- Business-Friendly Summary Tables -->
${highLevelTable}
${detailedTable}

<!-- Original Per-bucket summaries below -->
<h2 style="margin-top:32px;color:#1e40af;">🪣 Bucket-wise Raw Folder Counts</h2>
${bucketSections}

</td>
</tr>

<tr>
<td style="padding:14px;font-size:12px;color:#64748b;background:#fafafa;">
Sent automatically by NeurasixAI · XLSX report attached.
</td>
</tr>

</table>
</td>
</tr>
</table>`;
}

async function sendEmail({ subject, html, attachments }) {
  try {
    log('info', `Preparing to send email to ${TO_EMAIL.length} recipient(s)...`);
    log('debug', `Recipients: ${TO_EMAIL.join(', ')}`);
    
    const transporter = nodemailer.createTransport({
      host: SMTP_SERVER,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    log('info', 'Sending email...');
    const info = await transporter.sendMail({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject,
      html,
      attachments,
    });
    
    log('info', `Email sent successfully! Message ID: ${info.messageId}`);
    return info;
  } catch (error) {
    log('error', `Failed to send email: ${error.message}`);
    if (error.code) log('error', `Error code: ${error.code}`);
    throw error;
  }
}

async function main() {
  log('info', '========================================');
  log('info', '🚀 Starting S3 Daily Summary Process');
  log('info', '========================================');
  
  const startTime = Date.now();
  
  try {
    const windowIST = computeISTWindow();
    log('info', `Window (IST): ${windowIST.startIST.toFormat('dd LLL yyyy, hh:mm a')} → ${windowIST.endIST.toFormat('dd LLL yyyy, hh:mm a')}`);
    log('info', `Window (UTC): ${windowIST.startUTC.toFormat('dd LLL yyyy, hh:mm a')} → ${windowIST.endUTC.toFormat('dd LLL yyyy, hh:mm a')}`);
    
    const buckets = parseEnvBuckets() || await listAllBuckets();
    log('info', `Buckets to scan: ${buckets.length} (${buckets.join(', ')})`);

    const perBucketFolderCounts = new Map();
    const allUploads = [];
    let totalErrors = 0;

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      log('info', `\n[${i + 1}/${buckets.length}] Scanning bucket: ${bucket}`);
      
      try {
        const { uploads, folderCounts } =
          await listBucketUploadsInWindow(bucket, windowIST.startUTC, windowIST.endUTC);
        perBucketFolderCounts.set(bucket, folderCounts);
        allUploads.push(...uploads.map(u => ({ ...u, Bucket: bucket })));

        const folderCount = folderCounts.size;
        const uploadCount = uploads.length;
        log('info', `✓ [${bucket}] Summary: ${uploadCount} uploads across ${folderCount} folder(s)`);

        if (folderCount > 0) {
          const top5 = [...folderCounts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 5)
            .map(([f, c]) => `${f === '/' ? '/' : f + '/'}: ${c}`)
            .join(' | ');
          log('info', `  Top folders: ${top5}`);
        }
      } catch (error) {
        totalErrors++;
        log('error', `✗ [${bucket}] Failed to scan bucket`);
        log('error', `  Error: ${error.message}`);
        // Continue with other buckets
      }
    }

    log('info', '\n========================================');
    log('info', '📊 Scan Summary');
    log('info', '========================================');
    log('info', `Total uploads found: ${allUploads.length}`);
    log('info', `Buckets successfully scanned: ${perBucketFolderCounts.size}/${buckets.length}`);
    if (totalErrors > 0) {
      log('warn', `Buckets with errors: ${totalErrors}`);
    }

    if (allUploads.length === 0) {
      log('warn', 'No uploads found in the specified time window!');
      log('info', 'Skipping report generation and email.');
      return;
    }

    const reportsDir = path.join(__dirname, 'reports');
    const attachmentPath = buildWorkbook(allUploads, perBucketFolderCounts, windowIST, reportsDir);

    log('info', '\n========================================');
    log('info', '🤖 Generating File Summaries with Claude AI');
    log('info', '========================================');
    log('info', `Input file: ${path.basename(attachmentPath)}`);
    
    let summaryAttachmentPath = null;
    try {
      // Lazy load the module only when needed (after S3 scanning is done)
      const { generateFileSummaries } = require('./generate_file_summaries');
      log('info', 'Module loaded, starting summary generation...');
      log('warn', 'This may take a while for large datasets!');
      
      const summaryStartTime = Date.now();
      summaryAttachmentPath = await generateFileSummaries(attachmentPath, reportsDir);
      const summaryTime = ((Date.now() - summaryStartTime) / 1000 / 60).toFixed(1);
      
      if (summaryAttachmentPath) {
        log('info', `✓ File summaries generated successfully in ${summaryTime} minutes`);
        log('info', `Output: ${path.basename(summaryAttachmentPath)}`);
      } else {
        log('warn', 'File summaries generation returned null');
      }
    } catch (error) {
      log('error', `Failed to generate file summaries: ${error.message}`);
      log('error', `Stack trace: ${error.stack}`);
      log('warn', 'Continuing without file summaries attachment');
      log('info', 'You can retry by running: node generate_file_summaries.js');
    }

    log('info', '\nGenerating HTML summary...');
    const html = buildHtmlSummary(perBucketFolderCounts, windowIST, allUploads.length);
    log('info', 'HTML summary generated successfully');

    const subject = `Daily S3 Ingestion Summary — ${windowIST.endIST.toFormat('dd LLL yyyy')}`;

    if (DRY_RUN) {
      log('info', '\n========================================');
      log('info', '🔍 DRY RUN MODE - No email will be sent');
      log('info', '========================================');
      log('info', `Subject: ${subject}`);
      log('info', `Recipients: ${TO_EMAIL.join(', ')}`);
      log('info', `Attachment: ${path.basename(attachmentPath)}`);
      if (summaryAttachmentPath) {
        log('info', `Attachment: ${path.basename(summaryAttachmentPath)}`);
      }
      return;
    }

    log('info', '\n========================================');
    log('info', '📧 Sending Email');
    log('info', '========================================');
    
    // Prepare attachments array
    const attachments = [
      { filename: path.basename(attachmentPath), path: attachmentPath }
    ];
    
    // Add file summaries if available
    if (summaryAttachmentPath) {
      attachments.push({ 
        filename: path.basename(summaryAttachmentPath), 
        path: summaryAttachmentPath 
      });
    }
    
    await sendEmail({
      subject,
      html,
      attachments,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log('info', '\n========================================');
    log('info', `✅ Process completed successfully in ${elapsed}s`);
    log('info', '========================================');
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log('error', '\n========================================');
    log('error', `❌ Process failed after ${elapsed}s`);
    log('error', '========================================');
    log('error', `Fatal error: ${error.message}`);
    log('error', `Stack trace:\n${error.stack}`);
    throw error;
  }
}

main().catch(err => {
  // Error already logged in main()
  log('error', '\nExiting with error code 1');
  process.exit(1);
});
