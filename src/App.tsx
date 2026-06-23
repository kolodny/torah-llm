// The app shell: a Mantine AppShell with a header that nav-tabs between registered pages. Each page
// renders itself (and reads its own slots). Core registers the "viewer" + "storage" pages; plugins can
// register more (a clobbered page id is rejected by the host). No reader logic lives here anymore.
import { createElement } from 'react';
import { AppShell, Tabs, Group, Title, Button, Burger, Box, Menu, ActionIcon } from '@mantine/core';
import { useWorkbench } from './workbench/store';
import { PluginProvider, usePages, coreContext } from './plugins/host';
import type { PageDef } from './plugins/types';
import { wipe } from './db/client';
import ViewerPage from './pages/ViewerPage';
import StoragePage from './pages/StoragePage';
import './app.css';

// Register the core pages once (owner "core"). Plugins registering these ids would be rejected.
coreContext.registerPage({ id: 'viewer', title: 'Viewer', icon: '📖', order: 0, render: ViewerPage });
coreContext.registerPage({ id: 'storage', title: 'Storage', icon: '⤓', order: 90, render: StoragePage });

function PageHost({ page }: { page: PageDef }) {
  return createElement(page.render); // render the page as a component (its own hooks); keyed by id below
}

function Toast() {
  const { toast } = useWorkbench();
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      {toast}
    </div>
  );
}

function Shell() {
  const { state, dispatch } = useWorkbench();
  const pages = usePages();
  const active = pages.find((p) => p.id === state.page) ?? pages[0] ?? null;
  const wipeDb = () => {
    if (!window.confirm('Delete all downloaded books and local data? This cannot be undone.')) return;
    void wipe()
      .then(() => location.reload())
      .catch((e) => dispatch({ type: 'toast', message: `Wipe failed: ${e instanceof Error ? e.message : String(e)}` }));
  };
  return (
    <AppShell header={{ height: 56 }} padding={0}>
      <AppShell.Header>
        <Group h="100%" px="sm" gap="xs" wrap="nowrap">
          {active?.id === 'viewer' && (
            <Burger opened={state.navOpen} onClick={() => dispatch({ type: 'toggleNav' })} hiddenFrom="sm" size="sm" aria-label="Toggle catalog" />
          )}
          <Title order={4} style={{ whiteSpace: 'nowrap' }}>
            תורה<Box component="span" visibleFrom="xs"> · Torah</Box>
          </Title>
          {/* Tabs scroll horizontally if they ever overflow; labels collapse to icons on mobile. */}
          <Box style={{ flex: 1, minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
            <Tabs value={active?.id ?? null} onChange={(v) => v && dispatch({ type: 'setPage', id: v })} variant="pills">
              <Tabs.List style={{ flexWrap: 'nowrap' }}>
                {pages.map((p) => (
                  <Tabs.Tab key={p.id} value={p.id} leftSection={<span style={{ fontSize: 15 }}>{p.icon}</span>}>
                    <Box component="span" visibleFrom="sm">{p.title}</Box>
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs>
          </Box>
          <Button variant="subtle" color="gray" size="xs" visibleFrom="sm" onClick={wipeDb}>
            Wipe local DB
          </Button>
          <Menu position="bottom-end" withinPortal shadow="md">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" hiddenFrom="sm" aria-label="More actions">⋯</ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item color="red" onClick={wipeDb}>Wipe local DB</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>
      <AppShell.Main>{active && <PageHost key={active.id} page={active} />}</AppShell.Main>
    </AppShell>
  );
}

export default function App() {
  return (
    <PluginProvider>
      <Shell />
      <Toast />
    </PluginProvider>
  );
}
