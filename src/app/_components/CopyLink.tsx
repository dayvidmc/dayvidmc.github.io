'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A link with a copy button.
 *
 * Team links get forwarded by text or WhatsApp, usually while standing at HQ
 * talking to the coach. Selecting a long token by hand on a phone is the kind
 * of small friction that ends with someone reading it out loud instead.
 *
 * Falls back to a plain selectable field when the clipboard API is unavailable
 * — it needs a secure context, and this may well be served over plain HTTP on
 * a laptop at the Tokessy site.
 */
export function CopyLink({ path, label }: { path: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCanCopy(typeof navigator !== 'undefined' && !!navigator.clipboard);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const absolute = typeof window === 'undefined' ? path : new URL(path, window.location.origin).href;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused; leave the field selected so it can be copied by hand.
      inputRef.current?.select();
    }
  };

  return (
    <>
      {label && <label>{label}</label>}
      <div className="copyable">
        <input ref={inputRef} readOnly value={path} onFocus={(e) => e.target.select()} />
        {canCopy && (
          <button type="button" onClick={copy} style={{ flex: '0 0 auto', minHeight: 44, padding: '8px 14px' }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        <a
          className="btn"
          href={path}
          target="_blank"
          rel="noreferrer"
          style={{ flex: '0 0 auto', minHeight: 44, padding: '8px 14px' }}
        >
          Open
        </a>
      </div>
    </>
  );
}
