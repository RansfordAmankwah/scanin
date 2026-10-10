import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { mockApi, reply } from './helpers/net';

vi.mock('qr-scanner', () => ({
  default: class {
    start() {
      return Promise.resolve();
    }
    stop() {}
    destroy() {}
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the product name and asks a signed-out visitor to sign in', async () => {
    mockApi({ 'GET /auth/me': reply(401, {}) });
    render(<App pathname="/" />);
    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
    await waitFor(() => screen.getByRole('form', { name: /sign in/i }));
    expect(screen.getByRole('heading', { name: 'ScanIn', level: 1 })).toBeTruthy();
  });
});
