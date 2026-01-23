const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const XLSX = require('xlsx');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

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
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
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
    
    const files = data.map(row => {
      const key = row.Key || '';
      const idx = key.lastIndexOf('/');
      const fileName = idx === -1 ? key : key.slice(idx + 1);
      const directory = idx === -1 ? '/' : key.slice(0, idx);
      
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
    
    // Convert stream to buffer
    const chunks = [];
    let totalSize = 0;
    
    for await (const chunk of response.Body) {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        log('warn', `File too large (>${maxSize} bytes), truncating: ${key}`);
        break;
      }
      chunks.push(chunk);
    }
    
    const buffer = Buffer.concat(chunks);
    
    // Try to convert to text
    const content = buffer.toString('utf-8');
    
    // Check if it's readable text (simple heuristic)
    const nonPrintable = content.split('').filter(c => {
      const code = c.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;
    
    if (nonPrintable > content.length * 0.3) {
      return null; // Likely binary
    }
    
    return content.slice(0, 50000); // Limit to 50KB for Claude
  } catch (error) {
    log('warn', `Failed to download ${key}: ${error.message}`);
    return null;
  }
}

async function generateSummaryWithClaude(fileName, directory, fileContent) {
  try {
    const prompt = `Read the following file content and provide a simple, clear 3-line briefing of what this document is about. Write it in plain human language as if explaining it to a colleague.

File: ${fileName}

Content:
${fileContent.slice(0, 10000)}

Provide EXACTLY 3 lines describing:
1. What this document is about (main topic/subject)
2. Key information or findings in the document
3. Main conclusion, outcome, or purpose

Write naturally and clearly - no technical jargon or metadata descriptions.`;

    const message = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 200,
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: prompt,
      }],
    });

    const summary = message.content[0].text.trim();
    
    // Ensure it's max 3 lines
    const lines = summary.split('\n').filter(l => l.trim());
    const result = lines.slice(0, 3).join('\n');
    
    log('debug', `Summary generated for ${fileName}`);
    return result;
  } catch (error) {
    log('error', `Claude API error for ${fileName}: ${error.message}`);
    if (error.status) log('error', `  Status: ${error.status}`);
    return 'Error generating summary';
  }
}

async function generateFileSummaries(excelReportPath, saveDir) {
  log('info', '========================================');
  log('info', '📄 Starting File Summary Generation');
  log('info', '========================================');
  
  // Read files from the existing Excel report
  const files = readFilesFromExcel(excelReportPath);
  
  if (files.length === 0) {
    log('warn', 'No files to summarize');
    return null;
  }
  
  // Process ALL files (no limit)
  const filesToProcess = files;
  log('info', `Processing all ${files.length} files`);
  
  
  const summaries = [];
  let processed = 0;
  
  for (const file of filesToProcess) {
    processed++;
    log('info', `[${processed}/${filesToProcess.length}] Processing: ${file.fileName}`);
    
    // Download and read file content
    const content = await downloadFileContent(file.bucket, file.key);
    
    let briefing;
    if (!content) {
      briefing = 'Binary file or unable to read content';
      log('warn', `  → Skipped (binary or unreadable)`);
    } else {
      // Generate summary using Claude (one at a time)
      briefing = await generateSummaryWithClaude(file.fileName, file.directory, content);
      log('info', `  → Summary generated`);
      
      // Add delay between requests to avoid rate limits (2 seconds)
      if (processed < filesToProcess.length) {
        log('debug', `  → Waiting 2s before next file...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    summaries.push({
      'File Name': file.fileName,
      'File Directory': file.directory,
      'Briefing by LLM': briefing,
    });
  }
  
  // Create Excel workbook
  log('info', 'Creating Excel workbook with summaries...');
  
  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
  }
  
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(summaries);
  
  // Set column widths
  ws['!cols'] = [
    { wch: 30 },  // File Name
    { wch: 50 },  // File Directory
    { wch: 80 },  // Briefing by LLM
  ];
  
  XLSX.utils.book_append_sheet(wb, ws, 'File Summaries');
  
  // Extract date from the input filename
  const inputFilename = path.basename(excelReportPath);
  const dateMatch = inputFilename.match(/(\d{8})/);
  const dateStr = dateMatch ? dateMatch[1] : DateTime.now().setZone('Asia/Kolkata').toFormat('yyyyLLdd');
  
  const filename = `file_summaries_${dateStr}.xlsx`;
  const outputPath = path.join(saveDir, filename);
  
  XLSX.writeFile(wb, outputPath);
  log('info', `✓ File summaries saved: ${filename}`);
  
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
