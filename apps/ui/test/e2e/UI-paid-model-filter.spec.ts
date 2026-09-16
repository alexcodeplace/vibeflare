import { expect, test } from '@playwright/test';
import {
  addVirtualPasskeyAuthenticator,
  createFirstOwner,
  removeVirtualAuthenticator,
  resetE2EState,
  waitForHydratedIsland,
} from './helpers/webauthn';

const PAID_MODEL = '@cf/deepseek-ai/deepseek-v4-flash-0731';

test('paid models are excluded by default and tagged when explicitly included', async ({ page }, testInfo) => {
  await resetE2EState(page);
  const authenticator = await addVirtualPasskeyAuthenticator(page);
  try {
    await createFirstOwner(page);
    const seed = await page.request.post('/__e2e/seed-model', {
      data: { name: PAID_MODEL, task: 'text-generation', paid_required: true },
    });
    expect(seed.status()).toBe(200);

    const defaultList = await page.request.get('/admin/models?task=text-generation');
    expect(defaultList.status()).toBe(200);
    const defaultBody = await defaultList.json() as {
      exclude_paid: boolean;
      models: Array<{ name: string; paid_required: boolean }>;
    };
    expect(defaultBody.exclude_paid).toBe(true);
    expect(defaultBody.models.some((model) => model.name === PAID_MODEL)).toBe(false);

    await page.goto('/settings');
    await waitForHydratedIsland(page, 'settings-page');
    await page.getByRole('tab', { name: 'Models' }).click();
    const excludePaid = page.getByRole('checkbox', { name: 'Exclude paid' });
    await expect(excludePaid).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('exclude-paid-settings.png') });

    const save = page.waitForResponse((response) =>
      response.url().endsWith('/admin/settings') && response.request().method() === 'PUT');
    await excludePaid.click();
    expect((await save).status()).toBe(200);
    await expect(excludePaid).not.toBeChecked();

    const includedList = await page.request.get('/admin/models?task=text-generation');
    expect(includedList.status()).toBe(200);
    const includedBody = await includedList.json() as {
      exclude_paid: boolean;
      models: Array<{ name: string; paid_required: boolean }>;
    };
    expect(includedBody.exclude_paid).toBe(false);
    expect(includedBody.models).toContainEqual(expect.objectContaining({
      name: PAID_MODEL,
      paid_required: true,
    }));

    await page.goto('/chat');
    await waitForHydratedIsland(page, 'vibeflare-chat');
    await page.getByRole('combobox', { name: /Select a Model/i }).click();
    await expect(page.getByText(`💲 ${PAID_MODEL}`, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('paid-model-dollar-dropdown.png') });
    await page.keyboard.press('Escape');

    // The preference survives a new page load, and turning it back on removes
    // paid choices immediately from already-open chat tabs as well as new loads.
    const chatTab = page;
    const settingsTab = await page.context().newPage();
    await settingsTab.goto('/settings');
    await waitForHydratedIsland(settingsTab, 'settings-page');
    await settingsTab.getByRole('tab', { name: 'Models' }).click();
    const persisted = settingsTab.getByRole('checkbox', { name: 'Exclude paid' });
    await expect(persisted).not.toBeChecked();
    const resaved = settingsTab.waitForResponse(response => response.url().endsWith('/admin/settings') && response.request().method() === 'PUT');
    await persisted.click();
    expect((await resaved).status()).toBe(200);
    await expect(persisted).toBeChecked();
    await chatTab.getByRole('combobox', { name: /Select a Model/i }).click();
    await expect(chatTab.getByText(`💲 ${PAID_MODEL}`, { exact: true })).toHaveCount(0);
    await settingsTab.close();
  } finally {
    await removeVirtualAuthenticator(authenticator);
  }
});
