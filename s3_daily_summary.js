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

const TO_EMAIL = (process.env.TO_EMAIL || '')
  .split(',')
  .map(e => e.replace(/^["']|["']$/g, '').trim())
  .filter(Boolean);

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
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
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
  const resp = await s3.send(new ListBucketsCommand({}));
  return (resp.Buckets || []).map(b => b.Name);
}

async function listBucketUploadsInWindow(bucket, startUTC, endUTC) {
  const uploads = [];
  const folderCounts = new Map();
  let token;

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));

    for (const obj of resp.Contents || []) {
      if (!obj.LastModified) continue;
      if (obj.LastModified >= startUTC.toJSDate() && obj.LastModified < endUTC.toJSDate()) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        const idx = obj.Key.lastIndexOf('/');
        const folder = idx === -1 ? '/' : obj.Key.slice(0, idx);
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
        uploads.push(obj);
      }
    }

    token = resp.NextContinuationToken;
  } while (token);

  return { uploads, folderCounts };
}

function buildWorkbook(allUploads, perBucketFolderCounts, windowIST, saveDir) {
  const wb = XLSX.utils.book_new();

  const uploadRows = allUploads.map(u => ({
    Bucket: u.Bucket,
    Key: u.Key,
    Size: u.Size,
  }));

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(uploadRows), 'Uploads');

  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  const filename = `s3_daily_uploads_${windowIST.endIST.toFormat('yyyyLLdd')}.xlsx`;
  const out = path.join(saveDir, filename);
  XLSX.writeFile(wb, out);
  return out;
}

/* ===========================
   EMAIL SAFE HTML
   =========================== */
function buildHtmlSummary(perBucketFolderCounts, windowIST, totalUploads) {
  const windowText = `${windowIST.startIST.toFormat('dd LLL yyyy, hh:mm a')} → ${windowIST.endIST.toFormat('dd LLL yyyy, hh:mm a')} IST`;
  const generatedAt = DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, hh:mm a');

  let topRows = '';
  for (const [bucket, folderMap] of perBucketFolderCounts.entries()) {
    for (const [folder, count] of folderMap.entries()) {
      topRows += `
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;">${bucket}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${folder}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${count}</td>
        </tr>`;
    }
  }

  let bucketSections = '';
  for (const [bucket, folderMap] of perBucketFolderCounts.entries()) {
    let rows = '';
    let total = 0;
    for (const [folder, count] of folderMap.entries()) {
      total += count;
      rows += `
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;">${folder}</td>
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

<h3>🏆 Top Folders</h3>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr>
<th style="padding:8px;border:1px solid #e5e7eb;background:#f1f5f9;">Bucket</th>
<th style="padding:8px;border:1px solid #e5e7eb;background:#f1f5f9;">Folder</th>
<th style="padding:8px;border:1px solid #e5e7eb;background:#f1f5f9;">Uploads</th>
</tr>
${topRows || `<tr><td colspan="3" style="padding:8px;">No uploads</td></tr>`}
</table>

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
  const transporter = nodemailer.createTransport({
    host: SMTP_SERVER,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
  });

  return transporter.sendMail({
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject,
    html,
    attachments,
  });
}

async function main() {
  const windowIST = computeISTWindow();
  const buckets = parseEnvBuckets() || await listAllBuckets();

  const perBucketFolderCounts = new Map();
  const allUploads = [];

  for (const bucket of buckets) {
    const { uploads, folderCounts } =
      await listBucketUploadsInWindow(bucket, windowIST.startUTC, windowIST.endUTC);
    perBucketFolderCounts.set(bucket, folderCounts);
    allUploads.push(...uploads.map(u => ({ ...u, Bucket: bucket })));
  }

  const reportsDir = path.join(__dirname, 'reports');
  const attachmentPath = buildWorkbook(allUploads, perBucketFolderCounts, windowIST, reportsDir);
  const html = buildHtmlSummary(perBucketFolderCounts, windowIST, allUploads.length);

  await sendEmail({
    subject: `Daily S3 Ingestion Summary — ${windowIST.endIST.toFormat('dd LLL yyyy')}`,
    html,
    attachments: [{ filename: path.basename(attachmentPath), path: attachmentPath }],
  });

  log('info', 'Email sent successfully');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
