# Troubleshooting Guide - Data Ingestion Summary System

## Problem: Process crashed after 114 files out of 1400

### Root Causes Identified:

1. **Rate Limiting**: Claude API has rate limits
2. **Memory Issues**: Processing too many files without cleanup
3. **No Recovery Mechanism**: Crash = lose all progress
4. **Insufficient Error Handling**: One API error could crash everything

---

## ✅ Solutions Implemented

### 1. Comprehensive Logging System
- **Memory tracking** in every log line shows heap usage
- **Detailed timing** for API calls and S3 downloads
- **Progress indicators** with percentage and ETA
- **Error details** including HTTP status codes and error types

### 2. Progress Persistence
- **Auto-saves every 10 files** to `progress_summaries.json`
- **Resume capability** - if it crashes, just restart and it continues from last checkpoint
- **No data loss** - all processed summaries are saved

### 3. Better Error Handling
- **Individual file errors don't crash the whole process**
- **Retry logic** with exponential backoff for API failures
- **Rate limit handling** - waits longer when hit with 429 errors
- **Graceful degradation** - continues even if some files fail

### 4. Improved Rate Limiting
- **Increased delay to 3 seconds** between API calls (was 2s)
- **Smart retry delays**: 10s, 20s, 30s for rate limit errors
- **Up to 3 retry attempts** per file before giving up

---

## 🚀 How to Use the New System

### Check Current Status
```bash
node resume_summaries.js status
```

This shows:
- How many files were processed before crash
- How many remain
- Estimated time to complete
- Progress bar visualization

### Resume From Crash
```bash
node resume_summaries.js resume
```

This will:
- Pick up exactly where it left off
- Continue processing remaining files
- Keep all previously generated summaries

### Start Fresh (Clean)
```bash
node resume_summaries.js clean
```

This deletes the progress file so you can start over.

### Run Normal Process
```bash
node s3_daily_summary.js
```

This runs the full pipeline. If it crashes, use `resume` command.

---

## 📊 Understanding the New Logs

### Memory Tracking
```
[12:34:56] [INFO] [MEM: 245.67MB] Processing file 115/1400
```
- Watch for memory growing too large (>1GB may be concerning)
- Memory is logged on every line

### Progress Bar
```
[========================================] 8.1%
```
Shows visual progress through the file list.

### Statistics (Every 25 files)
```
📊 Statistics:
   Processed: 125/1400
   API calls: 120, Avg time: 1250ms
   Downloads: 125, Avg time: 450ms
   Skipped: 3, Errors: 2
   Elapsed: 5.2 min
```

Helps you understand:
- How many API calls succeeded
- Average response times
- How many files were skipped/errored
- Total elapsed time

### Detailed File Processing
```
[INFO] [125/1400] Processing: document.pdf
[INFO]   Bucket: my-bucket
[INFO]   Path: taxes/india/supreme-court/document.pdf
[INFO]   Size: 245.67 KB
[INFO]   ETA: 53.2 minutes
[DEBUG]   Downloading: s3://my-bucket/taxes/...
[DEBUG]   S3 response received
[DEBUG]   Downloaded 245678 bytes in 3 chunks (450ms)
[DEBUG]   Calling Claude API for: document.pdf
[DEBUG]     Attempt 1/3 - Sending 10000 chars to Claude
[DEBUG]     Claude API responded in 1250ms
[INFO]   ✓ Summary generated (API: 1250ms, Download: 450ms)
```

Every file shows:
- Where it is in S3
- Download status and time
- API call details
- Success/failure status

### Error Logging
```
[ERROR]   Claude API error (attempt 1/3): Rate limit exceeded
[ERROR]     HTTP Status: 429
[ERROR]     API Error Type: rate_limit_error
[WARN]     Rate limited! Waiting 10s before retry...
```

Errors show:
- What went wrong
- HTTP status codes
- Error types
- Retry attempts

---

## 🔧 Solving Your Current Situation

### Option 1: Resume the Crashed Run (RECOMMENDED)

If you still have the EC2 instance with the progress file:

```bash
# Check how much was completed
node resume_summaries.js status

# Resume from where it crashed
node resume_summaries.js resume
```

This will process the remaining **1286 files** (1400 - 114).

### Option 2: Start Fresh with New Logging

```bash
# Clean any old progress
node resume_summaries.js clean

# Run the full process with new logging
node s3_daily_summary.js
```

The new logging will help identify exactly where it fails if it crashes again.

---

## 🐛 Common Issues & Solutions

### Issue: "Rate limit exceeded" errors
**Solution**: The code now automatically retries with longer delays (10s, 20s, 30s)

### Issue: "Out of memory" crash
**Solution**: 
- Monitor the `[MEM: XXX MB]` in logs
- If memory grows above 1GB, may need to process in smaller batches
- Contact support if this happens

### Issue: Progress file exists but can't resume
**Solution**: 
```bash
node resume_summaries.js clean
node s3_daily_summary.js
```

### Issue: Claude API key not working
**Solution**: Check `.env` file has valid `CLAUDE_API_KEY`

---

## 📈 Performance Expectations

- **Time per file**: ~2.5 seconds average
- **1400 files**: ~58 minutes total
- **Checkpoint frequency**: Every 10 files (~25 seconds)
- **Maximum data loss**: 9 files (if crashes between checkpoints)

---

## 🎯 Key Improvements Summary

| Before | After |
|--------|-------|
| Crashes = lose everything | Auto-saves every 10 files |
| No idea where it failed | Detailed logs show exact failure point |
| 2s delay (too aggressive) | 3s delay + smart retry logic |
| Single retry | 3 retries with exponential backoff |
| No memory tracking | Memory shown in every log |
| No progress visibility | Progress bar + ETA + statistics |
| One error crashes all | Errors isolated per file |

---

## 📞 Need Help?

1. **Check the logs** - they now tell you exactly what's happening
2. **Use resume command** - don't start from scratch unnecessarily
3. **Monitor memory** - watch for growing memory usage
4. **Check progress file** - `reports/progress_summaries.json` has all details

---

## 🔍 Debug Commands

```bash
# See what's in the progress file
cat reports/progress_summaries.json | head -50

# Check recent Excel files
ls -lth reports/*.xlsx | head -5

# Monitor memory during run (Linux/Mac)
watch -n 5 'ps aux | grep node'

# Check EC2 disk space
df -h

# Check Node.js version
node --version
```

---

**Generated**: ${new Date().toISOString()}
**System**: NeurasixAI Data Ingestion Daily Summary v2.0
Use caselaws
