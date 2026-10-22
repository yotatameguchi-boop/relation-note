"use client";
import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** 並べ替えを選んだ時点で、URL を更新して画面を切り替える（ブラウザの戻るで元の順に戻れる） */
export function SortSelect({ options, value, defaultKey = "recent" }: { options: { v: string; l: string }[]; value: string; defaultKey?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  function change(v: string) {
    const u = new URLSearchParams(params.toString());
    if (v === defaultKey) u.delete("sort"); else u.set("sort", v);
    u.delete("page"); // 並べ替えたら1ページ目から
    u.delete("ok");
    u.delete("error");
    const s = u.toString();
    start(() => router.push(`${pathname}${s ? `?${s}` : ""}`));
  }

  return (
    <>
      <select id="sort" name="sort" value={value} onChange={(e) => change(e.target.value)} disabled={pending} aria-busy={pending}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
      {pending && <span className="small muted" role="status">並べ替えています…</span>}
    </>
  );
}
