#!/bin/bash
# 全量重建所有已注册仓库的 lbug 数据库（启用压缩 + 裁剪 Folder/Section）
# 然后重建 group sync

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="$SCRIPT_DIR/dist/cli/index.js"
REGISTRY="$HOME/.gitnexus/registry.json"

# 解析所有仓库路径
REPOS=$(python3 -c "import json; repos=json.load(open('$REGISTRY')); [print(r['path']) for r in repos]")

TOTAL=$(echo "$REPOS" | wc -l | tr -d ' ')
echo "=== 全量重建 lbug 数据库 ==="
echo "=== 共 $TOTAL 个仓库 ==="
echo ""

# 记录原始总大小
BEFORE_SIZE=$(find ~/.gitnexus -name "lbug" -path "*/repos/*" -exec stat -f%z {} + 2>/dev/null | awk '{s+=$1}END{print s}' || echo "0")
BEFORE_SIZE_2=$(echo "$REPOS" | while read p; do stat -f%z "$p/.gitnexus/lbug" 2>/dev/null; done | awk '{s+=$1}END{print s}')
echo "重建前总大小: $(echo "$BEFORE_SIZE_2" | awk '{printf "%.1f GB\n", $1/1024/1024/1024}')"
echo ""

SUCCEEDED=0
FAILED=0
FAIL_LIST=""
START_TIME=$(date +%s)

i=0
echo "$REPOS" | while read REPO_PATH; do
  i=$((i+1))
  REPO_NAME=$(basename "$REPO_PATH")
  
  if [ ! -d "$REPO_PATH" ]; then
    echo "[$i/$TOTAL] SKIP $REPO_NAME (目录不存在)"
    continue
  fi
  
  echo -n "[$i/$TOTAL] $REPO_NAME ... "
  
  if node "$CLI" analyze "$REPO_PATH" --force 2>/dev/null | grep -q "indexed successfully"; then
    SIZE=$(ls -lh "$REPO_PATH/.gitnexus/lbug" 2>/dev/null | awk '{print $5}')
    echo "OK ($SIZE)"
  else
    echo "FAILED"
    echo "$REPO_NAME" >> /tmp/gitnexus-rebuild-failures.txt
  fi
done

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "=== 重建完成 (耗时 ${ELAPSED}s) ==="

# 统计新大小
AFTER_SIZE=$(echo "$REPOS" | while read p; do stat -f%z "$p/.gitnexus/lbug" 2>/dev/null; done | awk '{s+=$1}END{print s}')
echo "重建后总大小: $(echo "$AFTER_SIZE" | awk '{printf "%.1f GB\n", $1/1024/1024/1024}')"

if [ -f /tmp/gitnexus-rebuild-failures.txt ]; then
  echo ""
  echo "失败的仓库:"
  cat /tmp/gitnexus-rebuild-failures.txt
  rm -f /tmp/gitnexus-rebuild-failures.txt
fi

echo ""
echo "=== 重建 group sync ==="
node "$CLI" group sync flight-all 2>&1 | tail -5

echo ""
echo "=== 全部完成 ==="
