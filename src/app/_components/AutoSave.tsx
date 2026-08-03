'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * Fields that save themselves.
 *
 * The people using this are volunteers on phones, often one-handed, often
 * interrupted. A form that loses what you typed because you got called over to
 * a diamond is a form that stops being used. So editable settings save on blur
 * and shortly after you stop typing, and say so.
 *
 * Three rules this follows, all of them earned from how the weekend actually
 * goes:
 *
 *   1. **Never claim to have saved something that failed.** A silent failure
 *      here is worse than no auto-save at all, because it teaches people to
 *      trust something untrustworthy. Failures stay on screen with a Retry.
 *   2. **Never auto-save an act of judgment.** Approving a score, publishing a
 *      bracket, issuing a refund — those stay behind a deliberate button.
 *      Auto-save is for settings and contact details, not decisions.
 *   3. **Work without JavaScript.** Every auto-saving editor is also a plain
 *      form with a real Save button. If the script never loads on a bad
 *      connection at Deevy Pines, the page still works the old way.
 */

export type SaveResult = { ok: true } | { ok: false; error: string };

/** A server action bound to one record: `(field, value) => result`. */
export type FieldSaver = (field: string, value: string) => Promise<SaveResult>;

type Status = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 800;
const SAVED_VISIBLE_MS = 2200;

function useFieldSave(save: FieldSaver, field: string, initial: string) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  // What is actually on the server, so we never re-save an unchanged value.
  const persisted = useRef(initial);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback(
    async (value: string) => {
      if (value === persisted.current) {
        setStatus('idle');
        return;
      }

      setStatus('saving');
      setError(null);

      try {
        const result = await save(field, value);
        if (result.ok) {
          persisted.current = value;
          pending.current = null;
          setStatus('saved');
          if (savedTimer.current) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(() => {
            setStatus((s) => (s === 'saved' ? 'idle' : s));
          }, SAVED_VISIBLE_MS);
        } else {
          setStatus('error');
          setError(result.error);
        }
      } catch {
        setStatus('error');
        setError('Lost connection.');
      }
    },
    [save, field],
  );

  const onChange = useCallback(
    (value: string) => {
      pending.current = value;
      setStatus('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void commit(value), DEBOUNCE_MS);
    },
    [commit],
  );

  /** Blur saves immediately — waiting out a debounce after you've moved on is just latency. */
  const onBlur = useCallback(
    (value: string) => {
      if (timer.current) clearTimeout(timer.current);
      void commit(value);
    },
    [commit],
  );

  const retry = useCallback(() => {
    if (pending.current !== null) void commit(pending.current);
  }, [commit]);

  // Don't let someone walk away from an edit that hasn't landed.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (status === 'dirty' || status === 'saving' || status === 'error') event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  return { status, error, onChange, onBlur, retry };
}

function StatusChip({ status, error, retry }: { status: Status; error: string | null; retry: () => void }) {
  if (status === 'idle') return null;

  if (status === 'error') {
    return (
      <span className="save-chip error">
        {error ?? "Didn't save"}{' '}
        <button type="button" className="link-button" onClick={retry}>
          Retry
        </button>
      </span>
    );
  }

  const label = status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : 'Unsaved';
  return <span className={`save-chip ${status}`}>{label}</span>;
}

interface FieldProps {
  save: FieldSaver;
  field: string;
  label: string;
  defaultValue: string;
  hint?: string;
  type?: 'text' | 'number' | 'tel' | 'email' | 'time' | 'date';
  min?: number;
  max?: number;
  placeholder?: string;
  /** Shown after the input, e.g. "minutes". */
  suffix?: string;
  /**
   * Keep the label for a screen reader but take it off the screen. For a list
   * of identical rows — a roster, say — repeating "Name" fourteen times is
   * noise that pushes the actual names off a phone.
   */
  labelHidden?: boolean;
}

export function AutoSaveField({
  save,
  field,
  label,
  defaultValue,
  hint,
  type = 'text',
  min,
  max,
  placeholder,
  suffix,
  labelHidden,
}: FieldProps) {
  const id = useId();
  const { status, error, onChange, onBlur, retry } = useFieldSave(save, field, defaultValue);

  return (
    <div className="field">
      {/* The status chip normally lives in the label. When the label is hidden
          it has to come out and stand on its own — it is the only thing telling
          somebody their typing was kept, and hiding that would be worse than
          having no auto-save at all. */}
      <label htmlFor={id} className={labelHidden ? 'sr-only' : undefined}>
        {label}
        {!labelHidden && <StatusChip status={status} error={error} retry={retry} />}
      </label>
      {labelHidden && (
        <div className="chip-row">
          <StatusChip status={status} error={error} retry={retry} />
        </div>
      )}
      <div className="field-input">
        <input
          id={id}
          name={field}
          type={type}
          defaultValue={defaultValue}
          min={min}
          max={max}
          placeholder={placeholder}
          inputMode={type === 'number' ? 'numeric' : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

interface SelectProps {
  save: FieldSaver;
  field: string;
  label: string;
  defaultValue: string;
  options: { value: string; label: string }[];
  hint?: string;
}

export function AutoSaveSelect({ save, field, label, defaultValue, options, hint }: SelectProps) {
  const id = useId();
  const { status, error, onChange, onBlur, retry } = useFieldSave(save, field, defaultValue);

  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        <StatusChip status={status} error={error} retry={retry} />
      </label>
      <select
        id={id}
        name={field}
        defaultValue={defaultValue}
        // A select has no typing to debounce, so save the moment it changes.
        onChange={(e) => onBlur(e.target.value)}
        onBlur={(e) => onBlur(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

interface ToggleProps {
  save: FieldSaver;
  field: string;
  label: string;
  defaultChecked: boolean;
  hint?: string;
}

export function AutoSaveToggle({ save, field, label, defaultChecked, hint }: ToggleProps) {
  const id = useId();
  const { status, error, onBlur, retry } = useFieldSave(save, field, defaultChecked ? 'true' : 'false');

  return (
    <div className="field">
      <label htmlFor={id} className="toggle">
        <input
          id={id}
          name={field}
          type="checkbox"
          defaultChecked={defaultChecked}
          value="true"
          onChange={(e) => onBlur(e.target.checked ? 'true' : 'false')}
        />
        <span>{label}</span>
        <StatusChip status={status} error={error} retry={retry} />
      </label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
