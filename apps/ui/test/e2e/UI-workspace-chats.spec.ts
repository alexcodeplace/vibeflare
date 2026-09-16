import { expect, test } from '@playwright/test';
import { resetE2EState, waitForHydratedIsland } from './helpers/webauthn';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Workspace lists conversations immediately and preserves our menus at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await resetE2EState(page);
    expect((await page.request.post('/__e2e/session', { data: { role: 'owner' } })).ok()).toBe(true);
    const title = 'My saved Workspace conversation';
    let release!: () => void;
    const inferenceGate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/v1/chat/completions*', async route => {
      await inferenceGate;
      await route.continue();
    });
    await page.goto('/chat');
    await waitForHydratedIsland(page, 'vibeflare-chat');
    const input = page.getByLabel('Message input');
    await expect(input).toHaveAttribute('contenteditable', 'true');
    await input.fill(title);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page).toHaveURL(/chat_id=/);
    const id = new URL(page.url()).searchParams.get('chat_id')!;
    if (viewport.width < 1024) await page.getByRole('button', { name: 'Toggle menu' }).click();
    const sidebar = page.locator('#sidebar');
    const chatLink = sidebar.getByRole('link', { name: title, exact: true });
    // This passes while inference is deliberately paused, not just after a reply.
    await expect(chatLink).toBeVisible();
    await expect(chatLink).toHaveAttribute('aria-current', 'page');
    const disclosure = sidebar.getByTestId('workspace-chats').locator('summary');
    await disclosure.focus();
    await page.keyboard.press('Space');
    await expect(chatLink).not.toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Workspace', exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(chatLink).toBeVisible();
    for (const menu of ['Workspace', 'History', 'Projects', 'Data', 'API Keys', 'Settings']) {
      await expect(sidebar.getByRole('link', { name: menu, exact: true })).toBeVisible();
    }
    await page.screenshot({ path: `test-results/workspace-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    release();
    if (viewport.width < 1024) await page.keyboard.press('Escape');
    await expect(page.getByText('Hello from VibeFlare E2E', { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const r = await page.request.get(`/admin/chats/${encodeURIComponent(id)}/messages`);
      return (await r.json()).messages.length;
    }).toBe(2);
    await page.goto('/settings');
    await waitForHydratedIsland(page, 'settings-page');
    if (viewport.width < 1024) await page.getByRole('button', { name: 'Toggle menu' }).click();
    await expect(chatLink).toBeVisible();
    await chatLink.click();
    await expect(page.getByText('Hello from VibeFlare E2E', { exact: true })).toBeVisible();
    await expect(page.locator('#sidebar').getByRole('link', { name: title, exact: true, includeHidden: true })).toHaveCount(1);
    if (viewport.width < 1024) await page.getByRole('button', { name: 'Toggle menu' }).click();
    await page.locator('#sidebar').getByRole('link', { name: '+ New chat', exact: true }).click();
    await expect(page).not.toHaveURL(/chat_id=/);
    await expect(page.getByText('What do you want to make?', { exact: true })).toBeVisible();
    if (viewport.width < 1024) await page.getByRole('button', { name: 'Toggle menu' }).click();
    await expect(page.locator('#sidebar').getByRole('link', { name: title, exact: true })).toBeVisible();
    // Loading the same app as a different member must never leak the owner's list.
    await page.context().clearCookies();
    expect((await page.request.post('/__e2e/session', { data: { role: 'user' } })).ok()).toBe(true);
    await page.goto('/chat');
    await waitForHydratedIsland(page, 'vibeflare-chat');
    await expect(page.locator('#sidebar').getByRole('link', { name: title, exact: true, includeHidden: true })).toHaveCount(0);
  });
}
