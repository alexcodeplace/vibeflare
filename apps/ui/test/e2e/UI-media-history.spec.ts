import { expect, test, type Page } from '@playwright/test';
import { resetE2EState, waitForHydratedIsland } from './helpers/webauthn';

const mediaModels = [
  ['@cf/test/e2e-image', 'text-to-image'],
  ['@cf/test/e2e-embedding', 'text-embeddings'],
  ['@cf/test/e2e-audio', 'automatic-speech-recognition'],
];
async function setup(page: Page) {
  await resetE2EState(page);
  expect((await page.request.post('/__e2e/session', { data: { role: 'owner' } })).ok()).toBe(true);
  for (const [name, task] of mediaModels) expect((await page.request.post('/__e2e/seed-model', { data: { name, task, paid_required: false } })).ok()).toBe(true);
  await page.goto('/chat');
  await waitForHydratedIsland(page, 'vibeflare-chat');
}
async function sidebar(page: Page) {
  if (page.viewportSize()!.width < 1024) await page.getByRole('button', { name: 'Toggle menu' }).click();
  return page.locator('#sidebar');
}
async function history(page: Page, id: string) {
  const response = await page.request.get(`/admin/chats/${id}/messages`); expect(response.ok()).toBe(true);
  return response.json();
}
async function checkSaved(page: Page, id: string, title: string, task: string) {
  await page.goto('/history');
  await expect(page.getByTestId('history-page').getByText(title, { exact: true })).toBeVisible();
  const menu = await sidebar(page);
  await menu.getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`chat_id=${id}`));
  await expect(page.getByRole('tab', { name: task, exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: task, exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const width of [1440, 390]) {
  test(`Image conversations appear before completion and restore stored images at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('tab', { name: 'Image', exact: true }).click();
    await expect(page.getByRole('combobox')).toContainText('@cf/test/e2e-image');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    await page.route('**/v1/images/generations*', async route => { requests++; await gate; await route.continue(); });
    const title = 'A sunset saved to image history';
    await page.getByLabel('Message input').fill(title);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page).toHaveURL(/chat_id=/);
    await expect(page.getByTestId('chat-conversation')).toBeVisible();
    await expect(page.getByTestId('task-workspace')).toHaveCount(0);
    const pendingPrompt = page.getByTestId('chat-conversation').getByText(title, { exact: true });
    await expect(pendingPrompt).toBeVisible();
    await expect(page.getByTestId('chat-conversation').getByLabel('Message from assistant').getByText('Creating image…', { exact: true })).toBeVisible();
    const pendingBox = await pendingPrompt.boundingBox();
    const pendingComposerBox = await page.getByLabel('Message input').boundingBox();
    expect(pendingBox).not.toBeNull(); expect(pendingComposerBox).not.toBeNull();
    expect(pendingBox!.y + pendingBox!.height).toBeLessThan(pendingComposerBox!.y);
    const id = new URL(page.url()).searchParams.get('chat_id')!;
    await expect.poll(async () => (await (await page.request.get('/admin/chats')).json()).chats.some((chat: { id: string }) => chat.id === id)).toBe(true);
    const menu = await sidebar(page);
    await expect(menu.getByRole('link', { name: title, exact: true })).toBeVisible();
    expect((await history(page, id)).messages).toHaveLength(0);
    release();
    if (width < 1024) await page.keyboard.press('Escape');
    const stored = page.getByTestId('saved-media-result').locator('img');
    await expect(stored).toHaveCount(1);
    await expect.poll(() => stored.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.getByTestId('chat-conversation')).toBeVisible();
    await expect(page.getByTestId('task-workspace')).toHaveCount(0);
    const imageBox = await stored.boundingBox();
    const imageComposerBox = await page.getByLabel('Message input').boundingBox();
    expect(imageBox).not.toBeNull(); expect(imageComposerBox).not.toBeNull();
    expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(imageComposerBox!.y);
    expect((await history(page, id)).messages).toHaveLength(2);
    await checkSaved(page, id, title, 'Image');
    await expect(page.getByTestId('chat-conversation')).toBeVisible();
    await expect(page.getByTestId('task-workspace')).toHaveCount(0);
    await expect(stored).toHaveCount(1);
    await expect.poll(() => stored.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(requests).toBe(1);
    // A follow-up image stays in the same conversation, rather than losing the first result.
    await page.getByLabel('Message input').fill('Add a moon above the same sunset');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(stored).toHaveCount(2);
    expect(new URL(page.url()).searchParams.get('chat_id')).toBe(id);
    expect((await history(page, id)).messages).toHaveLength(4);
    await page.screenshot({ path: testInfo.outputPath(`image-history-${width}.png`), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]);
  });

  test(`Embeddings use the embedding endpoint and reopen downloadable vectors at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    let textRequests = 0, vectorRequests = 0;
    page.on('request', request => {
      if (request.url().includes('/v1/chat/completions')) textRequests++;
      if (request.url().includes('/v1/embeddings')) vectorRequests++;
    });
    await page.getByRole('tab', { name: 'Embeddings', exact: true }).click();
    await expect(page.getByRole('combobox')).toContainText('@cf/test/e2e-embedding');
    const title = 'An embedding that survives reload';
    await page.getByLabel('Message input').fill(title);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const download = page.getByRole('link', { name: 'Download full embeddings (JSON)' });
    await expect(download).toBeVisible();
    const id = new URL(page.url()).searchParams.get('chat_id')!;
    const result = await (await page.request.get((await download.getAttribute('href'))!)).json();
    expect(result.data[0].embedding).toEqual([0.125, -0.25, 0.5, 0.75]);
    await checkSaved(page, id, title, 'Embeddings');
    await expect(download).toBeVisible();
    expect((await history(page, id)).messages).toHaveLength(2);
    expect(textRequests).toBe(0); expect(vectorRequests).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`embedding-history-${width}.png`), fullPage: true, animations: 'disabled' });
  });

  test(`Audio transcripts and source files reopen from history at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    await page.getByRole('tab', { name: 'Audio', exact: true }).click();
    await expect(page.getByRole('combobox')).toContainText('@cf/test/e2e-audio');
    const wav = Buffer.alloc(46); wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
    await page.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'meeting.wav', mimeType: 'audio/wav', buffer: wav });
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    const transcript = page.getByText('A transcript saved in conversation history.', { exact: true });
    await expect(transcript).toBeVisible();
    await expect(page.getByTestId('chat-conversation')).toBeVisible();
    await expect(page.getByTestId('task-workspace')).toHaveCount(0);
    const transcriptBox = await transcript.boundingBox();
    const audioComposerBox = await page.getByTestId('chat-conversation').locator('.vf-audio-composer').boundingBox();
    expect(transcriptBox).not.toBeNull(); expect(audioComposerBox).not.toBeNull();
    expect(transcriptBox!.y + transcriptBox!.height).toBeLessThan(audioComposerBox!.y);
    const id = new URL(page.url()).searchParams.get('chat_id')!;
    await checkSaved(page, id, 'Transcribe meeting.wav', 'Audio');
    await expect(page.getByTestId('chat-conversation')).toBeVisible();
    await expect(page.getByTestId('task-workspace')).toHaveCount(0);
    await expect(page.getByText('A transcript saved in conversation history.', { exact: true })).toBeVisible();
    const player = page.locator('audio'); await expect(player).toHaveCount(1);
    const bytes = await (await page.request.get((await player.getAttribute('src'))!)).body(); expect(bytes).toEqual(wav);
    expect((await history(page, id)).messages).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath(`audio-history-${width}.png`), fullPage: true, animations: 'disabled' });
    // Switching accounts cannot expose the saved transcript or file.
    await page.context().clearCookies();
    expect((await page.request.post('/__e2e/session', { data: { role: 'user' } })).ok()).toBe(true);
    expect((await page.request.get(`/admin/chats/${id}/messages`)).status()).toBe(404);
    expect((await page.request.get((await player.getAttribute('src'))!)).status()).toBe(404);
  });
}

test('Failed image generation leaves a retryable draft, not a duplicate or fake result', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: 'Image', exact: true }).click();
  await expect(page.getByRole('combobox')).toContainText('@cf/test/e2e-image');
  await page.route('**/v1/images/generations*', route => route.fulfill({ status: 503, json: { error: { message: 'Temporarily unavailable. Try again.' } } }));
  await page.getByLabel('Message input').fill('Retry this image once');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Temporarily unavailable. Try again.', { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get('chat_id')!;
  expect((await history(page, id)).messages).toHaveLength(0);
  await page.unroute('**/v1/images/generations*');
  await expect(page.getByLabel('Message input')).toContainText('Retry this image once');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('saved-media-result').locator('img')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('chat_id')).toBe(id);
  expect((await (await page.request.get('/admin/chats')).json()).chats).toHaveLength(1);
  expect((await history(page, id)).messages).toHaveLength(2);
});
