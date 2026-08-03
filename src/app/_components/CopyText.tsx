'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * A block of text with a copy button.
 *
 * Unlike `CopyLink`, this is for something that gets pasted into a message
 * rather than opened: the engraving list read down a phone to a trophy shop,
 * where retyping thirteen team names is exactly how one of them ends up wrong
 * on a trophy.
 *
 * The textarea is real and selectable, so it still works when the clipboard API
 * is unavailable — it needs a secure context, and this may well be served over
 * plain HTTP on a laptop at the field.
 */
export function CopyText({ value, label, rows = 8 }: { value: string; label: string; rows?: number }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCanCopy(typeof navigator !== 'undefined' && !!navigator.clipboard);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused; leave it selected so it can be copied by hand.
      areaRef.current?.select();
    }
  };

  return (
    <>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        ref={areaRef}
        readOnly
        rows={rows}
        value={value}
        onFocus={(e) => e.target.select()}
        style={{ minHeight: 'unset' }}
      />
      {canCopy && (
        <button type="button" onClick={copy} className="wide" style={{ marginTop: 8 }}>
          {copied ? 'Copied' : 'Copy it'}
        </button>
      )}
    </>
  );
}
