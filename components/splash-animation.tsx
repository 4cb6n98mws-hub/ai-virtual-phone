"use client";

export function SplashAnimation() {
  return (
    <div className="splash-animation-stage" aria-hidden>
      <div className="splash-boot-aura" />
      <div className="splash-boot-lockup">
        <div className="splash-boot-ring">
          <svg className="splash-boot-mark" viewBox="0 0 72 72" fill="none">
            <path d="M24 24 30 16l6 7 6-7 6 8" />
            <rect x="17" y="22" width="38" height="34" rx="12" />
            <circle cx="29" cy="37" r="2" />
            <circle cx="43" cy="37" r="2" />
            <path d="M29 46c2 2 4.3 3 7 3s5-1 7-3" />
          </svg>
        </div>
        <div className="splash-boot-brand">XENO LINK</div>
        <div className="splash-boot-rule"><i /><i /><i /></div>
        <div className="splash-boot-status">PERSONAL SIGNAL · ONLINE</div>
      </div>
      <div className="splash-boot-corner">XL / 01</div>
      <div className="splash-boot-corner splash-boot-corner-right">PRIVATE LINE</div>
    </div>
  );
}
