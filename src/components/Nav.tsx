"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; exact?: boolean; badge?: string; badgeLabel?: string };

export function Nav({ sections }: { sections: { title?: string; items: Item[] }[] }) {
  const path = usePathname();
  return (
    <nav>
      {sections.map((s, i) => (
        <div key={i}>
          {s.title && <div className="section">{s.title}</div>}
          {s.items.map((it) => {
            const active = it.exact ? path === it.href : path === it.href || path.startsWith(it.href + "/");
            return (
              <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined}>
                {it.label}
                {it.badge && <span className="nav-count" aria-label={it.badgeLabel}>{it.badge}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
