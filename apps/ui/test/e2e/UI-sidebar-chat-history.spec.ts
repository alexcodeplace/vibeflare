import { expect, test, type Page } from '@playwright/test';
import { resetE2EState, waitForHydratedIsland } from './helpers/webauthn';

async function owner(page: Page) {
  await resetE2EState(page);
  expect((await page.request.post('/__e2e/session', { data: { role: 'owner' } })).ok()).toBe(true);
}

async function seedChat(page: Page, id: string, title: string, model = '@cf/meta/e2e-chat') {
  expect((await page.request.post(`/v1/chat/completions?chat_id=${id}`, {
    headers: { 'x-vf-browser': '1' },
    data: { model, stream: false, messages: [{ role: 'user', content: title }] },
  })).status()).toBe(200);
}

test('sidebar history sits under Workspace, reopens the correct chat, and remembers collapse', async ({ page }, testInfo) => {
  await owner(page);
  const otherModel = '@cf/test/second-model';
  expect((await page.request.post('/__e2e/seed-model', { data: { name: otherModel, task: 'text-generation', paid_required: false } })).ok()).toBe(true);
  await seedChat(page, 'sidebar-first', 'First sidebar conversation');
  await seedChat(page, 'sidebar-second', 'Second sidebar conversation', otherModel);
  await page.goto('/chat');
  const sidebar = page.getByTestId('workspace-chats');
  await waitForHydratedIsland(page, 'workspace-chats');
  await expect(sidebar.getByRole('link', { name: 'Second sidebar conversation' })).toBeVisible();
  await expect(sidebar.getByRole('list', { name: 'Recent chats' }).getByRole('link').first()).toHaveText('Second sidebar conversation');
  await page.screenshot({ path: testInfo.outputPath('workspace-history-expanded.png') });
  for (const label of ['Workspace', 'History', 'Projects', 'Data', 'API Keys', 'Settings']) {
    await expect(page.locator('#sidebar').getByRole('link', { name: label, exact: true })).toHaveCount(1);
  }
  expect(await sidebar.evaluate((element) => {
    const workspace = document.querySelector('#sidebar a[href="/chat"]')!;
    const history = document.querySelector('#sidebar nav > div > a[href="/history"]')!;
    return !!(workspace.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !!(element.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);

  // Two links on the same pathname must not retain the persisted previous thread.
  for (const [id, title, model] of [
    ['sidebar-first', 'First sidebar conversation', '@cf/meta/e2e-chat'],
    ['sidebar-second', 'Second sidebar conversation', otherModel],
  ] as const) {
    await sidebar.getByRole('link', { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`chat_id=${id}`));
    await expect(page.getByTestId('vibeflare-chat').getByText(title, { exact: true })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: title })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('combobox', { name: /Select a Model/i })).toContainText(model);
  }

  await sidebar.getByRole('link', { name: 'New chat', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/?$/);
  await expect(page.getByText('What do you want to make?')).toBeVisible();
  const collapse = sidebar.getByRole('button', { name: 'Chat history', exact: true });
  await collapse.click();
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: testInfo.outputPath('workspace-history-collapsed.png') });
  await expect(sidebar.getByRole('list', { name: 'Recent chats' })).toBeHidden();
  await page.reload();
  await waitForHydratedIsland(page, 'workspace-chats');
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await collapse.click();
  await expect(sidebar.getByRole('link', { name: 'First sidebar conversation' })).toBeVisible();

  // Renaming and deleting in the existing History page update the shared sidebar query.
  await page.locator('#sidebar').getByRole('link', { name: 'History', exact: true }).click();
  await waitForHydratedIsland(page, 'history-page');
  await page.getByTestId('history-page').getByText('First sidebar conversation', { exact: true }).click();
  const rename = page.getByTestId('history-page').getByRole('textbox');
  await rename.fill('Renamed sidebar conversation');
  await rename.press('Enter');
  await expect(sidebar.getByRole('link', { name: 'Renamed sidebar conversation' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Renamed sidebar conversation', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(sidebar.getByRole('link', { name: 'Renamed sidebar conversation' })).toHaveCount(0);

  // The sidebar never receives another user's conversations.
  await page.context().clearCookies();
  expect((await page.request.post('/__e2e/session', { data: { role: 'user' } })).ok()).toBe(true);
  await page.goto('/chat');
  await expect(sidebar.getByText('No chats yet.')).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Second sidebar conversation' })).toHaveCount(0);
});

test('a completed prompt updates sidebar history without a page reload', async ({ page }) => {
  await owner(page);
  await page.goto('/chat');
  const sidebar = page.getByTestId('workspace-chats');
  await expect(sidebar.getByText('No chats yet.')).toBeVisible();
  await waitForHydratedIsland(page, 'vibeflare-chat');
  await page.getByLabel('Message input').fill('Show my new conversation in the sidebar');
  await page.getByLabel('Message input').press('Enter');
  await expect(page.getByTestId('vibeflare-chat').getByText('Hello from VibeFlare E2E')).toBeVisible();
  const link = sidebar.getByRole('link', { name: 'Show my new conversation in the sidebar', exact: true });
  await expect(link).toBeVisible({ timeout: 10_000 });
  await expect(link).toHaveAttribute('aria-current', 'page');
});

test('mobile sidebar keeps menu links usable with a scrollable, collapsible history', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await owner(page);
  await seedChat(page, 'mobile-history', 'A mobile conversation');
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  const sidebar = page.getByTestId('workspace-chats');
  await expect(sidebar.getByRole('link', { name: 'A mobile conversation' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Chat history' }).click();
  await expect(sidebar.getByRole('link', { name: 'A mobile conversation' })).toBeHidden();
  await page.locator('#sidebar').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Chat history' })).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).toBeHidden();
});
