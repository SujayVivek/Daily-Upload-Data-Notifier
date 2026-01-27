# Quick Reference: Log Analysis

## 🎯 Quick Diagnostic Checklist

### Is the process stuck?
Look for: Recent timestamps in logs
```
[12:34:56] [INFO] [MEM: 245MB] ...  <- Should update every 3-5 seconds
```

### Is memory growing too large?
```
[MEM: 850MB]  <- OK
[MEM: 1200MB] <- WARNING  
[MEM: 1800MB] <- CRITICAL
```

### Are API calls succeeding?
```
✓ Summary generated (API: 1250ms, Download: 450ms)  <- SUCCESS
✗ All 3 attempts failed                              <- FAILURE
```

### How much progress?
```
[========================================] 58.2%
[814/1400] Processing: ...
ETA: 24.5 minutes
```

---

## 🚨 Error Patterns to Watch For

### Rate Limiting (Expected, Handled Automatically)
```
[ERROR] Claude API error (attempt 1/3): Rate limit exceeded
[WARN] Rate limited! Waiting 10s before retry...
```
**Action**: None - code handles this automatically

### Authentication Errors (Requires Fix)
```
[ERROR] HTTP Status: 401
[ERROR] API Error Type: authentication_error
```
**Action**: Check CLAUDE_API_KEY in .env file

### Network Errors (May Resolve on Retry)
```
[ERROR] Failed to download: Connection timeout
[ERROR] AWS Error Code: NetworkingError
```
**Action**: Check internet connection, retries automatically

### Out of Memory (Critical)
```
[MEM: 1800MB]
JavaScript heap out of memory
```
**Action**: Stop process, contact support

---

## 📊 Statistics Interpretation

Every 25 files, you'll see:
```
📊 Statistics:
   Processed: 125/1400         <- Progress
   API calls: 120, Avg time: 1250ms   <- API performance
   Downloads: 125, Avg time: 450ms    <- S3 performance  
   Skipped: 3, Errors: 2      <- Problem count
   Elapsed: 5.2 min           <- Time so far
```

### What's Normal:
- **API avg time**: 800ms - 2000ms is normal
- **Download avg time**: 200ms - 1000ms is normal
- **Skipped**: Usually binary files (PDFs), expected
- **Errors**: Should be < 5% of total

### Red Flags:
- **API avg time**: >5000ms = API issues
- **Errors**: >10% of files = investigate
- **Memory**: Growing steadily = memory leak concern

---

## 🔍 Log Levels Explained

### INFO (Always Shown)
Normal operation, progress updates, important events
```
[INFO] Processing file 125/1400
[INFO] ✓ Summary generated successfully
```

### WARN (Important but Not Fatal)
Issues that were handled, but you should know about
```
[WARN] File too large, truncating
[WARN] Skipped (binary or unreadable)
```

### ERROR (Failed but Continuing)
Something went wrong, but process continues
```
[ERROR] Claude API error (attempt 1/3)
[ERROR] Failed to download file
```

### DEBUG (Verbose Mode Only)
Detailed technical information
```
[DEBUG] Downloaded 245678 bytes in 3 chunks
[DEBUG] Calling Claude API for: document.pdf
```

To enable DEBUG logs:
```bash
node s3_daily_summary.js --verbose
```

---

## ⏱️ Time Estimates

| Files | Estimated Time |
|-------|----------------|
| 100   | ~4 minutes     |
| 500   | ~21 minutes    |
| 1000  | ~42 minutes    |
| 1400  | ~58 minutes    |

*Based on 2.5 seconds per file average*

**Factors that slow down:**
- Large files (download time)
- API rate limiting (retry delays)
- Network latency
- EC2 instance performance

---

## 🎬 Example of a Successful Run

```
[12:00:00] [INFO] [MEM: 125MB] ========================================
[12:00:00] [INFO] [MEM: 125MB] 📄 Starting File Summary Generation
[12:00:00] [INFO] [MEM: 126MB] Processing all 1400 files
[12:00:00] [INFO] [MEM: 126MB] Estimated time: 58.3 minutes

[=========>                               ] 10.0%
[12:05:30] [INFO] [MEM: 145MB] [140/1400] Processing: tax_document.pdf
[12:05:30] [INFO] [MEM: 145MB]   ETA: 52.5 minutes
[12:05:30] [INFO] [MEM: 145MB]   ✓ Summary generated (API: 1100ms, Download: 380ms)

[====================>                    ] 25.0%
[12:10:30] [INFO] [MEM: 178MB] 📊 Statistics:
[12:10:30] [INFO] [MEM: 178MB]    Processed: 350/1400
[12:10:30] [INFO] [MEM: 178MB]    API calls: 345, Avg time: 1150ms
[12:10:30] [INFO] [MEM: 178MB]    Skipped: 5, Errors: 0

[========================================] 100.0%
[12:58:12] [INFO] [MEM: 425MB] ========================================
[12:58:12] [INFO] [MEM: 425MB] 📊 FINAL STATISTICS
[12:58:12] [INFO] [MEM: 425MB] Total files: 1400
[12:58:12] [INFO] [MEM: 425MB] Successfully processed: 1400
[12:58:12] [INFO] [MEM: 425MB] Total time: 58.2 minutes
[12:58:12] [INFO] [MEM: 428MB] ✓ File summaries saved: file_summaries_20260127.xlsx
```

---

## 🎯 Quick Actions Based on Logs

### If You See This → Do This

| Log Message | Action |
|-------------|--------|
| `Rate limited! Waiting...` | ✅ Normal, wait it out |
| `[MEM: >1500MB]` | ⚠️ Monitor closely, may crash |
| `authentication_error` | 🔧 Fix CLAUDE_API_KEY |
| `Progress saved (XXX files)` | ✅ Checkpoint created, safe to resume |
| `All 3 attempts failed` | ⚠️ Individual file failed, process continues |
| `CRITICAL ERROR processing file` | ⚠️ Check the specific error details |

---

## 📦 Output Files

After successful run:

```
reports/
├── s3_daily_uploads_20260127.xlsx      <- Original S3 scan results
├── file_summaries_20260127.xlsx        <- AI-generated summaries
└── progress_summaries.json             <- Progress checkpoint (deleted when done)
```

If crashed:
```
reports/
├── s3_daily_uploads_20260127.xlsx      
└── progress_summaries.json             <- Resume from here!
```

---

## 🆘 Emergency Commands

```bash
# Check if process is running
ps aux | grep node

# Kill hung process
pkill -9 node

# Check progress without running
node resume_summaries.js status

# Resume after crash
node resume_summaries.js resume

# Start completely fresh
node resume_summaries.js clean
node s3_daily_summary.js
```

---

**Last Updated**: 2026-01-27
