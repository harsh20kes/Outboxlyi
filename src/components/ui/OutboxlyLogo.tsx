export function OutboxlyLogo({
  size = 'md',
  showWordmark = true,
}: {
  size?: 'sm' | 'md';
  showWordmark?: boolean;
}) {
  const iconDim = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
  const textClass =
    size === 'sm'
      ? 'text-sm font-semibold tracking-tight text-[#0F172A] whitespace-nowrap'
      : 'text-base font-semibold tracking-tight text-[#0F172A] whitespace-nowrap';

  return (
    <div className="inline-flex items-center gap-2.5 shrink-0">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${iconDim} shrink-0`}
        aria-hidden="true"
      >
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="6"
          fill="#FFFFFF"
          stroke="#E2E8F0"
          strokeWidth="1.5"
        />
        {/* Precision outbox tray */}
        <path
          d="M7 18.5V23.5C7 24.3284 7.67157 25 8.5 25H23.5C24.3284 25 25 24.3284 25 23.5V18.5"
          stroke="#0F172A"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Staggered queue cadence ticks */}
        <path
          d="M11 21.5H15.5"
          stroke="#94A3B8"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        {/* Outbound folded dispatch plane */}
        <path
          d="M10 15L23.5 8L18 20L15.2 15.8L10 15Z"
          fill="#1D4ED8"
        />
        <path
          d="M23.5 8L15.2 15.8"
          stroke="#FFFFFF"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      {showWordmark && <span className={textClass}>Outboxly</span>}
    </div>
  );
}
