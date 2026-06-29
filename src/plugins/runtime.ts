// Installs window.__torahRuntime — the host's single React / Mantine / react-router + plugin SDK that every
// external plugin IIFE binds to (the plugin build externalizes those specifiers to this global). Call once at
// startup, before loadExternalPlugins(). The SHAPE is the contract in Plugin.type.ts (TorahRuntime).
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as Mantine from '@mantine/core';
import * as ReactRouter from 'react-router';
import { registerExternalPlugin, useSlot, usePages, useDecorationsTick } from './host';
import { definePlugin } from './types';
import { BookCheckTree } from '../components/BookTree';
import { stripHtml } from '../../shared/strip';
import type { TorahRuntime, TorahSdk } from './Plugin.type';

export function installPluginRuntime(): void {
  const sdk: TorahSdk = {
    definePlugin,
    registerPlugin: registerExternalPlugin,
    components: { BookCheckTree: BookCheckTree as TorahSdk['components']['BookCheckTree'] },
    util: { stripHtml },
    hooks: { useSlot, usePages, useDecorationsTick },
  };
  const runtime: TorahRuntime = {
    react: React,
    jsxRuntime,
    mantine: Mantine,
    reactRouter: ReactRouter,
    sdk,
  };
  window.__torahRuntime = runtime;
}
