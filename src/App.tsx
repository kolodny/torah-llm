// The app shell: a Mantine AppShell with a header that nav-tabs between registered pages. Each page
// renders itself (and reads its own slots). Core registers the "viewer" + "storage" pages; plugins can
// register more (a clobbered page id is rejected by the host). No reader logic lives here anymore.
import { createElement } from 'react';
import { AppShell, Tabs, Group, Title, Button } from '@mantine/core';
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
  return (
    <AppShell header={{ height: 56 }} padding={0}>
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xl" wrap="nowrap" style={{ minWidth: 0 }}>
            <Title order={4} style={{ whiteSpace: 'nowrap' }}>תורה · Torah</Title>
            <Tabs value={active?.id ?? null} onChange={(v) => v && dispatch({ type: 'setPage', id: v })} variant="pills">
              <Tabs.List>
                {pages.map((p) => (
                  <Tabs.Tab key={p.id} value={p.id} leftSection={p.icon}>
                    {p.title}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs>
          </Group>
          <Button variant="subtle" color="gray" size="xs" onClick={() => void wipe().then(() => location.reload())}>
            Wipe local DB
          </Button>
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
