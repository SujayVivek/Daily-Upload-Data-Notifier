#!/bin/bash
# Run Node.js with garbage collection exposed and increased heap size
# This helps prevent memory issues and silent crashes

echo "========================================"
echo "Running with Enhanced Node.js Settings"
echo "========================================"
echo ""
echo "Settings:"
echo "  - Expose garbage collection"
echo "  - Increased heap size to 4GB"
echo "  - Memory monitoring enabled"
echo ""

# Run with --expose-gc to allow manual garbage collection
# and --max-old-space-size to increase heap limit
node --expose-gc --max-old-space-size=4096 "$@"

EXIT_CODE=$?

echo ""
echo "========================================"
echo "Process completed with exit code: $EXIT_CODE"
echo "========================================"

exit $EXIT_CODE
