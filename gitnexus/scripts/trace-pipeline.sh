#!/bin/bash
# =============================================================================
# trace-pipeline.sh
# 端到端链路追踪可视化 Pipeline:
#   1. 调用 gitnexus group trace 拉取链路 JSON
#   2. 调用 trace-to-html.ts 转化为交互式树状 HTML
#   3. 自动打开浏览器
#
# Usage:
#   ./scripts/trace-pipeline.sh --target <symbol> --repo <repoPath> [options]
#
# Examples:
#   # 追踪 orderCheck 下游链路（默认 group=flight-all）
#   ./scripts/trace-pipeline.sh --target orderCheck --repo api/booking
#
#   # 追踪 secondCheck 上游链路，跨仓深度 8
#   ./scripts/trace-pipeline.sh --target secondCheck --repo booking/service --direction upstream --max-cross-depth 8
#
#   # 指定 group 和输出目录
#   ./scripts/trace-pipeline.sh --target orderCheck --repo api/booking --group flight-all --outdir ./traces
#
# =============================================================================
set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
GROUP="flight-all"
TARGET=""
REPO=""
DIRECTION="downstream"
MAX_DEPTH="0"
MAX_CROSS_DEPTH="10"
OUTDIR=""
NO_OPEN=false
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Parse Args ──────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") --target <symbol> --repo <repoPath> [options]

Required:
  --target <symbol>       入口符号名 (e.g. orderCheck, secondCheck)
  --repo <repoPath>       group.yaml 中的 repo 路径 (e.g. api/booking, booking/service)

Options:
  --group <name>          Group 名称 (default: flight-all)
  --direction <dir>       downstream | upstream (default: downstream)
  --max-depth <n>         仓库内 BFS 最大深度 (default: 5)
  --max-cross-depth <n>   跨仓最大跳数 (default: 5)
  --outdir <path>         输出目录 (default: ./traces)
  --no-open               不自动打开浏览器
  -h, --help              显示帮助
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --target) TARGET="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    --direction) DIRECTION="$2"; shift 2 ;;
    --max-depth) MAX_DEPTH="$2"; shift 2 ;;
    --max-cross-depth) MAX_CROSS_DEPTH="$2"; shift 2 ;;
    --outdir) OUTDIR="$2"; shift 2 ;;
    --no-open) NO_OPEN=true; shift ;;
    -h|--help) usage ;;
    *) echo "❌ Unknown option: $1"; usage ;;
  esac
done

if [[ -z "$TARGET" || -z "$REPO" ]]; then
  echo "❌ --target and --repo are required"
  echo ""
  usage
fi

# ─── Setup Output ────────────────────────────────────────────────────────────
if [[ -z "$OUTDIR" ]]; then
  OUTDIR="$SCRIPT_DIR/../traces"
fi
mkdir -p "$OUTDIR"

# 生成文件名: trace-{target}-{direction}-{timestamp}
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SAFE_TARGET=$(echo "$TARGET" | tr '/' '-' | tr '.' '-')
BASENAME="trace-${SAFE_TARGET}-${DIRECTION}-${TIMESTAMP}"
JSON_FILE="$OUTDIR/${BASENAME}.json"
HTML_FILE="$OUTDIR/${BASENAME}.html"

# ─── Step 1: Run gitnexus trace ──────────────────────────────────────────────
echo "🔍 [1/3] Running gitnexus trace..."
echo "       Group: $GROUP"
echo "       Target: $TARGET"
echo "       Repo: $REPO"
echo "       Direction: $DIRECTION"
echo "       Max depth: $MAX_DEPTH, Cross depth: $MAX_CROSS_DEPTH"
echo ""

gitnexus group trace "$GROUP" \
  --target "$TARGET" \
  --repo "$REPO" \
  --direction "$DIRECTION" \
  --max-depth "$MAX_DEPTH" \
  --max-cross-depth "$MAX_CROSS_DEPTH" \
  --json > "$JSON_FILE"

# 验证输出
if [[ ! -s "$JSON_FILE" ]]; then
  echo "❌ Trace output is empty. Check gitnexus configuration."
  exit 1
fi

SEGMENTS=$(python3 -c "import json;d=json.load(open('$JSON_FILE'));print(len(d.get('segments',[])))" 2>/dev/null || echo "?")
echo "   ✅ Trace complete: $JSON_FILE ($SEGMENTS segments)"
echo ""

# ─── Step 2: Convert to HTML ─────────────────────────────────────────────────
echo "🎨 [2/3] Generating interactive HTML..."

npx tsx "$SCRIPT_DIR/trace-to-html.ts" "$JSON_FILE" "$HTML_FILE"
echo ""

# ─── Step 3: Open in browser ─────────────────────────────────────────────────
if [[ "$NO_OPEN" == false ]]; then
  echo "🌐 [3/3] Opening in browser..."
  open "$HTML_FILE"
else
  echo "📄 [3/3] Skipped browser open (--no-open)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📊 JSON: $JSON_FILE"
echo "  🌳 HTML: $HTML_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
