import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from '../primitives/Icon';
import { fileMatchesAccept } from '../../lib/file-input';

export interface ComposerFileImportProps {
  onFiles: (files: File[]) => void | Promise<void>;
  onError?: (message: string) => void;
  accept?: string;
  maxBytes?: number;
  disabled?: boolean;
  label: string;
  hint: string;
}

function isFileDrag(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Composer-specific file affordance.
 *
 * File drags are detected across the whole page, while the visible drop target is
 * intentionally confined to the composer editing area. Idle state stays minimal:
 * one small + button opens the native file picker.
 */
export function ComposerFileImport({
  onFiles,
  onError,
  accept,
  maxBytes = 25 * 1024 * 1024,
  disabled = false,
  label,
  hint,
}: ComposerFileImportProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const inFlight = useRef(false);

  async function choose(files: File[]) {
    if (disabled || inFlight.current) return;
    if (files.length !== 1) { onError?.('Choose one file at a time.'); return; }
    const file = files[0]!;
    if (!fileMatchesAccept(file, accept)) { onError?.(`This file type is not supported here. ${hint}`); return; }
    if (!file.size) { onError?.('This file is empty. Choose a file with content.'); return; }
    if (file.size > maxBytes) { onError?.(`This file is too large. ${hint}`); return; }
    inFlight.current = true;
    try {
      await onFiles([file]);
    } catch (cause) {
      onError?.(cause instanceof Error ? cause.message : 'The file could not be read. Try again.');
    } finally {
      inFlight.current = false;
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  useEffect(() => {
    function enter(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      if (!disabled) setDragging(true);
    }
    function over(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    }
    function leave(event: DragEvent) {
      if (!isFileDrag(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    }
    function drop(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!disabled) void choose(Array.from(event.dataTransfer?.files ?? []));
    }
    function reset() {
      dragDepth.current = 0;
      setDragging(false);
    }

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', reset);
    };
  }, [accept, disabled, hint, maxBytes, onError, onFiles]);

  function picked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length) void choose(files);
  }

  return <>
    <input ref={inputRef} type="file" className="sr-only" tabIndex={-1}
      data-testid="composer-file-input" aria-label={label} accept={accept} disabled={disabled}
      onChange={picked} />
    <button type="button" className="vf-composer-file-trigger" data-testid="composer-file-trigger"
      aria-label={label} title={`${label}. ${hint}`} disabled={disabled}
      onClick={() => inputRef.current?.click()}>
      <Icon name="Plus" size="sm" />
    </button>
    {dragging && <div className="vf-composer-drop-overlay" data-testid="composer-drop-overlay" aria-hidden="true">
      <div className="vf-composer-drop-copy">
        <Icon name="Upload" size="md" />
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
    </div>}
  </>;
}
