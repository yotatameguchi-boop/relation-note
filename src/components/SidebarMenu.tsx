"use client";
import { useState } from "react";

/** 画面が狭いとき、サイドバー（上部のバー）をロゴと「メニュー」ボタンだけに畳む。広い画面では常に開いたまま */
export function SidebarMenu({ brand, children }: { brand: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="sidebar-top">
        {brand}
        <button type="button" className="menu-toggle btn-secondary btn-small" aria-expanded={open} aria-controls="sidebar-menu"
          onClick={() => setOpen((v) => !v)}>
          <span aria-hidden="true">{open ? "✕" : "☰"}</span> {open ? "閉じる" : "メニュー"}
        </button>
      </div>
      {/* 項目を選んだら閉じる（ページ移動後も開いたままにならないように） */}
      <div id="sidebar-menu" className={open ? "sidebar-menu open" : "sidebar-menu"}
        onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
        {children}
      </div>
    </>
  );
}
