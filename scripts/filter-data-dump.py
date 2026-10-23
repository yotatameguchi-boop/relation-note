#!/usr/bin/env python3
"""復元用に data.sql を整える。
   - 行の無い COPY ブロックを除く（Supabase 管理の空の表には postgres から書き込めないものがある：storage.buckets_vectors など）
   - 復元先に存在しない表の COPY ブロックを除く。ただしその表に行があれば失敗にする（データを黙って落とさない）
   python3 scripts/filter-data-dump.py <data.sql> <復元先にある表の一覧（schema.table を1行ずつ）> > filtered.sql"""
import re, sys

src, tables_file = sys.argv[1], sys.argv[2]
existing = {l.strip() for l in open(tables_file, encoding="utf-8") if l.strip()}
out = sys.stdout
missing, lost = [], []
block, name = None, ""
for line in open(src, encoding="utf-8"):
    m = re.match(r'^COPY "([^"]+)"\."([^"]+)"', line)
    if m and block is None:
        name, block = f"{m.group(1)}.{m.group(2)}", [line]
        continue
    if block is not None:
        block.append(line)
        if line.rstrip("\n") == "\\.":
            rows = len(block) - 2
            if name not in existing:
                missing.append(name)
                if rows:
                    lost.append(f"{name}({rows})")
            elif rows:
                out.writelines(block)
            block = None
        continue
    out.write(line)
print(f"  復元先に無い表: {', '.join(missing) or 'なし'}", file=sys.stderr)
if lost:
    print(f"  データのある表が復元先にありません: {', '.join(lost)}", file=sys.stderr)
    sys.exit(1)
