export function Brand({ className = '' }: { className?: string }) {
  return (
    <a href="/" className={`brand ${className}`} aria-label="Deskfish home">
      <img src="/assets/logo.svg" alt="" width="36" height="36" />
      <span>
        deskfish<span className="brand-period">.</span>
      </span>
    </a>
  );
}
