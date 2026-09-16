import { expect, test, type Page } from '@playwright/test';
import { applyAuth } from './ui-matrix/matrix-auth';

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const clipped = await page.locator('.vf-composer-wrap').evaluateAll(elements => elements.some(el => {
    const rect = el.getBoundingClientRect();
    return rect.left < -1 || rect.right > innerWidth + 1;
  }));
  expect(clipped).toBe(false);
}

for (const theme of ['dark', 'light'] as const) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const route of ['/login', '/chat'] as const) {
      test(`Spargax ${route} ${theme} ${viewport.width}: canonical assets and responsive layout`, async ({ page, context, baseURL }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(mode => localStorage.setItem('vf-theme', mode), theme);
        await applyAuth(context, route === '/chat' ? 'owner' : 'anonymous', baseURL!, route);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const failedAssets: string[] = [];
        page.on('response', response => { if (/\/(assets|_astro)\//.test(response.url()) && response.status() >= 400) failedAssets.push(response.url()); });
        await page.goto(route);
        await expect(page.getByTestId(route === '/chat' ? 'vibeflare-chat' : 'login-page')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const background = await page.locator(route === '/chat' ? '.vf-workspace' : '.vf-auth-shell').evaluate(el => getComputedStyle(el).backgroundImage);
        expect(background).toContain(`/assets/club/${theme}-${route === '/chat' ? 'dashboard' : 'auth'}-background.webp`);
        const visibleArt = page.locator(`img[data-art-theme="${theme}"]:visible`);
        if (route === '/chat' || viewport.width > 700) {
          expect(await visibleArt.count()).toBeGreaterThan(0);
          await expect.poll(() => visibleArt.evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
        }
        if (route === '/login') {
          const action = page.getByRole('button', { name: 'Sign in with passkey', exact: true });
          await expect(action).toHaveCSS('background-image', /linear-gradient/);
          await expect(action).toHaveCSS('color', 'rgb(255, 255, 255)');
        }
        if (route === '/chat') {
          // Inspect painted output, not only a root token: the composer has its own surface.
          const composerBackground = await page.getByLabel('Message input').evaluate(editor => {
            for (let node: Element | null = editor; node; node = node.parentElement) {
              const background = getComputedStyle(node).backgroundColor;
              if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background;
            }
            return null;
          });
          expect(composerBackground).toBe(theme === 'dark' ? 'rgb(12, 33, 60)' : 'rgb(248, 251, 255)');
        }
        await assertNoOverflow(page);
        expect(errors).toEqual([]);
        expect(failedAssets).toEqual([]);
        await page.screenshot({ path: `test-results/brand-${route.slice(1)}-${theme}-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
      });
    }
  }
}

test('starter buttons populate and focus the editor without sending inference', async ({ page, context, baseURL }) => {
  await applyAuth(context, 'owner', baseURL!, '/chat');
  const inference: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) inference.push(request.url()); });
  await page.goto('/chat');
  await page.getByRole('button', { name: /Think it through/ }).click();
  const editor = page.getByLabel('Message input');
  await expect(editor).toContainText('Help me think through an idea.');
  await expect(editor).toBeFocused();
  expect(inference).toEqual([]);
  await expect(page.getByText('What do you want to make?')).toBeVisible();
});

test('mobile navigation traps focus, closes with Escape, and survives repeated Astro navigation', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await applyAuth(context, 'owner', baseURL!, '/chat');
  await page.goto('/chat');
  for (const destination of ['History', 'Settings', 'Workspace']) {
    await page.getByRole('button', { name: 'Toggle menu' }).click();
    await expect(page.locator('#sidebar')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('.vf-workspace-main')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Toggle menu' })).toBeFocused();
    await expect(page.locator('.vf-workspace-main')).not.toHaveAttribute('inert', '');
    await page.getByRole('button', { name: 'Toggle menu' }).click();
    await page.locator('.vf-navigation').getByRole('link', { name: destination, exact: true }).click();
    await expect(page.locator('.vf-navigation [aria-current="page"]')).toHaveText(destination);
    await expect(page.locator('#sidebar')).not.toHaveClass(/sidebar--open/);
  }
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  const sidebar = page.locator('#sidebar');
  const links = sidebar.locator('a[href], button:not([disabled])');
  await links.last().focus();
  await page.keyboard.press('Tab');
  await expect(links.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(links.last()).toBeFocused();
});

test('Hebrew, Latin and digits render using the three requested font families', async ({ page, context, baseURL }) => {
  await applyAuth(context, 'owner', baseURL!, '/chat');
  await page.goto('/chat');
  await expect(page.getByTestId('vibeflare-chat')).toBeVisible();
  await page.evaluate(async () => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;inset:0 auto auto 0;opacity:0;pointer-events:none';
    probe.innerHTML = '<span id="font-en">Spargax</span><span id="font-he" lang="he" dir="rtl">שלום</span><span id="font-numerals">1234567890</span>';
    document.querySelector('.vf-chat-content')!.append(probe);
    await Promise.all([
      document.fonts.load('400 16px Poppins', 'Spargax'),
      document.fonts.load('400 16px "Noto Sans Hebrew"', 'שלום'),
      document.fonts.load('400 16px "Spargax Numerals"', '1234567890'),
    ]);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  for (const [id, family] of [['font-en', 'Poppins'], ['font-he', 'Noto Sans Hebrew'], ['font-numerals', 'Outfit']]) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    expect(fonts.some(font => (font.familyName === family || font.familyName.startsWith(family + ' ')) && font.isCustomFont && font.glyphCount > 0), `${id}: ${JSON.stringify(fonts)}`).toBe(true);
  }
  await expect(page.getByLabel('Message input')).toHaveCSS('font-family', /Poppins/);
  const island = page.locator('[data-testid="vibeflare-chat"]').locator('xpath=ancestor::*[@data-astryx-theme][1]');
  await expect(island).toHaveCSS('--color-background-surface', '#0b203d');
  await cdp.detach();
});

test('reduced motion disables decorative hover and keeps controls usable when storage is blocked', async ({ page, context, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
  });
  await applyAuth(context, 'owner', baseURL!, '/chat');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const starter = page.getByRole('button', { name: /Build something/ });
  await starter.hover();
  expect(await starter.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  await starter.click();
  await expect(page.getByLabel('Message input')).toBeFocused();
  expect(errors).toEqual([]);
});


test('GitHub OAuth action keeps its handoff and receives the brand treatment', async ({ page, context, baseURL }) => {
  await applyAuth(context, 'anonymous', baseURL!, '/login');
  await page.route('**/auth/methods', route => route.fulfill({ json: {
    passkey: false, github: true, github_flow: 'oauth', cf_access: false, setup_required: false,
  } }));
  // Exercise the real UI handoff without signing in to a third-party service.
  await page.route('**/auth/github/oauth/start?purpose=login', route => route.fulfill({
    contentType: 'text/html', body: '<p>OAuth handoff received</p>',
  }));
  await page.goto('/login');
  const action = page.getByRole('button', { name: 'Sign in with GitHub', exact: true });
  await expect(action).toHaveCSS('background-image', /linear-gradient/);
  await expect(action).toHaveCSS('color', 'rgb(255, 255, 255)');
  await action.click();
  await expect(page).toHaveURL(/\/auth\/github\/oauth\/start\?purpose=login$/);
});
