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
const S3_BUCKETS_RAW = process.env.S3_BUCKETS; // e.g. ["rules-repository","bucket2"] or comma-separated

const TO_EMAIL = (process.env.TO_EMAIL || '').split(',').map(e => e.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USERNAME;
const SMTP_SERVER = process.env.SMTP_SERVER || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;

const DRY_RUN = process.argv.includes('--dry');
const ARGV = new Set(process.argv.slice(2));

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  // support --flag=value
  const match = process.argv.find(a => a.startsWith(flag + '='));
  return match ? match.split('=')[1] : undefined;
}

const VERBOSE = ARGV.has('--verbose') || (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
const DEBUG_KEYS = ARGV.has('--debug-keys');
const MAX_PAGES = Number(getArgValue('--max-pages') || process.env.MAX_PAGES || Infinity);

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = VERBOSE ? LOG_LEVELS.debug : LOG_LEVELS.info;
function log(level, msg, ...args) {
  const lvl = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (lvl <= CURRENT_LEVEL) {
    const ts = DateTime.now().setZone('Asia/Kolkata').toFormat('HH:mm:ss');
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${ts}] [${level.toUpperCase()}] ${msg}`, ...args);
  }
}

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  console.error('Missing AWS credentials in .env');
  process.exit(1);
}
if (!FROM_EMAIL || TO_EMAIL.length === 0) {
  console.error('Missing email settings in .env (FROM_EMAIL/TO_EMAIL)');
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
  const todayNoon = nowIST.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  const endIST = todayNoon; // Always end at today's 12 PM IST
  const startIST = endIST.minus({ days: 1 });
  log('info', `Computed IST window: ${startIST.toFormat('dd LLL yyyy, hh:mm a')} -> ${endIST.toFormat('dd LLL yyyy, hh:mm a')} (IST)`);
  return {
    startIST,
    endIST,
    startUTC: startIST.toUTC(),
    endUTC: endIST.toUTC(),
  };
}

async function listAllBuckets() {
  log('info', `Listing all S3 buckets in region ${AWS_REGION}...`);
  const resp = await s3.send(new ListBucketsCommand({}));
  const buckets = (resp.Buckets || []).map(b => b.Name);
  log('info', `Found ${buckets.length} bucket(s).`);
  return buckets;
}

function parseEnvBuckets() {
  if (!S3_BUCKETS_RAW) return null;
  const raw = S3_BUCKETS_RAW.trim();
  try {
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw);
      const list = Array.isArray(arr) ? arr.map(String).map(s => s.trim()).filter(Boolean) : [];
      return list.length ? list : null;
    }
  } catch (e) {
    log('warn', `S3_BUCKETS JSON parse failed, falling back to comma parsing: ${e.message}`);
  }
  const list = raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

async function listBucketUploadsInWindow(bucket, startUTC, endUTC) {
  const uploads = [];
  const folderCounts = new Map(); // folderPath -> count
  let ContinuationToken = undefined;
  let scanned = 0;
  let matches = 0;
  let page = 0;
  let nextMilestone = 1000; // log every 1000 scanned keys

  do {
    if (page >= MAX_PAGES) {
      log('warn', `Bucket ${bucket}: reached MAX_PAGES=${MAX_PAGES}, stopping pagination.`);
      break;
    }
    log('debug', `Bucket ${bucket}: fetching page ${page + 1} with token=${ContinuationToken || 'none'}`);
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken,
      MaxKeys: 2000,
    }));

    const contents = resp.Contents || [];
    log('debug', `Bucket ${bucket}: received ${contents.length} keys on page ${page + 1}`);
    for (const obj of contents) {
      const lm = obj.LastModified; // Date
      if (!lm) continue;
      if (lm >= startUTC.toJSDate() && lm < endUTC.toJSDate()) {
        const key = obj.Key;
        if (!key || key.endsWith('/')) continue; // skip folder markers
        const lastSlash = key.lastIndexOf('/');
        const folder = lastSlash !== -1 ? key.substring(0, lastSlash) : '/';
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
        uploads.push({
          Bucket: bucket,
          Folder: folder,
          Key: key,
          LastModifiedUTC: DateTime.fromJSDate(lm).toUTC().toISO(),
          LastModifiedIST: DateTime.fromJSDate(lm).setZone('Asia/Kolkata').toISO(),
          Size: obj.Size || 0,
        });
        matches++;
        if (DEBUG_KEYS) log('debug', `Match: ${bucket}/${key}`);
      }
      scanned++;
      if (scanned >= nextMilestone) {
        log('info', `Bucket ${bucket}: fetched ${scanned} keys so far...`);
        nextMilestone += 1000;
      }
    }
    // Always show per-page cumulative count similar to listfolders.js
    log('info', `Bucket ${bucket}: fetched ${scanned} keys so far...`);
    log('debug', `Bucket ${bucket}: scanned=${scanned}, matched=${matches}, nextToken=${resp.NextContinuationToken ? 'yes' : 'no'}`);
    ContinuationToken = resp.NextContinuationToken;
    page++;
  } while (ContinuationToken);
  log('info', `Bucket ${bucket}: completed scan. scanned=${scanned}, matched=${matches}`);
  return { uploads, folderCounts, scanned };
}

function buildWorkbook(allUploads, perBucketFolderCounts, windowIST, saveDir) {
  const wb = XLSX.utils.book_new();

  const uploadsSheetData = allUploads.map(u => ({
    Bucket: u.Bucket,
    Folder: u.Folder,
    Key: u.Key,
    'Last Modified (IST)': u.LastModifiedIST,
    'Last Modified (UTC)': u.LastModifiedUTC,
    Size: u.Size,
  }));
  const uploadsSheet = XLSX.utils.json_to_sheet(uploadsSheetData);
  XLSX.utils.book_append_sheet(wb, uploadsSheet, 'Uploads');

  const summaryRows = [];
  for (const [bucket, folderMap] of perBucketFolderCounts.entries()) {
    let bucketTotal = 0;
    const folders = Array.from(folderMap.entries()).sort((a, b) => b[1] - a[1]);
    for (const [folder, count] of folders) {
      summaryRows.push({ Bucket: bucket, Folder: folder, Count: count });
      bucketTotal += count;
    }
    if (folders.length === 0) {
      summaryRows.push({ Bucket: bucket, Folder: '(no uploads)', Count: 0 });
    }
  }
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  const statsSheet = XLSX.utils.json_to_sheet([
    { Metric: 'Window Start (IST)', Value: windowIST.startIST.toISO() },
    { Metric: 'Window End (IST)', Value: windowIST.endIST.toISO() },
    { Metric: 'Total Uploads', Value: allUploads.length },
    { Metric: 'Buckets Scanned', Value: perBucketFolderCounts.size },
  ]);
  XLSX.utils.book_append_sheet(wb, statsSheet, 'Stats');

  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const filename = `s3_daily_uploads_${windowIST.endIST.toFormat('yyyyLLdd')}.xlsx`;
  const outPath = path.join(saveDir, filename);
  XLSX.writeFile(wb, outPath);
  return outPath;
}

function buildHtmlSummary(perBucketFolderCounts, windowIST, totalUploads) {
  // Aggregate top folders across all buckets for quick highlights
  const aggregate = [];
  for (const [bucket, folderMap] of perBucketFolderCounts.entries()) {
    for (const [folder, count] of folderMap.entries()) {
      aggregate.push({ bucket, folder, count });
    }
  }
  const topFolders = aggregate.sort((a, b) => b.count - a.count).slice(0, 10);

  const windowText = `${windowIST.startIST.toFormat('dd LLL yyyy, hh:mm a')} → ${windowIST.endIST.toFormat('dd LLL yyyy, hh:mm a')} IST`;
  const generatedAt = DateTime.now().setZone('Asia/Kolkata').toFormat('dd LLL yyyy, hh:mm a');

  const style = `
    <style>
      body { margin:0; padding:0; background:#f6f8fb; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#0f172a; }
      .container { max-width: 800px; margin: 24px auto; background:#ffffff; border:1px solid #e5e7eb; border-radius: 12px; overflow:hidden; box-shadow: 0 8px 24px rgba(2,6,23,0.06); }
      .header { padding: 20px 24px; background: linear-gradient(90deg,#0ea5e9,#2563eb); color:#fff; }
      .title { margin:0; font-size: 22px; letter-spacing:0.2px; }
      .subtitle { margin:4px 0 0; opacity:0.92; font-size: 14px; }
      .content { padding: 20px 24px; }
      .stats { display:flex; flex-wrap:wrap; gap:12px; margin: 6px 0 14px; }
      .stat { flex:1 1 220px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px 14px; }
      .stat .label { color:#475569; font-size:12px; text-transform:uppercase; letter-spacing:0.6px; }
      .stat .value { margin-top:4px; font-weight:600; font-size:16px; color:#0f172a; }
      .section-title { margin:18px 0 10px; font-size:16px; font-weight:600; color:#0f172a; }
      .pill { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; background:#eff6ff; color:#1e40af; border:1px solid #bfdbfe; }
      .bucket-card { border:1px solid #e5e7eb; border-radius: 10px; margin: 12px 0; }
      .bucket-head { display:flex; justify-content:space-between; align-items:center; padding: 10px 12px; background:#f8fafc; border-bottom:1px solid #e5e7eb; }
      .bucket-name { margin:0; font-size:15px; font-weight:600; color:#0f172a; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align:left; padding:10px 12px; border-bottom: 1px solid #eef2f7; font-size: 13px; }
      th { background:#f9fafb; color:#334155; font-weight:600; }
      tr:nth-child(even) td { background:#fcfdff; }
      .muted { color:#64748b; }
      .footer { padding: 14px 24px; font-size:12px; color:#64748b; background:#fafafa; border-top: 1px solid #e5e7eb; }
    </style>
  `;

  let html = `${style}
  <div class="container">
    <div class="header">
      <h1 class="title">📊 Daily S3 Ingestion Summary</h1>
      <div class="subtitle">Window: ${windowText}</div>
    </div>
    <div class="content">
      <div class="stats">
        <div class="stat"><div class="label">Total Uploads</div><div class="value">${totalUploads}</div></div>
        <div class="stat"><div class="label">Buckets Scanned</div><div class="value">${perBucketFolderCounts.size}</div></div>
        <div class="stat"><div class="label">Generated (IST)</div><div class="value">${generatedAt}</div></div>
      </div>

      <div class="section-title">🏆 Top Folders (by uploads)</div>
      <div class="bucket-card">
        <table>
          <thead><tr><th>Bucket</th><th>Folder</th><th>Uploads</th></tr></thead>
          <tbody>
            ${topFolders.length === 0 ? `<tr><td colspan="3" class="muted">No uploads recorded in this window.</td></tr>` : topFolders.map(tf => `<tr><td>${tf.bucket}</td><td>${tf.folder}</td><td>${tf.count}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="section-title">🗂️ Buckets</div>
  `;

  for (const [bucket, folderMap] of perBucketFolderCounts.entries()) {
    const folders = Array.from(folderMap.entries()).sort((a, b) => b[1] - a[1]);
    const bucketTotal = folders.reduce((acc, [, c]) => acc + c, 0);
    html += `
      <div class="bucket-card">
        <div class="bucket-head">
          <h3 class="bucket-name">🪣 ${bucket}</h3>
          <span class="pill">Total: ${bucketTotal}</span>
        </div>
        <table>
          <thead><tr><th>Folder</th><th>Uploads</th></tr></thead>
          <tbody>
            ${folders.length === 0 ? `<tr><td class="muted">(no uploads)</td><td>0</td></tr>` : folders.map(([folder, count]) => `<tr><td>${folder}</td><td>${count}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  html += `
    </div>
    <div class="footer">
      Sent automatically by NeurasixAI · Attachments include the full XLSX report of all uploads in the window.
    </div>
  </div>
  `;

  return html;
}

async function sendEmail({ subject, html, attachments }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_SERVER,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465, false for 587
    auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
  });

  const info = await transporter.sendMail({
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject,
    html,
    attachments,
  });
  return info;
}

async function main() {
  const windowIST = computeISTWindow();
  log('info', `Window (IST ISO): ${windowIST.startIST.toISO()} -> ${windowIST.endIST.toISO()}`);
  log('info', `Runtime: region=${AWS_REGION}, dryRun=${DRY_RUN}, verbose=${VERBOSE}, debugKeys=${DEBUG_KEYS}`);

  if (DRY_RUN) {
    log('warn', 'Dry run: skipping AWS scan and email send.');
    return;
  }

  let buckets = [];
  try {
    const envBuckets = parseEnvBuckets();
    if (envBuckets) {
      buckets = envBuckets;
      log('info', `Using S3_BUCKETS from .env (${buckets.length}): ${buckets.join(', ')}`);
    } else {
      buckets = await listAllBuckets();
    }
  } catch (err) {
    log('error', `Failed to list buckets: ${err.message}`);
    process.exit(1);
  }

  const perBucketFolderCounts = new Map();
  const allUploads = [];

  for (const bucket of buckets) {
    log('info', `Scanning bucket: ${bucket}`);
    try {
      const { uploads, folderCounts } = await listBucketUploadsInWindow(bucket, windowIST.startUTC, windowIST.endUTC);
      perBucketFolderCounts.set(bucket, folderCounts);
      allUploads.push(...uploads);
      log('info', `Bucket ${bucket}: ${uploads.length} uploads in window.`);
    } catch (err) {
      log('warn', `Bucket ${bucket}: error during scan (${err.message}). Continuing.`);
      perBucketFolderCounts.set(bucket, new Map());
    }
  }

  const reportsDir = path.join(__dirname, 'reports');
  const attachmentPath = buildWorkbook(allUploads, perBucketFolderCounts, windowIST, reportsDir);
  const html = buildHtmlSummary(perBucketFolderCounts, windowIST, allUploads.length);

  const subject = `Daily S3 Ingestion Summary — ${windowIST.endIST.toFormat('dd LLL yyyy')}`;

  try {
    const info = await sendEmail({
      subject,
      html,
      attachments: [
        { filename: path.basename(attachmentPath), path: attachmentPath },
      ],
    });
    log('info', `Email sent: ${info.messageId || 'OK'}`);
  } catch (err) {
    log('error', `Failed to send email: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  log('error', `Unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
