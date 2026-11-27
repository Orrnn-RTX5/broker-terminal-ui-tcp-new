// @vitest-environment jsdom

import '@testing-library/jest-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';

const ThemeProbe = () => <span data-testid="theme">{useTheme().theme}</span>;

const renderTheme = () => render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

const THEME_KEYS = ['rtx5-default-light-theme-v1', 'rtx5-advanced-view-enabled', 'rtx5-theme'];

describe('ThemeProvider starting theme', () => {
  beforeEach(() => {
    THEME_KEYS.forEach((key) => localStorage.removeItem(key));
    document.documentElement.className = '';
  });

  afterEach(() => {
    cleanup();
    THEME_KEYS.forEach((key) => localStorage.removeItem(key));
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('starts in the Light theme when no theme was ever saved', () => {
    renderTheme();

    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement).toHaveClass('theme-light', 'rtx-advanced-view', 'rtx-skin-untitled-light');
    expect(document.documentElement).not.toHaveClass('theme-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('rtx5-theme')).toBe('light');
    expect(localStorage.getItem('rtx5-advanced-view-enabled')).toBe('true');
  });

  it('moves an install that still carries the old dark default to Light', () => {
    localStorage.setItem('rtx5-advanced-view-enabled', 'false');
    localStorage.setItem('rtx5-theme', 'dark');
    renderTheme();

    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement).toHaveClass('theme-light');
  });

  it.each(['dark', 'custom'])('keeps a %s theme chosen after Light became the default', (chosen) => {
    localStorage.setItem('rtx5-default-light-theme-v1', '1');
    localStorage.setItem('rtx5-advanced-view-enabled', 'false');
    localStorage.setItem('rtx5-theme', chosen);
    renderTheme();

    expect(screen.getByTestId('theme')).toHaveTextContent(chosen);
    expect(document.documentElement).toHaveClass(`theme-${chosen}`);
    expect(document.documentElement).not.toHaveClass('theme-light', 'rtx-skin-untitled-light');
    expect(localStorage.getItem('rtx5-theme')).toBe(chosen);
  });
});
