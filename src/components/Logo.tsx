/**
 * RelationNote のロゴ。
 * 「R」と「N」を線で描いたシンプルなマーク。N の斜線（青緑）は人と人のつながり、
 * 右上の折り返しはノート（記録）を表す。
 */
export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <clipPath id="rn-clip"><rect width="40" height="40" rx="9" /></clipPath>
      </defs>
      <g clipPath="url(#rn-clip)">
        <rect width="40" height="40" fill="#0f2f5c" />
        <path d="M31 0H40V9Z" fill="#14b3a7" />
        <path d="M31 0V9H40Z" fill="#0b2649" opacity=".55" />
      </g>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.2">
        <path d="M8.5 30V11H15a5 5 0 0 1 0 10H8.5M14.5 21L19.5 30" stroke="#ffffff" />
        <path d="M23 30V11M32 30V16" stroke="#ffffff" />
        <path d="M23 11L32 30" stroke="#14b3a7" />
      </g>
    </svg>
  );
}

export function Logo({ size = 32, sub = true, wordSize = 17 }: { size?: number; sub?: boolean; wordSize?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word" style={{ fontSize: wordSize }}>
        <span className="rel">Relation</span><span className="note">Note</span>
        {sub && <span className="logo-sub">リレーションノート</span>}
      </span>
    </span>
  );
}
