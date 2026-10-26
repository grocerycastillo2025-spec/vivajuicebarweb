import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DISMISS_DAYS,
  dismissedRecently,
  installMode,
  isInAppBrowser,
  platformOf,
  wantsInstall,
} from '../domain/install.ts';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const INSTAGRAM =
  'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 Instagram 350.0.0';
const WHATSAPP_IOS = `${IPHONE} WhatsApp/24.20`;
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

describe('instalar la app', () => {
  it('plataforma', () => {
    assert.equal(platformOf(IPHONE), 'ios');
    assert.equal(platformOf(IPAD_DESKTOP, 5), 'ios');
    assert.equal(platformOf(IPAD_DESKTOP, 0), 'other');
    assert.equal(platformOf(ANDROID_CHROME), 'android');
    assert.equal(platformOf(DESKTOP), 'other');
  });

  it('navegadores dentro de otras apps', () => {
    assert.equal(isInAppBrowser(INSTAGRAM), true);
    assert.equal(isInAppBrowser(WHATSAPP_IOS), true);
    assert.equal(isInAppBrowser(ANDROID_CHROME), false);
    assert.equal(isInAppBrowser(IPHONE), false);
  });

  it('modo', () => {
    const base = { standalone: false, hasPrompt: false };
    assert.equal(installMode({ ...base, userAgent: ANDROID_CHROME, standalone: true }), 'installed');
    assert.equal(installMode({ ...base, userAgent: ANDROID_CHROME, hasPrompt: true }), 'prompt');
    assert.equal(installMode({ ...base, userAgent: DESKTOP, hasPrompt: true }), 'prompt');
    assert.equal(installMode({ ...base, userAgent: IPHONE }), 'ios');
    assert.equal(installMode({ ...base, userAgent: WHATSAPP_IOS }), 'in_app');
    assert.equal(installMode({ ...base, userAgent: INSTAGRAM }), 'in_app');
    assert.equal(installMode({ ...base, userAgent: ANDROID_CHROME }), 'android_manual');
    assert.equal(installMode({ ...base, userAgent: DESKTOP }), 'none');
  });

  it('"ahora no" dura unos días', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    assert.equal(dismissedRecently(null, now), false);
    assert.equal(dismissedRecently(now - 1000, now), true);
    assert.equal(dismissedRecently(now - (DISMISS_DAYS + 1) * 86_400_000, now), false);
    assert.equal(dismissedRecently(Number.NaN, now), false);
  });

  it('la liga del QR pide instalar', () => {
    assert.equal(wantsInstall('?instalar=1'), true);
    assert.equal(wantsInstall('?a=2&instalar'), true);
    assert.equal(wantsInstall('?instalarx=1'), false);
    assert.equal(wantsInstall(''), false);
  });
});
