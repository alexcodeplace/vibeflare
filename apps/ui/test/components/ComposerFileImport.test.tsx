import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerFileImport } from '../../src/components/widgets/ComposerFileImport';

const text = () => new File(['Page-wide drop reaches the composer'], 'brief.txt', { type: 'text/plain' });
const transfer = (file: File) => ({ types: ['Files'], files: [file] });

describe('composer file import', () => {
  it('stays visually quiet until a page-wide file drag is detected, then accepts the global drop', async () => {
    const onFiles = vi.fn();
    render(<ComposerFileImport onFiles={onFiles} accept=".txt" label="Import text" hint="Drop .txt · up to 64 KB" />);

    expect(screen.queryByTestId('composer-drop-overlay')).toBeNull();
    expect(screen.getByTestId('composer-file-trigger')).toHaveAccessibleName('Import text');

    const file = text();
    fireEvent.dragEnter(window, { dataTransfer: transfer(file) });
    expect(screen.getByTestId('composer-drop-overlay')).toBeVisible();

    fireEvent.drop(window, { dataTransfer: transfer(file) });
    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]));
    expect(screen.queryByTestId('composer-drop-overlay')).toBeNull();
  });

  it('uses the plus button as the native picker trigger and validates browse input before delivery', async () => {
    const onFiles = vi.fn();
    const onError = vi.fn();
    render(<ComposerFileImport onFiles={onFiles} onError={onError} accept=".txt" maxBytes={16}
      label="Import text" hint="Drop .txt · up to 16 B" />);

    const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('composer-file-trigger'));
    expect(click).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { files: [new File(['png'], 'bad.png', { type: 'image/png' })] } });
    expect(onFiles).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('not supported'));

    const file = new File(['ok'], 'brief.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]));
  });
});
