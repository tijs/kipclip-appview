export function Footer() {
  return (
    <footer className="border-t border-gray-200 mt-12">
      <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
        <nav className="flex items-center gap-4 text-sm text-gray-500">
          <a href="/about" className="hover:text-gray-700 transition">
            About
          </a>
          <span className="text-gray-300" aria-hidden>
            &middot;
          </span>
          <a href="/support" className="hover:text-gray-700 transition">
            Support
          </a>
          <span className="text-gray-300" aria-hidden>
            &middot;
          </span>
          <a href="/privacy" className="hover:text-gray-700 transition">
            Privacy Policy
          </a>
          <span className="text-gray-300" aria-hidden>
            &middot;
          </span>
          <a href="/terms" className="hover:text-gray-700 transition">
            Terms of Use
          </a>
        </nav>
        <span className="text-xs text-gray-400">
          &copy; {new Date().getFullYear()} kipclip
        </span>
      </div>
    </footer>
  );
}
