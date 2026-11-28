/**
 * Chart Template Store with Zustand + Persist
 * Manages chart configuration templates with automatic persistence
 * Similar to MT5 chart templates functionality
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { ChartType, Timeframe } from '../types/chart';
import {
  defaultChartProperties,
  type ChartGridLineStyle,
  type ChartGridType,
} from './useChartSettingsStore';

// Template interface matching chart configuration
export interface ChartTemplate {
  id: string;
  name: string;
  chartType: ChartType;
  timeframe: Timeframe;
  showGrid: boolean;
  gridType?: ChartGridType;
  gridLineStyle?: ChartGridLineStyle;
  showVolumes: boolean;
  indicators: Array<{
    id: string;
    name: string;
    type: string;
    parameters: Record<string, unknown>;
    visible: boolean;
  }>;
  drawingTools: Array<{
    id: string;
    type: string;
    data: unknown;
  }>;
  colors: {
    background: string;
    grid: string;
    candle: {
      up: string;
      down: string;
      border: string;
    };
    volume: {
      up: string;
      down: string;
    };
  };
  createdAt: number;
  isDefault?: boolean;
}

interface TemplateState {
  templates: ChartTemplate[];

  // Actions
  saveTemplate: (template: Omit<ChartTemplate, 'id' | 'createdAt'>) => ChartTemplate;
  loadTemplate: (id: string) => ChartTemplate | null;
  deleteTemplate: (id: string) => void;
  updateTemplate: (id: string, updates: Partial<ChartTemplate>) => void;
  listTemplates: () => ChartTemplate[];
  getTemplateById: (id: string) => ChartTemplate | null;
  resetToDefaults: () => void;
}

const DEFAULT_TEMPLATE_IDS = new Set(['default']);
const REMOVED_BUILTIN_TEMPLATE_IDS = new Set(['clean-chart', 'technical-analysis']);

export const DEFAULT_TEMPLATE_COLORS: ChartTemplate['colors'] = {
  background: defaultChartProperties.colors.background,
  grid: '#2b2b2b',
  candle: {
    up: defaultChartProperties.colors.bullCandle,
    down: defaultChartProperties.colors.bearCandle,
    border: defaultChartProperties.colors.barUp,
  },
  volume: {
    up: defaultChartProperties.colors.bullCandle,
    down: defaultChartProperties.colors.bearCandle,
  },
};

// Built-in default templates (MT5-inspired)
const defaultTemplates: ChartTemplate[] = [
  {
    id: 'default',
    name: 'Default',
    chartType: 'candlestick',
    timeframe: 'M1',
    showGrid: true,
    showVolumes: false,
    indicators: [],
    drawingTools: [],
    colors: DEFAULT_TEMPLATE_COLORS,
    createdAt: Date.now(),
    isDefault: true,
  },
];

export const useTemplateStore = create<TemplateState>()(
  devtools(
    persist(
      (set, get) => ({
        templates: defaultTemplates,

        saveTemplate: (template) => {
          const newTemplate: ChartTemplate = {
            ...template,
            id: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            createdAt: Date.now(),
            isDefault: false,
          };

          set((state) => ({
            templates: [...state.templates, newTemplate],
          }));

          return newTemplate;
        },

        loadTemplate: (id) => {
          const state = get();
          return state.templates.find((t) => t.id === id) || null;
        },

        deleteTemplate: (id) => {
          set((state) => {
            // Prevent deletion of default templates
            const template = state.templates.find((t) => t.id === id);
            if (template?.isDefault) {
              console.warn('Cannot delete default templates');
              return state;
            }

            return {
              templates: state.templates.filter((t) => t.id !== id),
            };
          });
        },

        updateTemplate: (id, updates) => {
          set((state) => {
            // Prevent updating default templates
            const template = state.templates.find((t) => t.id === id);
            if (template?.isDefault) {
              console.warn('Cannot update default templates');
              return state;
            }

            return {
              templates: state.templates.map((t) =>
                t.id === id ? { ...t, ...updates } : t
              ),
            };
          });
        },

        listTemplates: () => {
          return get().templates;
        },

        getTemplateById: (id) => {
          return get().templates.find((t) => t.id === id) || null;
        },

        resetToDefaults: () => {
          set({ templates: defaultTemplates });
        },
      }),
      {
        name: 'rtx5-chart-templates',
        // Persist all templates
        partialize: (state) => ({
          templates: state.templates,
        }),
        merge: (persisted, current) => {
          const persistedState = persisted as Partial<TemplateState> | undefined;
          const templates = Array.isArray(persistedState?.templates)
            ? persistedState.templates
                .filter((template) => !(template?.isDefault && REMOVED_BUILTIN_TEMPLATE_IDS.has(template.id)))
                .map((template) => (
                  template?.isDefault && DEFAULT_TEMPLATE_IDS.has(template.id)
                    ? { ...template, showVolumes: false, colors: DEFAULT_TEMPLATE_COLORS }
                    : template
                ))
            : current.templates;
          return {
            ...current,
            ...persistedState,
            templates,
          };
        },
      }
    )
  )
);

// Selectors
export const useTemplates = () => useTemplateStore((state) => state.templates);
export const useDefaultTemplates = () =>
  useTemplateStore((state) => state.templates.filter((t) => t.isDefault));
export const useCustomTemplates = () =>
  useTemplateStore((state) => state.templates.filter((t) => !t.isDefault));
