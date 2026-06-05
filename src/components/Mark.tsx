/** A viewfinder/reticle mark — the tool "targets" a transaction and inspects it. */
export function Mark({
  size = 26,
  className = "text-accent",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 26 26"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M3 8.5V5.5A2.5 2.5 0 0 1 5.5 3H8.5M17.5 3h3A2.5 2.5 0 0 1 23 5.5v3M23 17.5v3a2.5 2.5 0 0 1-2.5 2.5h-3M8.5 23h-3A2.5 2.5 0 0 1 3 20.5v-3"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <circle cx="13" cy="13" r="3.4" stroke="currentColor" strokeWidth={1.6} />
      <circle cx="13" cy="13" r="1" fill="currentColor" />
    </svg>
  );
}
