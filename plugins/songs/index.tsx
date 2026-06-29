// Songs — adds a "♪ Songs" action to cross-reference links and shows the target in a viewer sidebar.
// (Placeholder data: a real version would query a songs dataset keyed by ref/phrase.)
import { useEffect, useState } from 'react';
import { Text, Anchor } from '@mantine/core';
import type { LinkInfo, PluginContext } from '../../src/plugins/Plugin.type';
const { definePlugin } = window.__torahRuntime.sdk;

let target: LinkInfo['to'] | null = null;
const subs = new Set<() => void>();
function setTarget(t: LinkInfo['to']) {
  target = t;
  subs.forEach((f) => f());
}
function useTarget() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return target;
}

function SongsPanel({ ctx }: { ctx: PluginContext }) {
  const t = useTarget();
  if (!t) return <Text c="dimmed" size="sm" p="md">Click “♪ Songs” on a cross-reference to find musical settings of that text.</Text>;
  return (
    <div className="plugin-songs" style={{ padding: 12 }}>
      <Text size="sm" mb="xs">
        Songs for{' '}
        <Anchor onClick={() => ctx.ui.peek(t.book, t.ref)}>
          {t.book} <span className="comm-ref">{t.ref}</span>
        </Anchor>
      </Text>
      <Text c="dimmed" size="sm">No song dataset wired yet — this shows the link → plugin flow. A real songs source would list recordings/settings here.</Text>
    </div>
  );
}

export default definePlugin({
  manifest: { id: 'songs', name: 'Songs', version: '3.0.0', apiVersion: '^1', permissions: [], activationEvents: ['onBook:*'], description: 'Find musical settings of a linked passage.' },
  activate(ctx) {
    ctx.viewer.addSidebar({ id: 'songs', title: 'Songs', render: () => <SongsPanel ctx={ctx} /> });
    ctx.viewer.addLinkAction({
      id: 'songs.view',
      label: '♪ Songs',
      run: (link: LinkInfo) => {
        setTarget(link.to);
        ctx.ui.showToast(`Songs for ${link.to.book} ${link.to.ref} — open the Songs panel`);
      },
    });
  },
});
