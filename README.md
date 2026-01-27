# NeurasixAI Data Ingestion Summary System v2.0

## 🎯 Overview

Automated system that scans S3 buckets, generates summaries of uploaded PDF files using Claude AI, and emails daily reports.

**Version 2.0 Features:**
- ✅ Comprehensive logging with memory tracking
- ✅ Automatic progress saving (every 10 files)
- ✅ Resume capability after crashes
- ✅ Better error handling and retries
- ✅ Progress visualization and ETAs
- ✅ Performance statistics
- ✅ Log analysis tools

---

## 📁 Files

### Core Scripts
- **s3_daily_summary.js** - Main script: scans S3 and triggers summary generation
- **generate_file_summaries.js** - AI summarization with Claude API
- **resume_summaries.js** - Tool to check/resume/clean progress
- **analyze_logs.js** - Analyze log files from crashed runs

### Configuration
- **.env** - Environment variables (AWS, Claude API, email settings)
- **package.json** - Dependencies

### Documentation
- **SOLUTION_SUMMARY.md** - Overview of v2.0 improvements
- **TROUBLESHOOTING.md** - Complete troubleshooting guide
- **LOG_REFERENCE.md** - Quick reference for log analysis
- **README.md** - This file

---

## 🚀 Quick Start

### Installation
```bash
npm install
```

### Configuration
Create `.env` file with:
```env
# AWS Credentials
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key_here
AWS_SECRET_ACCESS_KEY=your_secret_here
S3_BUCKETS=["bucket1","bucket2"]

# Claude AI
CLAUDE_API_KEY=your_claude_key_here

# Email Settings
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your_email@gmail.com
SMTP_PASSWORD=your_app_password
FROM_EMAIL=your_email@gmail.com
TO_EMAIL=["recipient1@email.com","recipient2@email.com"]
```

### Running

#### Normal Run (RECOMMENDED - with error protection)
```bash
# Windows
run_with_gc.bat s3_daily_summary.js

# Linux/Mac/EC2
chmod +x run_with_gc.sh
./run_with_gc.sh s3_daily_summary.js
```

#### Alternative (basic run)
```bash
node s3_daily_summary.js
```

#### Dry Run (no email)
```bash
run_with_gc.bat s3_daily_summary.js --dry
# OR
node s3_daily_summary.js --dry
```

#### Verbose Logging
```bash
run_with_gc.bat s3_daily_summary.js --verbose
# OR
node s3_daily_summary.js --verbose
```

---

## 🔄 Recovery Commands

### Check Progress Status
```bash
node resume_summaries.js status
```
Shows:
- How many files processed
- How many remain
- Estimated time to complete
- Progress bar

### Resume After Crash
```bash
# Windows
run_with_gc.bat resume_summaries.js resume

# Linux/Mac/EC2
./run_with_gc.sh resume_summaries.js resume
```
Continues from last checkpoint (no re-processing).

### Start Fresh
```bash
node resume_summaries.js clean
```
Deletes progress file to start over.

### Analyze Old Logs
```bash
node analyze_logs.js output.log
```
Analyzes a log file to identify crash causes.

---

## 📊 Understanding the Logs

### Progress Bar
```
[========================================] 58.2%
[814/1400] Processing: document.pdf
  Bucket: my-bucket
  Path: taxes/india/supreme-court/document.pdf
  Size: 245.67 KB
  ETA: 24.5 minutes
```

### Memory Tracking
```
[12:34:56] [INFO] [MEM: 245.67MB] Processing file 115/1400
```
Watch for memory growing above 1GB.

### Statistics (Every 25 files)
```
📊 Statistics:
   Processed: 125/1400
   API calls: 120, Avg time: 1250ms
   Downloads: 125, Avg time: 450ms
   Skipped: 3, Errors: 2
   Elapsed: 5.2 min
```

### Error Handling
```
[ERROR] Claude API error (attempt 1/3): Rate limit exceeded
[WARN] Rate limited! Waiting 10s before retry...
```
Errors are automatically retried with exponential backoff.

---

## 🛠️ Key Features

### Automatic Progress Saving
- Saves every 10 files to `reports/progress_summaries.json`
- Maximum data loss: 9 files (between checkpoints)
- Resume automatically after crashes

### Smart Error Handling
- **3 retry attempts** per file with delays
- Rate limit handling (429 errors) with 10s, 20s, 30s waits
- Individual file errors don't crash the whole process
- Graceful degradation

### Performance Monitoring
- Memory usage tracked on every log line
- API call timing and averages
- Download timing and averages
- ETA calculations
- Progress percentages

### Log Levels
- **INFO**: Normal operations, progress updates
- **WARN**: Handled issues (skipped files, rate limits)
- **ERROR**: Failures with retry/recovery
- **DEBUG**: Detailed technical info (use `--verbose`)

