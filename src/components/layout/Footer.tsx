import { MoveDial } from "../ui/MoveDial"
import "./Footer.css"

export function Footer() {
  return (
    <footer className="footer" data-testid="footer">
      <div className="footer-left">
        <MoveDial className="footer-move-dial" testId="quota-meter" />
      </div>
      <a
        href="https://github.com/samwillis/one-million-boxes"
        target="_blank"
        rel="noopener noreferrer"
        className="footer-link"
        aria-label="Learn how we built this with Neon Realtime"
      >
        <span className="footer-link-desktop">
          Learn how we built this{` `}
          <span className="footer-link-extra">with Neon Realtime</span>
        </span>
        <span className="footer-link-mobile">How we built it</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>
    </footer>
  )
}
