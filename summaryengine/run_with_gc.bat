@echo off
REM Run Node.js with garbage collection exposed and increased heap size
REM This helps prevent memory issues and silent crashes

echo ========================================
echo Running with Enhanced Node.js Settings
echo ========================================
echo.
echo Settings:
echo   - Expose garbage collection
echo   - Increased heap size to 4GB
echo   - Memory monitoring enabled
echo.

REM Run with --expose-gc to allow manual garbage collection
REM and --max-old-space-size to increase heap limit
node --expose-gc --max-old-space-size=4096 %*

echo.
echo ========================================
echo Process completed with exit code: %ERRORLEVEL%
echo ========================================