---

## ⏱️ Time Estimates

| Files | Estimated Time |
|-------|----------------|
| 100   | ~4 minutes     |
| 500   | ~21 minutes    |
| 1000  | ~42 minutes    |
| 1400  | ~58 minutes    |

*Based on 2.5 seconds per file (includes 3s delay between API calls)*

---Process stops after 100-120 files with NO errors
**Solution**: This was a **critical bug** - unhandled promise rejections causing silent exits.

**FIXED IN v2.0:**
- Added global error handlers
- Added API timeout protection (60s)
- Added forced garbage collection
- Must use `run_with_gc.bat` or `run_with_gc.sh`

See **SILENT_EXIT_FIX.md** for complete details.

### 

## 🚨 Common Issues

### "Rate limit exceeded" (429 errors)
**Solution**: Automatically handled with retries. Normal and expected.

### "Authentication error" (401)
**Solution**: Check `CLAUDE_API_KEY` in `.env` file.

### Memory growing above 1GB
**Solution**: Monitor with `[MEM: XXX MB]` in logs. Contact support if >1.5GB.

### Process killed by timeout
**Solution**: Use `screen` or `tmux` on EC2 to keep process running.

---

## 📦 Output Files

After successful run:
```
reports/
├── s3_daily_uploads_YYYYMMDD.xlsx      # S3 scan results
├── file_summaries_YYYYMMDD.xlsx        # AI summaries
└── progress_summaries.json             # Deleted when complete
```

If crashed (resumable):
```
reports/
├── s3_daily_uploads_YYYYMMDD.xlsx      
└── progress_summaries.json             # Resume from here!
```

---

## 🎯 Workflow

1. **S3 Scan**: Lists all PDF files uploaded in 24-hour window
2. **Excel Generation**: Creates report of uploaded files
3. **AI Summarization**: Downloads each PDF, sends to Claude for summary
4. **Progress Saving**: Saves every 10 files
5. **Email Report**: Sends Excel files via email

---

## 🔍 Debugging

### If it crashes:

1. **Check the last few log lines** to see the error
2. **Check progress**: `node resume_summaries.js status`
3. **Analyze logs**: `node analyze_logs.js yourlog.log`
4. **Resume**: `node resume_summaries.js resume`

### If it's slow:

- Check API timing in statistics (should be 800-2000ms)
- Check download timing (should be 200-1000ms)
- Rate limiting adds delays (normal)

### If errors are high:

- Check error messages in logs
- Most files skipped? May be binary/unreadable
- API errors? Check Claude API key and quota

---

## 🆘 Emergency Commands

```bash
# Check if process is running
ps aux | grep node

# Kill hung process
pkill -9 node

# Check disk space
df -h

# Check memory usage
free -h

# View recent log output
tail -100 output.log

# Search for errors in logs
grep ERROR output.log | tail -20
```

---

## 📈 Best Practices

### Running on EC2

Use `screen` or `tmux` to keep process running if connection drops:

```bash
# Start screen session
screen -S summary

# Run the script
node s3_daily_summary.js

# Detach: Press Ctrl+A, then D

# Reattach later
screen -r summary
```

### Saving Logs

```bash
# Save all output to file
node s3_daily_summary.js 2>&1 | tee summary_$(date +%Y%m%d_%H%M%S).log
```

### Monitoring Progress

```bash
# In another terminal, watch progress
watch -n 5 'tail -20 summary.log'
```

---

## 🔧 Advanced Options

### Environment Variables

```env
# Change delay between API calls (milliseconds)
API_DELAY=3000

# Change max retries per file
MAX_RETRIES=3

# Change checkpoint frequency (files)
CHECKPOINT_EVERY=10
```

Note: These are hardcoded in v2.0 but can be made configurable.

---

## 📞 Support

For issues:
1. Check **TROUBLESHOOTING.md** for detailed solutions
2. Check **LOG_REFERENCE.md** for log interpretation
3. Use **analyze_logs.js** to diagnose crashes
4. Use **resume_summaries.js** to recover progress

---

## 🎉 Version History

### v2.0 (Current)
- Added comprehensive logging with memory tracking
- Added automatic progress saving every 10 files
- Added resume capability after crashes
- Added retry logic with exponential backoff
- Added progress visualization and ETAs
- Added performance statistics tracking
- Added log analysis tools
- Increased API delay from 2s to 3s
- Improved error handling and isolation

### v1.0 (Previous)
- Basic S3 scanning
- Basic Claude AI summarization
- Email reports
- Limited logging
- No recovery mechanism

---

## 📄 License

UNLICENSED - NeurasixAI Internal Use Only

---

**Last Updated**: 2026-01-27  
**Version**: 2.0  
**Node.js**: 14+ required
